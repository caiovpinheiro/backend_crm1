/**
 * Scheduled Messages Worker — poll in-process que processa agendamentos
 * vencidos a cada `INTERVAL_MS`. Bootado junto com o sse-bus (mesmo
 * padrão do `presence-reaper`), opt-in via env `SCHEDULED_MESSAGES_WORKER=1`
 * para evitar que TODAS as réplicas processem o mesmo backlog.
 *
 * Fluxo de um agendamento pendente (scheduledAt <= now):
 *
 *  1. Tenta "reservar" via updateMany (where status=PENDING → data.status=PENDING
 *     com updatedAt). Se 0 rows afetadas, outro worker já pegou → skip.
 *     NOTA: implementação atual NÃO usa status intermediário "SENDING" porque
 *     o default de deploy é 1 réplica. Se precisar escalar, adicionar um
 *     ScheduledMessageStatus.SENDING e transição atômica.
 *  2. Decide modo de envio:
 *       • Canal WhatsApp Meta + sessão 24h expirada → template fallback
 *         (exigido ao criar; se ausente, FAILED).
 *       • Canal WhatsApp (Meta ou Baileys) → texto livre via sendWhatsAppText.
 *       • Outros canais → FAILED com razão clara.
 *  3. Cria a Message no banco para espelhar no inbox e chama API do canal.
 *  4. markAsSent / markAsFailed.
 *
 * Mensagens com anexo ainda não são enviadas nesta fase (texto only) —
 * o campo mediaUrl é persistido mas o worker ignora; upgrade futuro
 * buscará o binário e chamará o endpoint de media do canal.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
// prismaBase para check de concorrencia cross-org (antes de entrar no
// withSystemContext da org do item).
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { metaClientFromConfig, metaWhatsApp } from "@/lib/meta-whatsapp/client";
import { enrichTemplateComponentsForFlowSend } from "@/lib/meta-whatsapp/enrich-template-flow";
import { sendWhatsAppText } from "@/lib/send-whatsapp";
import { buildOutboundTemplateMessageContent } from "@/lib/whatsapp-outbound-template-label";
import {
  listDueScheduledMessages,
  markAsFailed,
  markAsSent,
} from "@/services/scheduled-messages";
import { getLogger } from "@/lib/logger";
import { scheduleBackgroundTimeout, scheduleBackgroundInterval } from "@/lib/background-timers";

const log = getLogger("scheduled-messages-worker");

const INTERVAL_MS = Number(process.env.SCHEDULED_MESSAGES_INTERVAL_MS) || 30_000;
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

let started = false;

export function startScheduledMessagesWorker() {
  if (started) return;
  // Permite desligar o worker em réplicas específicas (ex.: rodar só em
  // uma instância dedicada).
  if (process.env.SCHEDULED_MESSAGES_WORKER === "0") {
    log.info("[scheduled-messages] worker desativado via env");
    return;
  }
  started = true;

  const tick = async () => {
    try {
      await tickOnce();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[scheduled-messages] tick falhou",
      );
    }
  };

  // Primeiro tick só depois de 15s (dá tempo do servidor estabilizar
  // e da migration deploy, se recém-subiu).
  scheduleBackgroundTimeout(() => {
    void tick();
    scheduleBackgroundInterval(() => void tick(), INTERVAL_MS);
  }, 15_000);

  log.info({ tickMs: INTERVAL_MS }, "[scheduled-messages] worker iniciado");
}

export async function tickOnce() {
  const due = await listDueScheduledMessages(25);
  if (due.length === 0) return { processed: 0 };

  let sent = 0;
  let failed = 0;

  for (const item of due) {
    const orgId = item.conversation?.organizationId;
    if (!orgId) {
      // ScheduledMessage orfao (conversa removida) — nao conseguimos
      // montar contexto. markAsFailed precisa de org tambem; usamos
      // prismaBase direto para registrar a falha sem scope.
      await prismaBase.scheduledMessage
        .update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            failedAt: new Date(),
            failureReason: "Conversa removida antes do envio",
          },
        })
        .catch(() => {});
      failed++;
      continue;
    }

    // Concorrência: confirma que ainda está PENDING antes de gastar
    // I/O externo. Outro worker pode ter processado neste intervalo.
    // Usa prismaBase para evitar exigir contexto e nao vazar scope.
    const stillPending = await prismaBase.scheduledMessage.findUnique({
      where: { id: item.id },
      select: { status: true },
    });
    if (stillPending?.status !== "PENDING") continue;

    try {
      // Toda a pipeline de dispatch acessa models scoped (Message,
      // Conversation, Contact, Channel, etc.) — precisa do contexto
      // da org do item para o extension de org-scope injetar filtros.
      await withSystemContext(orgId, () => dispatchOne(item));
      sent++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ id: item.id, err: msg }, "[scheduled-messages] dispatch falhou");
      await withSystemContext(orgId, () => markAsFailed(item.id, msg)).catch(
        () => {},
      );
    }
  }

  if (sent > 0 || failed > 0) {
    log.info({ enviadas: sent, falhas: failed }, "[scheduled-messages] tick concluído");
  }
  return { processed: due.length, sent, failed };
}

type DueItem = Awaited<ReturnType<typeof listDueScheduledMessages>>[number];

async function dispatchOne(item: DueItem) {
  const conv = item.conversation;
  if (!conv) {
    await markAsFailed(item.id, "Conversa removida antes do envio");
    return;
  }

  const channelLower = conv.channel?.toLowerCase() ?? "";
  const isWhatsApp =
    channelLower === "whatsapp" ||
    channelLower === "whatsapp_meta" ||
    channelLower === "meta_whatsapp";

  if (!isWhatsApp) {
    await markAsFailed(
      item.id,
      `Canal "${conv.channel ?? "desconhecido"}" ainda não suportado para envio agendado`,
    );
    return;
  }

  // Busca provider do canal para decidir Meta vs Baileys.
  const channelRef = conv.channelId
    ? await prisma.channel.findUnique({
        where: { id: conv.channelId },
        select: { id: true, provider: true, config: true },
      })
    : null;

  const isBaileys = channelRef?.provider === "BAILEYS_MD";

  // Sessão 24h: só aplica a canais Meta. Baileys mantém chat ativo sem
  // essa janela, então não precisa de template fallback.
  let mustUseTemplate = false;
  if (!isBaileys) {
    const lastInboundAt = conv.lastInboundAt ?? null;
    const sessionActive =
      lastInboundAt !== null &&
      Date.now() - new Date(lastInboundAt).getTime() < SESSION_WINDOW_MS;
    mustUseTemplate = !sessionActive;
  }

  const senderName = item.createdBy?.name ?? "Agente (agendado)";

  if (mustUseTemplate) {
    if (!item.fallbackTemplateName) {
      await markAsFailed(
        item.id,
        "Sessão de 24h expirada e nenhum template fallback configurado",
      );
      return;
    }
    await sendViaMetaTemplate(item, conv, channelRef, senderName);
  } else if (isBaileys || channelRef) {
    await sendViaText(item, channelRef, senderName);
  } else {
    // Fallback: canal WhatsApp sem Channel configurado → tenta Meta global.
    await sendViaText(item, null, senderName);
  }

  await markAsSent(item.id, { sentMessageId: null });
}

async function sendViaText(
  item: DueItem,
  channelRef: { id: string; provider: string; config: unknown } | null,
  senderName: string,
) {
  const conv = item.conversation!;
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      content: item.content,
      direction: "out",
      messageType: "text",
      senderName,
    }),
  });

  const result = await sendWhatsAppText({
    conversationId: conv.id,
    contactId: conv.contactId,
    channelRef: channelRef
      ? { id: channelRef.id, provider: channelRef.provider }
      : null,
    content: item.content,
    messageId: saved.id,
    waJid: conv.waJid,
  });

  if (result.failed) {
    // Atualiza a Message para refletir falha antes de propagar o erro.
    await prisma.message
      .update({
        where: { id: saved.id },
        data: { sendStatus: "failed", sendError: result.error ?? "send failed" },
      })
      .catch(() => {});
    throw new Error(result.error ?? "Envio WhatsApp falhou");
  }

  await prisma.conversation
    .update({
      where: { id: conv.id },
      data: {
        lastMessageDirection: "out",
        hasAgentReply: true,
        hasError: false,
      },
    })
    .catch(() => {});

  // Atualiza o sentMessageId no agendamento para auditoria.
  await prisma.scheduledMessage
    .update({
      where: { id: item.id },
      data: { sentMessageId: saved.id },
    })
    .catch(() => {});
}

async function sendViaMetaTemplate(
  item: DueItem,
  conv: NonNullable<DueItem["conversation"]>,
  channelRef: { id: string; provider: string; config: unknown } | null,
  senderName: string,
) {
  const client = channelRef
    ? metaClientFromConfig(channelRef.config as Record<string, unknown> | null | undefined)
    : metaWhatsApp;

  if (!client.configured) {
    throw new Error("Meta WhatsApp API não configurada para enviar template");
  }

  const contact = await prisma.contact.findUnique({
    where: { id: conv.contactId },
    select: { phone: true, whatsappBsuid: true },
  });
  const digits = contact?.phone?.replace(/\D/g, "") ?? "";
  const to = digits.length >= 8 ? digits : undefined;
  const recipient = contact?.whatsappBsuid?.trim() || undefined;
  if (!to && !recipient) {
    throw new Error("Contato sem telefone nem BSUID WhatsApp");
  }

  const templateName = item.fallbackTemplateName!;
  const languageCode = item.fallbackTemplateLanguage ?? "pt_BR";
  const components =
    item.fallbackTemplateParams && typeof item.fallbackTemplateParams === "object"
      ? (item.fallbackTemplateParams as { components?: unknown[] }).components ??
        (Array.isArray(item.fallbackTemplateParams) ? (item.fallbackTemplateParams as unknown[]) : undefined)
      : undefined;

  let templateGraphId: string | null = null;
  // Capturar `id` aqui (única query — antes eram 2) para vincular a
  // mensagem outbound ao template config via `templateConfigId`. Sem isso,
  // respostas de Flow enviadas via fallback agendado seriam roteadas para
  // o flow errado pelo resolver de Flow inbound.
  let templateConfigId: string | null = null;
  let templateCategory: string | null = null;
  try {
    const tc = await prisma.whatsAppTemplateConfig.findFirst({
      where: { metaTemplateName: templateName },
      select: { id: true, metaTemplateId: true, category: true },
    });
    templateGraphId = tc?.metaTemplateId?.trim() || null;
    templateConfigId = tc?.id ?? null;
    templateCategory = tc?.category ?? null;
  } catch {
    /* ignore */
  }

  const enrichResult = await enrichTemplateComponentsForFlowSend(client, {
    templateName,
    languageCode,
    components: components as unknown[] | undefined,
    templateGraphId,
  });

  const result = await client.sendTemplate(
    to,
    templateName,
    languageCode,
    enrichResult.components,
    recipient,
  );
  const externalId = result.messages?.[0]?.id ?? null;

  // `item.content` é o texto que o usuário digitou ao agendar — guardamos
  // como bodyPreview para o label da mensagem no inbox ficar significativo
  // ("Template: nome — 'Olá, sua consulta é amanhã...' ") em vez de só o nome.
  const messageContent = buildOutboundTemplateMessageContent(
    templateName,
    "generic",
    templateCategory,
    item.content,
  );

  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      content: messageContent,
      direction: "out",
      messageType: "template",
      senderName,
      ...(externalId ? { externalId } : {}),
      ...(typeof enrichResult.flowToken === "string" && enrichResult.flowToken.trim()
        ? { flowToken: enrichResult.flowToken.trim() }
        : {}),
      ...(templateConfigId ? { templateConfigId } : {}),
    }),
  });

  await prisma.conversation
    .update({
      where: { id: conv.id },
      data: {
        lastMessageDirection: "out",
        hasAgentReply: true,
        hasError: false,
      },
    })
    .catch(() => {});

  await prisma.scheduledMessage
    .update({
      where: { id: item.id },
      data: { sentMessageId: saved.id },
    })
    .catch(() => {});
}
