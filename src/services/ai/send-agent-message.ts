/**
 * Envio de mensagem pelo agente de IA: marca como lida, "digitando…"
 * proporcional ao texto, texto ou mensagem interativa (botões/lista),
 * registro da mensagem e eventos da conversa. Usado pelo motor v2.
 */

import type { AIAgentAutonomy } from "@prisma/client";

import { computeTypingDelayMs, typingDelayWithinBudget } from "@/lib/typing-delay";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { touchChatLastMessageAt } from "@/lib/conversation-last-message";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  isReplaySandboxActive,
  recordBlockedEffect,
} from "@/services/ai/replay-sandbox";
import { getOrgIdOrNull } from "@/lib/request-context";
import {
  publishConversationAssignment,
  publishNewMessage,
} from "@/lib/realtime-events";
import { botOutboundReplyMark } from "@/lib/conversation-reply-marking";

async function aiSenderName(agentUserId: string): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: agentUserId },
    select: { name: true },
  });
  return u?.name?.trim() || "Agente IA";
}
import { createConversationEvent } from "@/services/conversation-events";
import { rewriteMismatchedDaypartWish } from "@/lib/daypart-wish";
import { cache } from "@/lib/cache";
import { getLogger } from "@/lib/logger";

/**
 * Confirma que a conversa ainda está com um agente IA ativo e que
 * nenhum humano respondeu depois do início do processamento.
 */
export async function assertAiStillAuthorized(args: {
  conversationId: string;
  expectedAgentUserId: string;
  generationId?: string;
  since?: Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (args.generationId) {
    const current = await cache.get<string>(`ai:gen:${args.conversationId}`);
    if (current && current !== args.generationId) {
      return { ok: false, reason: "generation_superseded" };
    }
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      assignedToId: true,
      hasHumanReply: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!conversation?.assignedToId) {
    return { ok: false, reason: "unassigned" };
  }
  if (conversation.assignedToId !== args.expectedAgentUserId) {
    return { ok: false, reason: "assignee_changed" };
  }
  if (conversation.assignedTo?.type !== "AI") {
    return { ok: false, reason: "assignee_not_ai" };
  }

  // Humano falou depois do início deste processamento?
  if (args.since) {
    const humanOut = await prisma.message.findFirst({
      where: {
        conversationId: args.conversationId,
        direction: "out",
        authorType: "human",
        isPrivate: false,
        createdAt: { gte: args.since },
      },
      select: { id: true },
    });
    if (humanOut) return { ok: false, reason: "human_replied_during_run" };
  }

  return { ok: true };
}

const log = getLogger("ai.send-agent-message");

/**
 * Busca o wamid (externalId) da mensagem INBOUND mais recente da
 * conversa — necessário porque os endpoints Meta de "digitando…" e
 * "lido" só aceitam referenciar uma mensagem que O NEGÓCIO recebeu.
 *
 * A Meta só aceita o indicador/leitura se a mensagem tiver sido
 * recebida nos últimos ~30 segundos; acima disso a chamada falha
 * silenciosamente (por isso o `try/catch` nos helpers do cliente).
 */
async function getLatestInboundWamid(
  conversationId: string,
): Promise<string | null> {
  const row = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: "in",
      externalId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: { externalId: true },
  });
  return row?.externalId ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


export type SendAgentMessageResult =
  | { status: "sent"; messageId: string }
  | { status: "draft"; messageId: string }
  | { status: "skipped"; reason: string };

/**
 * Envia uma mensagem OUT em nome do agente. Para AUTONOMOUS + canal
 * Meta WhatsApp configurado, envia direto; caso contrário, grava
 * rascunho pro operador revisar.
 *
 * Não tenta fallback para Baileys (as rotinas de piloting rodam
 * fora do escopo do usuário logado — seria necessário resolver a
 * sessão Baileys correta por tenant, o que é escopo futuro).
 */
/**
 * Botões/lista do WhatsApp. `text` continua sendo a versão em texto
 * (opções numeradas): vale fora da Meta, em rascunho e se o envio
 * interativo for recusado.
 */
export type AgentInteractiveMessage = {
  kind: "buttons" | "list";
  /** Enviado antes, quando a resposta não cabe no corpo interativo. */
  leadText?: string;
  body: string;
  options: Array<{ id: string; title: string; description?: string }>;
  listButton: string;
  /** Conteúdo registrado na conversa. */
  displayContent: string;
};

export type HumanBehaviorConfig = {
  simulateTyping: boolean;
  typingPerCharMs: number;
  markMessagesRead: boolean;
  /** Teto do "digitando…" (ms). Sem valor: o da fórmula (até 25 s). */
  maxTypingMs?: number;
  /** Início do turno (epoch ms): o tempo já gasto sai do "digitando…". */
  turnStartedAt?: number;
  /**
   * Conferido depois do "digitando…": true → não envia (motivo
   * "superseded"). Ex.: saudação quando o cliente já mandou o pedido.
   */
  abortIf?: () => Promise<boolean>;
};

export async function sendAgentMessage(args: {
  conversationId: string;
  contactId: string;
  agentUserId: string;
  autonomyMode: AIAgentAutonomy;
  text: string;
  channel?: "meta" | "baileys" | null;
  /// Marcador de tipo pra distinguir no inbox (greeting / farewell / off_hours).
  kind?: "text" | "greeting" | "farewell" | "off_hours";
  /// Comportamento humano opcional: simula digitando + read receipts.
  /// Só tem efeito em AUTONOMOUS + meta + phoneNumberId válido.
  humanBehavior?: HumanBehaviorConfig;
  generationId?: string;
  /**
   * Após handoff a tool já limpa o assignee. Sem este bypass a mensagem
   * de "vou te transferir" morre no assertAiStillAuthorized (unassigned)
   * e o contato fica sem resposta.
   */
  bypassAssigneeCheck?: boolean;
  /**
   * Resposta a um comando explícito do operador. O anti-spam existe para o
   * agente não repetir informação que ninguém pediu; confirmação de comando
   * é o oposto — repetir `#iniciar` deve confirmar de novo, e sem isto a
   * segunda confirmação (que só muda o horário) morre como near-duplicate.
   */
  bypassDuplicateGuard?: boolean;
  /**
   * Trechos que o anti-spam não conta ao comparar (fecho configurado, igual
   * de propósito em várias respostas).
   */
  dedupeIgnore?: readonly string[];
  interactive?: AgentInteractiveMessage;
}): Promise<SendAgentMessageResult> {
  const text = rewriteMismatchedDaypartWish(args.text.trim());
  if (!text) return { status: "skipped", reason: "empty" };

  // Replay com handoff real: a mensagem fica só como rascunho na conversa
  // de sandbox (apagada no fim); nenhum provedor é chamado. Antes de
  // qualquer checagem de canal, para não depender de o sandbox estar
  // desconectado por acaso.
  if (isReplaySandboxActive()) {
    recordBlockedEffect("outbound_send", `agent_message:${args.conversationId}`);
    return saveDraft(args.conversationId, args.agentUserId, text);
  }

  // Anti-spam: não reenvia a mesma informação se o bot já disse algo
  // muito parecido nos últimos minutos (fila/conexão ou overlap alto).
  if (!args.bypassDuplicateGuard) {
    try {
      const { isNearDuplicateBotText, isNearDuplicateBotTextIgnoring } =
        await import("@/services/ai/human-queue-policy");
      const ignore = args.dedupeIgnore ?? [];
      const sameAs = (existing: string) =>
        ignore.length > 0
          ? isNearDuplicateBotTextIgnoring(text, existing, ignore)
          : isNearDuplicateBotText(text, existing);
      const recentBot = await prisma.message.findMany({
        where: {
          conversationId: args.conversationId,
          direction: "out",
          authorType: "bot",
          isPrivate: false,
          messageType: { not: "note" },
          createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { content: true },
      });
      if (
        recentBot.some(
          (m) => m.content && sameAs(m.content),
        )
      ) {
        return { status: "skipped", reason: "near_duplicate" };
      }
    } catch {
      /* best-effort */
    }
  }

  // Kill-switch absoluto: não envia WhatsApp fora da allowlist.
  try {
    const { isContactAllowedForAi } = await import(
      "@/services/ai/phone-allowlist"
    );
    const allowed = await isContactAllowedForAi(args.contactId);
    if (!allowed) {
      return { status: "skipped", reason: "phone_allowlist" };
    }
  } catch {
    return { status: "skipped", reason: "phone_allowlist_error" };
  }

  try {
    const convCh = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: {
        channelRef: { select: { status: true, name: true } },
      },
    });
    if (convCh?.channelRef && convCh.channelRef.status !== "CONNECTED") {
      return { status: "skipped", reason: "channel_not_connected" };
    }
  } catch {
    /* se o canal não carregar, segue o fluxo existente */
  }

  // Revalida autorização imediatamente antes de qualquer envio.
  if (!args.bypassAssigneeCheck) {
    const auth = await assertAiStillAuthorized({
      conversationId: args.conversationId,
      expectedAgentUserId: args.agentUserId,
      generationId: args.generationId,
    });
    if (!auth.ok) {
      return { status: "skipped", reason: auth.reason };
    }
  } else {
    // Ainda bloqueia se humano já assumiu e respondeu nesta conversa.
    const lastOut = await prisma.message.findFirst({
      where: {
        conversationId: args.conversationId,
        direction: "out",
        isPrivate: false,
        messageType: { not: "note" },
      },
      orderBy: { createdAt: "desc" },
      select: { authorType: true },
    });
    if (lastOut?.authorType === "human") {
      return { status: "skipped", reason: "human_last_outbound" };
    }
  }

  const isMeta = args.channel === "meta" || args.channel == null;
  const isBaileys = args.channel === "baileys";

  // Resolve cliente Meta DESTE canal (token/phoneId do tenant). Sem isso,
  // o agente IA de uma org enviava pelo número de outra (singleton global env).
  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      channelId: true,
      channelRef: { select: { id: true, config: true, provider: true } },
      waJid: true,
    },
  });
  const channelConfig = conv?.channelRef?.config as
    | Record<string, unknown>
    | null
    | undefined;
  const metaClient = metaClientFromConfig(channelConfig);

  if (args.autonomyMode === "AUTONOMOUS" && isMeta && metaClient.configured) {
    const contact = await prisma.contact.findUnique({
      where: { id: args.contactId },
      select: { phone: true },
    });
    if (!contact?.phone) {
      return saveDraft(args.conversationId, args.agentUserId, text);
    }

    // ── Comportamento humano: typing + read ANTES de enviar ─────
    if (args.humanBehavior) {
      const { simulateTyping, typingPerCharMs, markMessagesRead } =
        args.humanBehavior;
      const inboundWamid = await getLatestInboundWamid(args.conversationId);

      if (inboundWamid && simulateTyping) {
        await metaClient.sendTypingIndicator(inboundWamid);
        const delayMs = typingDelayWithinBudget(
          computeTypingDelayMs(text.length, typingPerCharMs),
          args.humanBehavior,
        );
        await sleep(delayMs);
      } else if (inboundWamid && markMessagesRead) {
        try {
          await metaClient.markAsRead(inboundWamid);
        } catch (err) {
          log.warn(
            { conv: args.conversationId, err: err instanceof Error ? err.message : err },
            "[ai-send] markAsRead falhou",
          );
        }
      }
    }

    if (args.humanBehavior?.abortIf) {
      let abort = false;
      try {
        abort = await args.humanBehavior.abortIf();
      } catch {
        abort = false;
      }
      if (abort) return { status: "skipped", reason: "superseded" };
    }

    if (!args.bypassAssigneeCheck) {
      const auth2 = await assertAiStillAuthorized({
        conversationId: args.conversationId,
        expectedAgentUserId: args.agentUserId,
        generationId: args.generationId,
      });
      if (!auth2.ok) {
        return { status: "skipped", reason: auth2.reason };
      }
    }

    let externalId: string | null = null;
    let sentInteractive = false;
    let leadSent = false;
    const iv = args.interactive;
    if (iv) {
      try {
        if (iv.leadText) {
          await metaClient.sendText(contact.phone, iv.leadText);
          leadSent = true;
        }
        const send =
          iv.kind === "buttons"
            ? await metaClient.sendInteractiveButtons(
                contact.phone,
                iv.body,
                iv.options.map((o) => ({ id: o.id, title: o.title })),
              )
            : await metaClient.sendInteractiveList(contact.phone, iv.body, iv.listButton, [
                { rows: iv.options },
              ]);
        externalId = send.messages?.[0]?.id ?? null;
        sentInteractive = true;
      } catch (err) {
        // Recusado (janela, formato): as opções seguem numeradas no texto.
        log.warn(
          { conv: args.conversationId, err },
          "[ai-send] envio interativo falhou. Enviando como texto.",
        );
      }
    }
    if (!sentInteractive) {
      try {
        const send = await metaClient.sendText(
          contact.phone,
          // O texto do corpo já saiu antes da falha: manda só as opções.
          leadSent && iv?.leadText && text.startsWith(iv.leadText)
            ? text.slice(iv.leadText.length).trim() || text
            : text,
        );
        externalId = send.messages?.[0]?.id ?? null;
      } catch (err) {
        log.error(
          { conv: args.conversationId, err },
          "[ai-send] envio autônomo falhou. Gravando rascunho.",
        );
        return saveDraft(args.conversationId, args.agentUserId, text);
      }
    }
    const savedContent = sentInteractive && iv ? iv.displayContent : text;

    const saved = await prisma.message.create({
      data: withOrgFromCtx({
        conversationId: args.conversationId,
        channelId: conv?.channelRef?.id ?? undefined,
        content: savedContent,
        direction: "out",
        messageType: sentInteractive ? "interactive" : "text",
        authorType: "bot",
        aiAgentUserId: args.agentUserId,
        senderName: await aiSenderName(args.agentUserId),
        externalId,
        sendStatus: "sent",
      }),
    });
    await prisma.conversation
      .update({
        where: { id: args.conversationId },
        data: {
          updatedAt: new Date(),
          ...(await botOutboundReplyMark()),
        },
      })
      .catch(() => null);
    await touchChatLastMessageAt({
      conversationId: args.conversationId,
      message: saved,
    }).catch(() => null);
    publishNewMessage({
      organizationId: getOrgIdOrNull(),
      conversationId: args.conversationId,
      contactId: args.contactId,
      direction: "out",
      content: savedContent,
      timestamp: saved.createdAt,
    });
    return { status: "sent", messageId: saved.id };
  }

  // Baileys: cria Message e enfileira no worker de outbound.
  if (args.autonomyMode === "AUTONOMOUS" && isBaileys) {
    try {
      const { enqueueBaileysOutbound } = await import("@/lib/queue");
      const contact = await prisma.contact.findUnique({
        where: { id: args.contactId },
        select: { phone: true },
      });
      const channelId = conv?.channelId ?? conv?.channelRef?.id ?? null;
      const target = conv?.waJid || contact?.phone || null;
      if (!channelId || !target) {
        return saveDraft(args.conversationId, args.agentUserId, text);
      }

      if (!args.bypassAssigneeCheck) {
        const authB = await assertAiStillAuthorized({
          conversationId: args.conversationId,
          expectedAgentUserId: args.agentUserId,
          generationId: args.generationId,
        });
        if (!authB.ok) {
          return { status: "skipped", reason: authB.reason };
        }
      }

      const saved = await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: args.conversationId,
          channelId,
          content: text,
          direction: "out",
          messageType: "text",
          authorType: "bot",
          aiAgentUserId: args.agentUserId,
          senderName: await aiSenderName(args.agentUserId),
          sendStatus: "pending",
        }),
      });

      await enqueueBaileysOutbound({
        channelId,
        to: target,
        content: text,
        messageType: "text",
        conversationId: args.conversationId,
        messageId: saved.id,
      });

      await prisma.conversation
        .update({
          where: { id: args.conversationId },
          data: {
            updatedAt: new Date(),
            ...(await botOutboundReplyMark()),
          },
        })
        .catch(() => null);
      await touchChatLastMessageAt({
        conversationId: args.conversationId,
        message: saved,
      }).catch(() => null);
      publishNewMessage({
        organizationId: getOrgIdOrNull(),
        conversationId: args.conversationId,
        contactId: args.contactId,
        direction: "out",
        content: text,
        timestamp: saved.createdAt,
      });
      return { status: "sent", messageId: saved.id };
    } catch (err) {
      log.warn(
        { conv: args.conversationId, err: err instanceof Error ? err.message : err },
        "[ai-send] Baileys send falhou",
      );
      return saveDraft(args.conversationId, args.agentUserId, text);
    }
  }

  return saveDraft(args.conversationId, args.agentUserId, text);
}

async function saveDraft(
  conversationId: string,
  agentUserId: string,
  text: string,
): Promise<SendAgentMessageResult> {
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId,
      content: text,
      direction: "out",
      messageType: "ai_draft",
      authorType: "bot",
      isPrivate: true,
      aiAgentUserId: agentUserId,
      senderName: "Agente IA (rascunho)",
      sendStatus: "draft",
    }),
  });
  publishNewMessage({
    organizationId: getOrgIdOrNull(),
    conversationId,
    direction: "out",
    messageType: "ai_draft",
    content: text,
    timestamp: saved.createdAt,
  });
  void createConversationEvent({
    conversationId,
    action: "ia",
    text: "Agente IA sugeriu resposta automática",
    actor: "Agente IA",
    authorType: "bot",
    dedupeStartsWith: ["Agente IA sugeriu"],
    dedupeWindowMs: 60_000,
  });
  return { status: "draft", messageId: saved.id };
}

/**
 * Retorna true se já existe pelo menos uma mensagem do agente
 * (authorType=bot + aiAgentUserId=agent) na conversa. Usado pra
 * decidir se a saudação inicial deve ser disparada.
 *
 * @deprecated — usar `hasAgentGreetedInCurrentAssignment`. Esse
 * helper via histórico de mensagens tinha o bug de bloquear saudação
 * eternamente após qualquer resposta anterior do agente, mesmo em
 * novas reatribuições.
 */
