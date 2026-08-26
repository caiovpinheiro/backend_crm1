/**
 * Envio outbound reutilizável (nota interna, texto WhatsApp e template Meta),
 * desacoplado de `Request`/`NextResponse`.
 *
 * Motivo: até 03/ago/26 a única forma de enviar template era o handler
 * `POST /api/conversations/:id/template`, que só aceitava sessão NextAuth.
 * Integrações (node do n8n) precisavam do mesmo comportamento por Bearer e
 * a partir de um `dealId`, não de um `conversationId`. Duplicar o handler
 * criaria duas verdades sobre "o que acontece ao enviar" (SSE, reabertura de
 * ticket, cancelamento de agendamento, activity log). Então a lógica vive
 * aqui e ambas as rotas são cascas finas.
 *
 * Retorno em vez de exceção: `{ ok: false, status, message }` permite que a
 * rota traduza para HTTP sem que o service conheça Next.js — e mantém o
 * service testável fora do runtime de rota.
 */

import type { NextResponse } from "next/server";

import { requireChannelScope } from "@/lib/authz/resource-policy";
import { getContactWhatsAppTargets } from "@/lib/contact-whatsapp-target";
import { analyzeTemplateComponents } from "@/lib/meta-whatsapp/analyze-template-components";
import {
  renderTemplatePreview,
  type TemplateVariableInput,
} from "@/lib/meta-whatsapp/build-template-components";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { enrichTemplateComponentsForFlowSend } from "@/lib/meta-whatsapp/enrich-template-flow";
import { resolveOutboundChannel } from "@/lib/outbound-channel";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { isBaileysChannel, sendWhatsAppText } from "@/lib/send-whatsapp";
import { sseBus } from "@/lib/sse-bus";
import { buildOutboundTemplateMessageContent } from "@/lib/whatsapp-outbound-template-label";
import { formatHumanActorDisplayName } from "@/lib/human-actor-name";
import { logEvent } from "@/services/activity-log";
import { cancelActiveContextsForContact } from "@/services/automation-context";
import { createConversationEvent } from "@/services/conversation-events";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
import { getConversationLite, reopenResolvedAsNewTicket } from "@/services/conversations";
import { cancelPendingForConversation } from "@/services/scheduled-messages";

export type OutboundActor = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  organizationId: string | null;
  isSuperAdmin?: boolean;
};

export type OutboundMessageDto = {
  id: string;
  content: string;
  createdAt: string;
  direction: "out";
  messageType: string;
  isPrivate?: boolean;
  senderName: string;
  externalId?: string | null;
};

export type OutboundFailure = { ok: false; status: number; message: string };

export type OutboundSuccess = {
  ok: true;
  message: OutboundMessageDto;
  conversationId: string;
  /** Preenchido quando a conversa estava encerrada e virou um ticket novo. */
  reopenedConversationId?: string;
  /** Erro reportado pela Meta sem impedir a persistência da mensagem. */
  metaError?: string;
};

export type OutboundResult = OutboundSuccess | OutboundFailure;

function actorName(actor: OutboundActor): string {
  return actor.name?.trim() || actor.email?.trim() || "Agente";
}

/**
 * Converte o `NextResponse` de negação das policies em `OutboundFailure`.
 * As policies são compartilhadas com as rotas e já retornam HTTP, então
 * lemos o corpo em vez de reimplementar as regras de autorização aqui.
 */
async function denialToFailure(denied: NextResponse): Promise<OutboundFailure> {
  let message = "Acesso negado.";
  try {
    const body = (await denied.json()) as { message?: unknown };
    if (typeof body?.message === "string" && body.message.trim()) {
      message = body.message;
    }
  } catch {
    // resposta sem corpo JSON: mantém a mensagem padrão
  }
  return { ok: false, status: denied.status, message };
}

type ConversationLite = NonNullable<Awaited<ReturnType<typeof getConversationLite>>>;

/**
 * Regra "reabrir = novo id": responder em conversa RESOLVED cria um ticket
 * novo. Notas internas não reabrem — são anotações do ticket encerrado.
 */
async function reopenIfResolved(
  conv: ConversationLite,
): Promise<{ conv: ConversationLite; reopenedConversationId: string | null }> {
  if (conv.status !== "RESOLVED" || !conv.contactId) {
    return { conv, reopenedConversationId: null };
  }
  const reopened = await reopenResolvedAsNewTicket(conv.id);
  if (reopened.id === conv.id) return { conv, reopenedConversationId: null };
  const fresh = await getConversationLite(reopened.id);
  if (!fresh) return { conv, reopenedConversationId: null };
  if (reopened.created) {
    void logEvent({
      type: "CONVERSATION_CREATED",
      entityType: "CONVERSATION",
      entityId: fresh.id,
      entityLabel: null,
      conversationId: fresh.id,
      contactId: fresh.contactId,
      meta: {
        channel: fresh.channel,
        source: "outbound_reopen",
        previousConversationId: conv.id,
        openedWithoutMessage: true,
      },
    });
  }
  return { conv: fresh, reopenedConversationId: fresh.id };
}

/**
 * Bloqueia envios sobre canal WhatsApp com status != CONNECTED.
 *
 * Motivo: até 10/ago/26 as rotas de envio confiavam apenas em
 * `metaClientFromConfig` (accessToken + phoneNumberId presentes) — mas a Meta
 * pode invalidar o token do lado dela (canal DISCONNECTED). Quando isso
 * acontece a chamada fica pendurada até o proxy do EasyPanel derrubar em 502
 * (HTML sem JSON) e o operador vê "Servidor temporariamente indisponível".
 *
 * `resolveOutboundChannel` já bloqueava overrides desconectados; este helper
 * cobre o **caminho padrão** (usar o canal da própria conversa).
 *
 * Retorna `null` quando pode enviar; `OutboundFailure` (409) com mensagem
 * clara caso contrário. Igual a `denialToFailure`, o service não conhece
 * NextResponse — a rota traduz para HTTP.
 */
function ensureChannelConnected(
  channelRef: { name?: string | null; status?: string | null; type?: string | null } | null | undefined,
): OutboundFailure | null {
  if (!channelRef) return null; // sem canal configurado: caminho localOnly/env fallback já tratado
  if (channelRef.type && channelRef.type !== "WHATSAPP") return null;
  if (!channelRef.status || channelRef.status === "CONNECTED") return null;
  const label = channelRef.name?.trim() || "atual";
  return {
    ok: false,
    status: 409,
    message: `Canal "${label}" está desconectado. Reconecte em Configurações → Canais ou envie por outro canal WhatsApp da organização.`,
  };
}

function publishNewMessage(
  conv: Pick<ConversationLite, "id" | "organizationId" | "contactId">,
  content: string,
  timestamp: Date,
): void {
  try {
    sseBus.publish("new_message", {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      contactId: conv.contactId,
      direction: "out",
      content,
      timestamp,
    });
  } catch {
    // best-effort: nunca derruba o envio por falha de SSE
  }
}

// ── Nota interna ─────────────────────────────

/**
 * Cria nota interna na conversa (`messageType=note`, `isPrivate=true`) e
 * espelha em `Note`, para aparecer tanto na timeline do /inbox quanto na aba
 * "Notas" do deal em /pipeline. Não toca no canal — nada é enviado ao cliente.
 */
export async function createInternalNoteOnConversation(args: {
  conversationId: string;
  actor: OutboundActor;
  content: string;
  /** Vincula a nota a um deal específico; sem isso resolvemos o deal aberto. */
  dealId?: string | null;
}): Promise<OutboundResult> {
  const content = args.content.trim();
  if (!content) return { ok: false, status: 400, message: "Mensagem vazia." };

  const conv = await getConversationLite(args.conversationId);
  if (!conv) return { ok: false, status: 404, message: "Conversa não encontrada." };

  const senderName = actorName(args.actor);
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      content,
      direction: "out",
      messageType: "note",
      isPrivate: true,
      senderName,
    }),
  });

  void (async () => {
    const dealId =
      args.dealId ??
      (conv.contactId
        ? (
            await prisma.deal
              .findFirst({
                where: { contactId: conv.contactId, status: "OPEN" },
                select: { id: true },
                orderBy: { updatedAt: "desc" },
              })
              .catch(() => null)
          )?.id ?? null
        : null);

    if (conv.contactId || dealId) {
      await prisma.note
        .create({
          data: withOrgFromCtx({
            content,
            contactId: conv.contactId ?? undefined,
            dealId: dealId ?? undefined,
            userId: args.actor.id,
          }),
        })
        .catch(() => null);
    }

    await logEvent({
      type: "NOTE_ADDED",
      entityType: "MESSAGE",
      entityId: saved.id,
      entityLabel: senderName,
      conversationId: conv.id,
      contactId: conv.contactId,
      dealId,
      meta: { preview: content.slice(0, 200), source: "outbound_service", isPrivate: true },
    });
  })();

  publishNewMessage(conv, content, saved.createdAt);

  return {
    ok: true,
    conversationId: conv.id,
    message: {
      id: saved.id,
      content,
      createdAt: saved.createdAt.toISOString(),
      direction: "out",
      messageType: "note",
      isPrivate: true,
      senderName,
    },
  };
}

// ── Texto WhatsApp ───────────────────────────

/**
 * Envia texto livre na conversa de WhatsApp (Meta Cloud API ou Baileys).
 *
 * Escopo deliberadamente restrito a WhatsApp: Messenger e Instagram têm
 * identificadores e endpoints próprios e continuam exclusivos do composer do
 * inbox (`POST /api/conversations/:id/messages`), que já trata esses casos.
 */
export async function sendTextToConversation(args: {
  conversationId: string;
  actor: OutboundActor;
  content: string;
  /** Override do canal de saída quando a org tem mais de um WhatsApp. */
  channelId?: string | null;
  /**
   * Encerra automações ativas do contato, como faz a resposta de um operador.
   * Default `true` (paridade com o composer do inbox): sem isso, um salesbot
   * em andamento continuaria mandando mensagens sobrepostas ao envio.
   * Integrações que orquestram o fluxo por fora podem desligar.
   */
  stopAutomations?: boolean;
}): Promise<OutboundResult> {
  const content = args.content.trim();
  if (!content) return { ok: false, status: 400, message: "Mensagem vazia." };

  const found = await getConversationLite(args.conversationId);
  if (!found) return { ok: false, status: 404, message: "Conversa não encontrada." };

  if (found.channel !== "whatsapp") {
    return {
      ok: false,
      status: 400,
      message: `Envio de texto por esta rota é exclusivo de WhatsApp (canal da conversa: ${found.channel}).`,
    };
  }

  const { conv, reopenedConversationId } = await reopenIfResolved(found);

  const sendDenied = await requireChannelScope(
    { id: args.actor.id, role: args.actor.role ?? undefined, organizationId: args.actor.organizationId, isSuperAdmin: args.actor.isSuperAdmin },
    "send",
    conv.channelId,
  );
  if (sendDenied) return denialToFailure(sendDenied);

  const resolved = await resolveOutboundChannel({
    conv: {
      channelId: conv.channelId,
      channelRef: conv.channelRef,
      organizationId: conv.organizationId,
    },
    user: {
      id: args.actor.id,
      role: args.actor.role ?? null,
      organizationId: args.actor.organizationId,
      isSuperAdmin: args.actor.isSuperAdmin,
    },
    requestedChannelId: args.channelId ?? null,
  });
  if (!resolved.ok) return denialToFailure(resolved.response);

  const outboundChannelRef = resolved.channelRef;
  const outboundChannelId = resolved.channelId;
  // `resolveOutboundChannel` já bloqueia override desconectado; o caminho
  // padrão (sem override) usa `conv.channelRef` sem checagem, então o guard
  // precisa rodar aqui também.
  const disconnected = ensureChannelConnected(outboundChannelRef);
  if (disconnected) return disconnected;
  const useBaileys = isBaileysChannel(outboundChannelRef);
  const channelConfig = outboundChannelRef?.config as Record<string, unknown> | null | undefined;
  // Sem canal Meta configurado: persiste localmente (dev/mock) em vez de 500.
  const localOnly = !useBaileys && !metaClientFromConfig(channelConfig).configured;

  if (!useBaileys && !localOnly) {
    const target = await getContactWhatsAppTargets(conv.contactId ?? "");
    if (!target) {
      return {
        ok: false,
        status: 400,
        message: "Contato sem telefone nem BSUID WhatsApp (Meta).",
      };
    }
  }

  const senderName = actorName(args.actor);
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      channelId: outboundChannelId ?? undefined,
      content,
      direction: "out",
      messageType: "text",
      senderName,
      ...(localOnly ? { sendStatus: "sent" } : {}),
    }),
  });

  const sendResult = localOnly
    ? { externalId: null as string | null, failed: false, error: undefined as string | undefined }
    : await sendWhatsAppText({
        conversationId: conv.id,
        contactId: conv.contactId,
        channelRef: outboundChannelRef,
        content,
        messageId: saved.id,
        waJid: conv.waJid,
      });

  try {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageDirection: "out",
        hasAgentReply: true,
        hasError: sendResult.failed,
      },
    });
  } catch {
    // colunas opcionais em bases antigas
  }

  if (!sendResult.failed) {
    void logEvent({
      type: "MESSAGE_SENT",
      entityType: "MESSAGE",
      entityId: saved.id,
      entityLabel: senderName,
      conversationId: conv.id,
      contactId: conv.contactId,
      meta: {
        preview: content.slice(0, 200),
        channel: "WhatsApp",
        via: useBaileys ? "baileys" : localOnly ? "local" : "meta",
        externalId: sendResult.externalId,
      },
    });
  }

  publishNewMessage(conv, content, saved.createdAt);
  await afterOutboundSideEffects(
    conv,
    args.actor.id,
    content,
    args.stopAutomations !== false,
    outboundChannelId,
  );

  return {
    ok: true,
    conversationId: conv.id,
    ...(reopenedConversationId ? { reopenedConversationId } : {}),
    ...(sendResult.error ? { metaError: sendResult.error } : {}),
    message: {
      id: saved.id,
      content,
      createdAt: saved.createdAt.toISOString(),
      direction: "out",
      messageType: "text",
      senderName,
      externalId: sendResult.externalId,
    },
  };
}

// ── Botões interativos WhatsApp ──────────────

export type OutboundButton = { id?: string | null; title: string };

/**
 * Envia mensagem interativa "reply buttons" (Meta Cloud API) na conversa.
 *
 * Regras da Meta:
 *  - 1 a 3 botões, `title` ≤ 20 chars, `id` ≤ 256 chars.
 *  - `body` obrigatório, ≤ 1024 chars.
 *  - `header` opcional (só texto aqui), ≤ 60 chars.
 *  - `footer` opcional, ≤ 60 chars.
 *
 * Content salvo no Message segue o mesmo formato usado pelo `automation-executor`
 * (`send_whatsapp_interactive`): `"body\n[Botões: t1, t2, t3]"`. Isso mantém a
 * timeline igual quer a mensagem venha de automação ou de integração — quem
 * clica registra a resposta como texto ("Sim", "Não", …), então a legenda entre
 * colchetes já resolve a leitura no /inbox.
 *
 * Escopo: só WhatsApp Meta Cloud API. Baileys não suporta interactive (rejeita
 * com 400) e IG/FB Messenger têm endpoints próprios (rejeita com 400).
 */
export async function sendInteractiveButtonsToConversation(args: {
  conversationId: string;
  actor: OutboundActor;
  body: string;
  buttons: OutboundButton[];
  header?: string | null;
  footer?: string | null;
  channelId?: string | null;
  stopAutomations?: boolean;
}): Promise<OutboundResult> {
  const body = args.body.trim();
  if (!body) return { ok: false, status: 400, message: "body é obrigatório." };
  if (body.length > 1024) {
    return { ok: false, status: 400, message: "body excede 1024 caracteres (limite Meta)." };
  }

  const rawButtons = Array.isArray(args.buttons) ? args.buttons : [];
  if (rawButtons.length === 0) {
    return { ok: false, status: 400, message: "Informe ao menos 1 botão." };
  }
  if (rawButtons.length > 3) {
    return { ok: false, status: 400, message: "Máximo de 3 botões por mensagem (limite Meta)." };
  }

  const buttons = rawButtons.map((b, i) => {
    const title = typeof b?.title === "string" ? b.title.trim() : "";
    return {
      id: (typeof b?.id === "string" && b.id.trim() ? b.id.trim() : `btn_${i + 1}`).slice(0, 256),
      title: title.slice(0, 20),
    };
  });
  if (buttons.some((b) => !b.title)) {
    return { ok: false, status: 400, message: "Todo botão precisa de um title." };
  }

  const header = args.header?.trim() || null;
  if (header && header.length > 60) {
    return { ok: false, status: 400, message: "header excede 60 caracteres (limite Meta)." };
  }
  const footer = args.footer?.trim() || null;
  if (footer && footer.length > 60) {
    return { ok: false, status: 400, message: "footer excede 60 caracteres (limite Meta)." };
  }

  const found = await getConversationLite(args.conversationId);
  if (!found) return { ok: false, status: 404, message: "Conversa não encontrada." };
  if (found.channel !== "whatsapp") {
    return {
      ok: false,
      status: 400,
      message: `Botões interativos são exclusivos de WhatsApp (canal da conversa: ${found.channel}).`,
    };
  }

  const { conv, reopenedConversationId } = await reopenIfResolved(found);

  const sendDenied = await requireChannelScope(
    { id: args.actor.id, role: args.actor.role ?? undefined, organizationId: args.actor.organizationId, isSuperAdmin: args.actor.isSuperAdmin },
    "send",
    conv.channelId,
  );
  if (sendDenied) return denialToFailure(sendDenied);

  const resolved = await resolveOutboundChannel({
    conv: {
      channelId: conv.channelId,
      channelRef: conv.channelRef,
      organizationId: conv.organizationId,
    },
    user: {
      id: args.actor.id,
      role: args.actor.role ?? null,
      organizationId: args.actor.organizationId,
      isSuperAdmin: args.actor.isSuperAdmin,
    },
    requestedChannelId: args.channelId ?? null,
  });
  if (!resolved.ok) return denialToFailure(resolved.response);

  const outboundChannelRef = resolved.channelRef;
  const outboundChannelId = resolved.channelId;
  const disconnected = ensureChannelConnected(outboundChannelRef);
  if (disconnected) return disconnected;
  if (isBaileysChannel(outboundChannelRef)) {
    return {
      ok: false,
      status: 400,
      message: "Botões interativos não são suportados em canais WhatsApp QR (Baileys). Use texto ou template.",
    };
  }

  const channelConfig = outboundChannelRef?.config as Record<string, unknown> | null | undefined;
  const metaClient = metaClientFromConfig(channelConfig);
  if (!metaClient.configured) {
    return {
      ok: false,
      status: 503,
      message:
        "Canal WhatsApp da conversa sem credenciais Meta (accessToken/phoneNumberId). Configure em Canais ou defina META_WHATSAPP_* no env.",
    };
  }

  const target = await getContactWhatsAppTargets(conv.contactId ?? "");
  if (!target) {
    return {
      ok: false,
      status: 400,
      message: "Contato sem telefone nem BSUID WhatsApp (Meta).",
    };
  }
  // `getContactWhatsAppTargets` já normaliza para `{ to?, recipient? }` —
  // `sendInteractiveButtons` aceita ambos e escolhe o melhor via
  // `recipientFields` (BSUID tem prioridade quando ambos existem).
  const { to, recipient } = target;

  const senderName = actorName(args.actor);
  const btnLabels = buttons.map((b) => b.title).join(", ");
  const displayContent = `${body}\n[Botões: ${btnLabels}]`;

  // Persistir a Message ANTES do send falhar dá timeline confiável mesmo com
  // erro na Meta — igual a `sendTextToConversation`. O externalId é
  // preenchido depois do sucesso.
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      channelId: outboundChannelId ?? undefined,
      content: displayContent,
      direction: "out",
      messageType: "interactive",
      senderName,
    }),
  });

  let externalId: string | null = null;
  let sendError: string | undefined;
  try {
    const result = await metaClient.sendInteractiveButtons(
      to,
      body,
      buttons,
      header ?? undefined,
      footer ?? undefined,
      recipient,
    );
    externalId = result.messages?.[0]?.id ?? null;
    if (externalId) {
      await prisma.message
        .update({ where: { id: saved.id }, data: { externalId, sendStatus: "sent" } })
        .catch(() => {});
    }
  } catch (e: unknown) {
    sendError = e instanceof Error ? e.message : "Falha ao enviar botões pelo WhatsApp.";
    console.error("[meta-send-interactive]", e);
    await prisma.message
      .update({ where: { id: saved.id }, data: { sendStatus: "failed" } })
      .catch(() => {});
  }

  try {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageDirection: "out",
        hasAgentReply: true,
        hasError: Boolean(sendError),
      },
    });
  } catch {
    // colunas opcionais em bases antigas
  }

  if (!sendError) {
    void logEvent({
      type: "MESSAGE_SENT",
      entityType: "MESSAGE",
      entityId: saved.id,
      entityLabel: senderName,
      conversationId: conv.id,
      contactId: conv.contactId,
      meta: {
        preview: body.slice(0, 200),
        channel: "WhatsApp",
        kind: "interactive",
        buttons: buttons.map((b) => ({ id: b.id, title: b.title })),
        externalId,
      },
    });
  }

  publishNewMessage(conv, displayContent, saved.createdAt);
  await afterOutboundSideEffects(
    conv,
    args.actor.id,
    displayContent,
    args.stopAutomations !== false,
    outboundChannelId,
  );

  if (sendError) {
    return { ok: false, status: 502, message: sendError };
  }

  return {
    ok: true,
    conversationId: conv.id,
    ...(reopenedConversationId ? { reopenedConversationId } : {}),
    message: {
      id: saved.id,
      content: displayContent,
      createdAt: saved.createdAt.toISOString(),
      direction: "out",
      messageType: "interactive",
      senderName,
      externalId,
    },
  };
}

// ── Lista interativa WhatsApp ────────────────

export type OutboundListRow = {
  id?: string | null;
  title: string;
  description?: string | null;
};

export type OutboundListSection = {
  title?: string | null;
  rows: OutboundListRow[];
};

/**
 * Envia mensagem interativa "list" (Meta Cloud API) na conversa.
 *
 * Diferente dos botões (`type=button`, máx 3), a list mostra um único botão
 * `action.button` que abre um menu com até 10 opções — o padrão oficial da
 * Meta para menus mais longos.
 *
 * Aceita duas formas de entrada (o node usa a primeira, integrações manuais
 * podem usar a segunda):
 *   1. `rows` no top-level (+ `sectionTitle` opcional): vira `sections=[{ title, rows }]`.
 *   2. `sections` no top-level: passa direto, respeitando múltiplas seções.
 *
 * Limites Meta validados antes do envio: 1-10 rows totais, body ≤ 4096,
 * button ≤ 20, header/footer ≤ 60, cada row.title ≤ 24, description ≤ 72.
 *
 * Persiste `Message.messageType="interactive"` com
 * `content = "body\n[Lista: title1, title2, ...]"` — mesmo shape usado por
 * `sendInteractiveButtonsToConversation`, timeline unificada no /inbox.
 *
 * Escopo: só WhatsApp Meta Cloud API. Rejeita Baileys e canais não-WhatsApp.
 */
export async function sendInteractiveListToConversation(args: {
  conversationId: string;
  actor: OutboundActor;
  body: string;
  button: string;
  sections?: OutboundListSection[] | null;
  rows?: OutboundListRow[] | null;
  sectionTitle?: string | null;
  header?: string | null;
  footer?: string | null;
  channelId?: string | null;
  stopAutomations?: boolean;
}): Promise<OutboundResult> {
  const body = args.body.trim();
  if (!body) return { ok: false, status: 400, message: "body é obrigatório." };
  if (body.length > 4096) {
    return { ok: false, status: 400, message: "body excede 4096 caracteres (limite Meta)." };
  }

  const button = args.button.trim();
  if (!button) return { ok: false, status: 400, message: "button é obrigatório (rótulo do botão que abre a lista)." };
  if (button.length > 20) {
    return { ok: false, status: 400, message: "button excede 20 caracteres (limite Meta)." };
  }

  // Normaliza para o formato `sections`. `rows` no top-level tem prioridade
  // porque é o caminho amigável usado pelo node do n8n; `sections` é o
  // caminho avançado (múltiplas seções via HTTP direto).
  let sectionsInput: OutboundListSection[];
  if (Array.isArray(args.rows) && args.rows.length > 0) {
    sectionsInput = [
      { title: args.sectionTitle?.trim() || null, rows: args.rows },
    ];
  } else if (Array.isArray(args.sections) && args.sections.length > 0) {
    sectionsInput = args.sections;
  } else {
    return { ok: false, status: 400, message: "Informe rows (ou sections) com ao menos 1 item." };
  }

  const totalRows = sectionsInput.reduce(
    (n, s) => n + (Array.isArray(s.rows) ? s.rows.length : 0),
    0,
  );
  if (totalRows === 0) {
    return { ok: false, status: 400, message: "Informe ao menos 1 row na lista." };
  }
  if (totalRows > 10) {
    return { ok: false, status: 400, message: "Máximo de 10 rows na lista (limite Meta)." };
  }
  if (sectionsInput.length > 10) {
    return { ok: false, status: 400, message: "Máximo de 10 seções na lista (limite Meta)." };
  }

  // Validação prévia (antes do map final): garante que qualquer erro de
  // shape volta como HTTP 400 do service, e não como exceção não tratada.
  for (const s of sectionsInput) {
    if (!Array.isArray(s.rows)) {
      return { ok: false, status: 400, message: "Toda seção precisa ter rows." };
    }
    for (const r of s.rows) {
      if (!r || typeof r.title !== "string" || !r.title.trim()) {
        return { ok: false, status: 400, message: "Toda row precisa de um title." };
      }
    }
  }

  const rowTitlesForContent: string[] = [];
  let rowIdx = 0;
  const sections = sectionsInput.map((s) => ({
    title: s.title?.trim() || null,
    rows: s.rows.map((r) => {
      rowIdx += 1;
      const title = r.title.trim();
      rowTitlesForContent.push(title.length > 24 ? title.slice(0, 24) : title);
      const id =
        typeof r.id === "string" && r.id.trim()
          ? r.id.trim()
          : `row_${rowIdx}`;
      return {
        id: id.slice(0, 200),
        title: title.slice(0, 24),
        description:
          typeof r.description === "string" && r.description.trim()
            ? r.description.trim().slice(0, 72)
            : null,
      };
    }),
  }));

  const header = args.header?.trim() || null;
  if (header && header.length > 60) {
    return { ok: false, status: 400, message: "header excede 60 caracteres (limite Meta)." };
  }
  const footer = args.footer?.trim() || null;
  if (footer && footer.length > 60) {
    return { ok: false, status: 400, message: "footer excede 60 caracteres (limite Meta)." };
  }

  const found = await getConversationLite(args.conversationId);
  if (!found) return { ok: false, status: 404, message: "Conversa não encontrada." };
  if (found.channel !== "whatsapp") {
    return {
      ok: false,
      status: 400,
      message: `Listas interativas são exclusivas de WhatsApp (canal da conversa: ${found.channel}).`,
    };
  }

  const { conv, reopenedConversationId } = await reopenIfResolved(found);

  const sendDenied = await requireChannelScope(
    { id: args.actor.id, role: args.actor.role ?? undefined, organizationId: args.actor.organizationId, isSuperAdmin: args.actor.isSuperAdmin },
    "send",
    conv.channelId,
  );
  if (sendDenied) return denialToFailure(sendDenied);

  const resolved = await resolveOutboundChannel({
    conv: {
      channelId: conv.channelId,
      channelRef: conv.channelRef,
      organizationId: conv.organizationId,
    },
    user: {
      id: args.actor.id,
      role: args.actor.role ?? null,
      organizationId: args.actor.organizationId,
      isSuperAdmin: args.actor.isSuperAdmin,
    },
    requestedChannelId: args.channelId ?? null,
  });
  if (!resolved.ok) return denialToFailure(resolved.response);

  const outboundChannelRef = resolved.channelRef;
  const outboundChannelId = resolved.channelId;
  const disconnected = ensureChannelConnected(outboundChannelRef);
  if (disconnected) return disconnected;
  if (isBaileysChannel(outboundChannelRef)) {
    return {
      ok: false,
      status: 400,
      message: "Listas interativas não são suportadas em canais WhatsApp QR (Baileys). Use texto ou template.",
    };
  }

  const channelConfig = outboundChannelRef?.config as Record<string, unknown> | null | undefined;
  const metaClient = metaClientFromConfig(channelConfig);
  if (!metaClient.configured) {
    return {
      ok: false,
      status: 503,
      message:
        "Canal WhatsApp da conversa sem credenciais Meta (accessToken/phoneNumberId). Configure em Canais ou defina META_WHATSAPP_* no env.",
    };
  }

  const target = await getContactWhatsAppTargets(conv.contactId ?? "");
  if (!target) {
    return {
      ok: false,
      status: 400,
      message: "Contato sem telefone nem BSUID WhatsApp (Meta).",
    };
  }
  const { to, recipient } = target;

  const senderName = actorName(args.actor);
  const displayContent = `${body}\n[Lista: ${rowTitlesForContent.join(", ")}]`;

  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      channelId: outboundChannelId ?? undefined,
      content: displayContent,
      direction: "out",
      messageType: "interactive",
      senderName,
    }),
  });

  let externalId: string | null = null;
  let sendError: string | undefined;
  try {
    // `sendInteractiveList` corta títulos/descriptions internamente, então
    // `sections` já vai no shape aceito pela Cloud API.
    const result = await metaClient.sendInteractiveList(
      to,
      body,
      button,
      sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
        })),
      })),
      header ?? undefined,
      footer ?? undefined,
      recipient,
    );
    externalId = result.messages?.[0]?.id ?? null;
    if (externalId) {
      await prisma.message
        .update({ where: { id: saved.id }, data: { externalId, sendStatus: "sent" } })
        .catch(() => {});
    }
  } catch (e: unknown) {
    sendError = e instanceof Error ? e.message : "Falha ao enviar lista pelo WhatsApp.";
    console.error("[meta-send-list]", e);
    await prisma.message
      .update({ where: { id: saved.id }, data: { sendStatus: "failed" } })
      .catch(() => {});
  }

  try {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageDirection: "out",
        hasAgentReply: true,
        hasError: Boolean(sendError),
      },
    });
  } catch {
    // colunas opcionais em bases antigas
  }

  if (!sendError) {
    void logEvent({
      type: "MESSAGE_SENT",
      entityType: "MESSAGE",
      entityId: saved.id,
      entityLabel: senderName,
      conversationId: conv.id,
      contactId: conv.contactId,
      meta: {
        preview: body.slice(0, 200),
        channel: "WhatsApp",
        kind: "list",
        button,
        rowTitles: rowTitlesForContent,
        externalId,
      },
    });
  }

  publishNewMessage(conv, displayContent, saved.createdAt);
  await afterOutboundSideEffects(
    conv,
    args.actor.id,
    displayContent,
    args.stopAutomations !== false,
    outboundChannelId,
  );

  if (sendError) {
    return { ok: false, status: 502, message: sendError };
  }

  return {
    ok: true,
    conversationId: conv.id,
    ...(reopenedConversationId ? { reopenedConversationId } : {}),
    message: {
      id: saved.id,
      content: displayContent,
      createdAt: saved.createdAt.toISOString(),
      direction: "out",
      messageType: "interactive",
      senderName,
      externalId,
    },
  };
}

// ── Template Meta ────────────────────────────

export type SendTemplateArgs = {
  conversationId: string;
  actor: OutboundActor;
  templateName: string;
  /** Ausente = idioma declarado no próprio template; se indisponível, pt_BR. */
  languageCode?: string | null;
  /** Array no formato da Cloud API. Já montado por `buildTemplateComponents`. */
  components?: unknown[] | null;
  /** Corpo renderizado, usado como texto da mensagem salva na timeline. */
  bodyPreview?: string | null;
  /**
   * Variáveis preenchidas. Só servem para renderizar o preview quando
   * `bodyPreview` não é informado — o payload enviado à Meta vem de
   * `components`. Integrações mandam as duas coisas derivadas das mesmas
   * variáveis; a UI já manda `bodyPreview` pronto.
   */
  templateVariables?: TemplateVariableInput[] | null;
  templateGraphId?: string | null;
  flowToken?: string | null;
  flowActionData?: Record<string, unknown> | null;
  /**
   * Override do canal de saída (11/ago/26): quando o canal original da
   * conversa está DISCONNECTED, o operador pode escolher outro canal WhatsApp
   * da mesma org. Passa por `resolveOutboundChannel` para validar
   * organização/tipo/status/scope, como já acontece em `sendText`.
   */
  channelId?: string | null;
};

/**
 * Envia template aprovado da WABA na conversa.
 *
 * Extraído de `POST /api/conversations/:id/template` sem mudança de
 * comportamento — inclusive `strictFlowEnrich: false`, que mantém o envio de
 * templates simples funcionando quando a consulta da definição na Meta falha.
 */
export async function sendTemplateToConversation(
  args: SendTemplateArgs,
): Promise<OutboundResult> {
  const templateName = args.templateName.trim();
  if (!templateName) {
    return { ok: false, status: 400, message: "templateName é obrigatório." };
  }

  const findConvFull = (convId: string) =>
    prisma.conversation.findUnique({
      where: { id: convId },
      include: {
        contact: { select: { phone: true, whatsappBsuid: true } },
        // Config do canal resolve o cliente Meta correto por org — o
        // singleton de env rotearia todo mundo pelo primeiro número
        // configurado (leak entre tenants).
        // `name`/`status`/`phoneNumber`/`type` são o que o `LiteChannelRef` do
        // `resolveOutboundChannel` espera; sem eles não dava para reusar a
        // resolução de override e a mensagem de "canal desconectado".
        channelRef: {
          select: {
            id: true, provider: true, config: true, name: true,
            phoneNumber: true, type: true, status: true,
          },
        },
      },
    });

  let conv = await findConvFull(args.conversationId);
  if (!conv) return { ok: false, status: 404, message: "Conversa não encontrada." };

  let reopenedConversationId: string | null = null;
  if (conv.status === "RESOLVED" && conv.contactId) {
    const reopened = await reopenResolvedAsNewTicket(conv.id);
    if (reopened.id !== conv.id) {
      const fresh = await findConvFull(reopened.id);
      if (fresh) {
        reopenedConversationId = reopened.id;
        conv = fresh;
      }
    }
  }

  // Override de canal: resolve ANTES do scope. Sessão 24h fechada costuma
  // cair num canal DISCONNECTED; o operador escolhe outro CONNECTED e o
  // grant tem que ser o do canal de saída, não o do ticket antigo.
  const resolved = await resolveOutboundChannel({
    conv: {
      channelId: conv.channelId,
      channelRef: conv.channelRef,
      organizationId: conv.organizationId,
    },
    user: {
      id: args.actor.id,
      role: args.actor.role ?? null,
      organizationId: args.actor.organizationId,
      isSuperAdmin: args.actor.isSuperAdmin,
    },
    requestedChannelId: args.channelId ?? null,
  });
  if (!resolved.ok) return denialToFailure(resolved.response);
  const outboundChannelRef = resolved.channelRef;
  const outboundChannelId = resolved.channelId;

  const sendDenied = await requireChannelScope(
    { id: args.actor.id, role: args.actor.role ?? undefined, organizationId: args.actor.organizationId, isSuperAdmin: args.actor.isSuperAdmin },
    "send",
    outboundChannelId,
  );
  if (sendDenied) return denialToFailure(sendDenied);

  const disconnected = ensureChannelConnected(outboundChannelRef);
  if (disconnected) return disconnected;

  if (outboundChannelRef?.provider === "BAILEYS_MD") {
    return {
      ok: false,
      status: 400,
      message:
        "Templates não são suportados em canais WhatsApp QR (Baileys). Use mensagem de texto.",
    };
  }

  const digits = conv.contact?.phone?.replace(/\D/g, "") ?? "";
  const to = digits.length >= 8 ? digits : undefined;
  const recipient = conv.contact?.whatsappBsuid?.trim() || undefined;
  if (!to && !recipient) {
    return { ok: false, status: 400, message: "Contato sem telefone nem BSUID WhatsApp (Meta)." };
  }

  const channelConfig = outboundChannelRef?.config as Record<string, unknown> | null | undefined;
  const metaClient = metaClientFromConfig(channelConfig);
  if (!metaClient.configured) {
    return {
      ok: false,
      status: 503,
      message:
        "Canal WhatsApp escolhido sem credenciais Meta (accessToken/phoneNumberId). Configure em Canais ou defina META_WHATSAPP_* no env.",
    };
  }

  const senderName = actorName(args.actor);

  let templateCategory: string | null = null;
  let templateGraphId: string | null = args.templateGraphId?.trim() || null;
  // Capturar o id da config é o que permite ao resolver de Flow inbound
  // identificar o flow certo quando a resposta volta.
  let templateConfigId: string | null = null;
  let configLanguage: string | null = null;
  /** Config local sabe se há botão FLOW — evita lookup Meta no enrich. */
  let knownHasFlowButton: boolean | null = null;
  try {
    const cfg = await prisma.whatsAppTemplateConfig.findFirst({
      where: { metaTemplateName: templateName },
      select: {
        id: true,
        category: true,
        metaTemplateId: true,
        language: true,
        hasButtons: true,
        buttonTypes: true,
      },
    });
    templateCategory = cfg?.category ?? null;
    templateConfigId = cfg?.id ?? null;
    configLanguage = cfg?.language?.trim() || null;
    if (!templateGraphId && cfg?.metaTemplateId?.trim()) {
      templateGraphId = cfg.metaTemplateId.trim();
    }
    if (cfg) {
      const types = Array.isArray(cfg.buttonTypes) ? cfg.buttonTypes : [];
      knownHasFlowButton = types.some((t) => String(t).toUpperCase() === "FLOW");
      if (!cfg.hasButtons) knownHasFlowButton = false;
    }
  } catch {
    // config local é opcional — o template pode existir só na WABA
  }

  let bodyPreview = args.bodyPreview?.trim() || null;
  let languageCode = args.languageCode?.trim() || configLanguage || null;

  // Consulta a Graph só quando falta preview (ou category+idioma juntos).
  // Idioma sozinho NÃO justifica listar até 200 templates (timeout → 502 proxy).
  if (!bodyPreview || (!templateCategory && !languageCode)) {
    const metaTemplates = (await metaClient
      .listMessageTemplates({ limit: 200 })
      .catch(() => null)) as {
      data?: {
        name: string;
        category?: string;
        language?: string;
        components?: unknown[];
        parameter_format?: string;
      }[];
    } | null;
    const match = metaTemplates?.data?.find((t) => t.name === templateName);
    if (match) {
      if (!templateCategory && match.category) templateCategory = match.category;
      if (!languageCode && match.language) languageCode = match.language;
      if (!bodyPreview) {
        const analysis = analyzeTemplateComponents(match.components, {
          parameterFormat: match.parameter_format ?? null,
        });
        bodyPreview =
          renderTemplatePreview(analysis.bodyText, args.templateVariables).trim() || null;
      }
    }
  }

  if (!languageCode) languageCode = "pt_BR";

  const content = buildOutboundTemplateMessageContent(
    templateName,
    "generic",
    templateCategory,
    bodyPreview,
  );

  let externalId: string | null = null;
  let resolvedFlowToken: string | null = null;
  try {
    const baseComponents = Array.isArray(args.components) ? args.components : undefined;
    // Template sem FLOW (config local): envia direto — GET/listagem Meta no
    // enrich era a causa frequente de timeout do proxy após o deploy.
    let sendComponents = baseComponents;
    if (knownHasFlowButton !== false) {
      const enrichResult = await enrichTemplateComponentsForFlowSend(metaClient, {
        templateName,
        languageCode,
        components: baseComponents,
        flowToken: args.flowToken?.trim() || null,
        flowActionData: args.flowActionData ?? null,
        templateGraphId,
        strictFlowEnrich: false,
      });
      sendComponents = enrichResult.components;
      resolvedFlowToken = enrichResult.flowToken;
    }
    const result = await metaClient.sendTemplate(
      to,
      templateName,
      languageCode,
      sendComponents,
      recipient,
    );
    externalId = result.messages?.[0]?.id ?? null;
    console.log(
      `[meta-send-template] template=${templateName} channel=${outboundChannelId ?? "ENV"} to=${to ?? "—"}/${recipient ?? "—"} wamid=${externalId} flowEnrich=${knownHasFlowButton !== false}`,
    );
  } catch (e: unknown) {
    console.error("[meta-send-template]", e);
    return {
      ok: false,
      status: 502,
      message: e instanceof Error ? e.message : "Falha ao enviar template pelo WhatsApp.",
    };
  }

  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      channelId: outboundChannelId ?? undefined,
      content,
      direction: "out",
      messageType: "template",
      senderName,
      ...(externalId ? { externalId } : {}),
      ...(resolvedFlowToken?.trim() ? { flowToken: resolvedFlowToken.trim() } : {}),
      ...(templateConfigId ? { templateConfigId } : {}),
    }),
  });

  publishNewMessage(conv, content, saved.createdAt);

  const priorPublic = await prisma.message.count({
    where: {
      conversationId: conv.id,
      isPrivate: false,
      id: { not: saved.id },
      NOT: [
        { messageType: "note" },
        { messageType: "event" },
        { messageType: { startsWith: "event:" } },
      ],
    },
  });
  if (priorPublic === 0) {
    const actor = formatHumanActorDisplayName(args.actor.name, args.actor.email) || "Agente";
    void createConversationEvent({
      conversationId: conv.id,
      action: "template",
      text: "Conversa iniciada por template",
      actor,
      actorUserId: args.actor.id,
    });
  }

  await afterOutboundSideEffects(
    conv,
    args.actor.id,
    content,
    true,
    outboundChannelId,
  );

  return {
    ok: true,
    conversationId: conv.id,
    ...(reopenedConversationId ? { reopenedConversationId } : {}),
    message: {
      id: saved.id,
      content,
      createdAt: saved.createdAt.toISOString(),
      direction: "out",
      messageType: "template",
      senderName,
      externalId,
    },
  };
}

/**
 * Efeitos colaterais comuns a um envio humano/integração de texto: encerra
 * salesbot ativo, dispara `message_sent` e cancela agendamentos pendentes.
 * Todos best-effort — nenhum deles deve derrubar um envio bem-sucedido.
 */
async function afterOutboundSideEffects(
  conv: Pick<ConversationLite, "id" | "contactId" | "channelId" | "channel">,
  actorId: string,
  content: string,
  stopAutomations: boolean,
  outboundChannelId?: string | null,
): Promise<void> {
  if (stopAutomations && conv.contactId) {
    try {
      await cancelActiveContextsForContact(conv.contactId);
    } catch (err) {
      console.warn("[automation] cancel after outbound:", err);
    }
  }
  const channelId = outboundChannelId || conv.channelId || null;
  fireTrigger("message_sent", {
    contactId: conv.contactId,
    data: buildMessageTriggerData({
      channel: conv.channel || "WhatsApp",
      channelId,
      conversationId: conv.id,
      content,
    }),
  }).catch((err) => console.warn("[automation trigger] message_sent:", err));
  cancelPendingForConversation(conv.id, "agent_reply", actorId).catch((err) =>
    console.warn("[scheduled-messages] falha ao cancelar apos envio:", err),
  );
}
