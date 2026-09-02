/**
 * Ações operacionais do agente de IA ("piloting") — lado do servidor.
 *
 * Reúnem duas primitivas compartilhadas entre o `inbox-handler`
 * (resposta a mensagens inbound) e o `ai-agent-inactivity-worker`
 * (varredura de silêncio do cliente):
 *
 *  - `sendAgentMessage`    — persiste + envia uma mensagem OUT pelo
 *    canal da conversa. Respeita `autonomyMode` (se DRAFT, grava como
 *    rascunho pro operador humano aprovar).
 *  - `executeAgentHandoff` — transfere a conversa para humano
 *    conforme o modo configurado (KEEP_OWNER / SPECIFIC_USER /
 *    UNASSIGN), registra activity + evento de deal e publica SSE.
 *
 * Mantemos isso FORA de `tools.ts` porque aqui o handoff é disparado
 * sem passar pelo LLM (evento determinístico).
 */

import type { AIAgentAutonomy } from "@prisma/client";

import {
  computeTypingDelayMs,
  renderTemplate,
} from "@/lib/ai-agents/piloting";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";
import { sseBus } from "@/lib/sse-bus";
import { botOutboundReplyMark } from "@/lib/conversation-reply-marking";
import { createActivity } from "@/services/activities";
import { logEvent } from "@/services/activity-log";
import { createDealEvent } from "@/services/deals";
import { createConversationEvent } from "@/services/conversation-events";
import { rewriteMismatchedDaypartWish } from "@/services/ai/idle-followup";

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
export type HumanBehaviorConfig = {
  simulateTyping: boolean;
  typingPerCharMs: number;
  markMessagesRead: boolean;
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
   * e o aluno fica sem resposta.
   */
  bypassAssigneeCheck?: boolean;
}): Promise<SendAgentMessageResult> {
  const text = rewriteMismatchedDaypartWish(args.text.trim());
  if (!text) return { status: "skipped", reason: "empty" };

  // Anti-spam: não reenvia a mesma informação se o bot já disse algo
  // muito parecido nos últimos minutos (fila/conexão ou overlap alto).
  try {
    const { isNearDuplicateBotText } = await import(
      "@/services/ai/human-queue-policy"
    );
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
        (m) => m.content && isNearDuplicateBotText(text, m.content),
      )
    ) {
      return { status: "skipped", reason: "near_duplicate" };
    }
  } catch {
    /* best-effort */
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
    const { assertAiStillAuthorized } = await import(
      "@/services/ai/inbox-handler"
    );
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
  // o agente IA da DNA enviava via numero da Eduit (singleton global env).
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
        const delayMs = computeTypingDelayMs(text.length, typingPerCharMs);
        await sleep(delayMs);
      } else if (inboundWamid && markMessagesRead) {
        try {
          await metaClient.markAsRead(inboundWamid);
        } catch (err) {
          console.warn(
            `[ai-piloting] markAsRead falhou conv=${args.conversationId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    if (!args.bypassAssigneeCheck) {
      const { assertAiStillAuthorized } = await import(
        "@/services/ai/inbox-handler"
      );
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
    try {
      const send = await metaClient.sendText(contact.phone, text);
      externalId = send.messages?.[0]?.id ?? null;
    } catch (err) {
      console.error(
        `[ai-piloting] envio autônomo falhou conv=${args.conversationId}: ${err}. Gravando rascunho.`,
      );
      return saveDraft(args.conversationId, args.agentUserId, text);
    }

    const saved = await prisma.message.create({
      data: withOrgFromCtx({
        conversationId: args.conversationId,
        channelId: conv?.channelRef?.id ?? undefined,
        content: text,
        direction: "out",
        messageType: "text",
        authorType: "bot",
        aiAgentUserId: args.agentUserId,
        senderName: "Agente IA",
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
    sseBus.publish("new_message", {
      organizationId: getOrgIdOrNull(),
      conversationId: args.conversationId,
      contactId: args.contactId,
      direction: "out",
      content: text,
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
        const { assertAiStillAuthorized } = await import(
          "@/services/ai/inbox-handler"
        );
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
          senderName: "Agente IA",
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
      sseBus.publish("new_message", {
        organizationId: getOrgIdOrNull(),
        conversationId: args.conversationId,
        contactId: args.contactId,
        direction: "out",
        content: text,
        timestamp: saved.createdAt,
      });
      return { status: "sent", messageId: saved.id };
    } catch (err) {
      console.warn(
        `[ai-piloting] Baileys send falhou conv=${args.conversationId}:`,
        err instanceof Error ? err.message : err,
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
  sseBus.publish("new_message", {
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
export async function agentHasEverRepliedInConversation(
  conversationId: string,
  agentUserId: string,
): Promise<boolean> {
  const existing = await prisma.message.findFirst({
    where: {
      conversationId,
      authorType: "bot",
      aiAgentUserId: agentUserId,
    },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Retorna true se o agente IA já disparou a saudação na atribuição
 * ATUAL da conversa. Usa `Conversation.aiGreetedAt`, que é setada
 * quando a saudação é enviada e RESETADA quando a conversa muda
 * de `assignedToId`.
 */
export async function hasAgentGreetedInCurrentAssignment(
  conversationId: string,
): Promise<boolean> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { aiGreetedAt: true },
  });
  if (row?.aiGreetedAt != null) return true;

  // Fallback: qualquer outbound do bot nesta conversa conta como
  // já saudou — evita reenviar openingMessage após handoff.
  const botOut = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: "out",
      authorType: "bot",
      isPrivate: false,
      messageType: { not: "note" },
    },
    select: { id: true },
  });
  return botOut != null;
}

/**
 * Marca que o agente IA cumprimentou nesta atribuição. Chamado logo
 * depois de `sendAgentMessage({ kind: "greeting" })` retornar com sucesso.
 */
export async function markAgentGreetedNow(
  conversationId: string,
): Promise<void> {
  await prisma.conversation
    .update({
      where: { id: conversationId },
      data: { aiGreetedAt: new Date() },
    })
    .catch(() => null);
}

// ── Saudação proativa (handoff entrando) ───────────────────────

export type TriggerOpeningResult =
  | { status: "sent"; messageId: string; conversationId: string }
  | { status: "draft"; messageId: string; conversationId: string }
  | {
      status: "skipped";
      reason:
        | "no_conversation"
        | "not_ai_agent"
        | "agent_inactive"
        | "no_opening_message"
        | "already_greeted"
        | "off_hours"
        | "no_contact";
    };

/**
 * Dispara a mensagem de saudação do agente IA PROATIVAMENTE — sem
 * precisar esperar o cliente mandar algo. Usado pelo executor de
 * automações no passo `transfer_to_ai_agent`: assim que a conversa
 * é atribuída ao agente, ele já se apresenta no chat do cliente
 * (em vez de ficar mudo até a primeira inbound, que pode nunca vir).
 *
 * A função é idempotente via `Conversation.aiGreetedAt` — se já
 * cumprimentou na atribuição atual, retorna `already_greeted` e
 * não duplica.
 *
 * Respeita business hours: fora do horário, envia `offHoursMessage`
 * se configurada e NÃO marca `aiGreetedAt` (pra saudar de verdade
 * na volta ao horário, via próxima inbound do cliente).
 */
export async function triggerAgentOpeningForContact(args: {
  contactId: string;
  agentUserId: string;
  channel?: "meta" | "baileys" | null;
}): Promise<TriggerOpeningResult> {
  // Usa a conversa aberta mais recente do contato. Na prática, o CRM
  // mantém 1 conversa por contato para canais (Meta/Baileys), então
  // isso resolve ao único canal ativo dele.
  const conversation = await prisma.conversation.findFirst({
    where: { contactId: args.contactId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, assignedToId: true, aiGreetedAt: true },
  });
  if (!conversation) {
    return { status: "skipped", reason: "no_conversation" };
  }

  const assignee = await prisma.user.findUnique({
    where: { id: args.agentUserId },
    select: {
      id: true,
      type: true,
      aiAgentConfig: {
        select: {
          active: true,
          autonomyMode: true,
          openingMessage: true,
          openingDelayMs: true,
          businessHours: true,
          simulateTyping: true,
          typingPerCharMs: true,
          markMessagesRead: true,
        },
      },
    },
  });
  if (!assignee || assignee.type !== "AI") {
    return { status: "skipped", reason: "not_ai_agent" };
  }
  const cfg = assignee.aiAgentConfig;
  if (!cfg?.active) {
    return { status: "skipped", reason: "agent_inactive" };
  }
  if (!cfg.openingMessage?.trim()) {
    return { status: "skipped", reason: "no_opening_message" };
  }
  if (await hasAgentGreetedInCurrentAssignment(conversation.id)) {
    return { status: "skipped", reason: "already_greeted" };
  }

  // Business hours gate — se fora, não dispara a saudação proativa.
  // Preferimos ficar em silêncio até a volta ao horário (a mensagem
  // offHours é pra RESPOSTA a inbound, não pra empurrar quando a
  // automação plantou o contato na conversa).
  const { isWithinBusinessHours, normalizeBusinessHours } = await import(
    "@/lib/ai-agents/piloting"
  );
  const bh = normalizeBusinessHours(cfg.businessHours);
  if (bh?.enabled && !isWithinBusinessHours(bh)) {
    return { status: "skipped", reason: "off_hours" };
  }

  // Contexto pra template da saudação ({{contactName}}, {{dealTitle}},
  // {{stageName}}). Reusa a MESMA mecânica do inbox-handler para que
  // a saudação fique visualmente idêntica quando disparada pelos dois
  // caminhos (automação vs. inbound).
  const [contact, openDeal] = await Promise.all([
    prisma.contact.findUnique({
      where: { id: args.contactId },
      select: { name: true },
    }),
    prisma.deal.findFirst({
      where: { contactId: args.contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { title: true, stage: { select: { name: true } } },
    }),
  ]);
  if (!contact) {
    return { status: "skipped", reason: "no_contact" };
  }

  const greeting = renderTemplate(cfg.openingMessage, {
    contactName: contact.name,
    dealTitle: openDeal?.title ?? null,
    stageName: openDeal?.stage?.name ?? null,
  });

  if (cfg.openingDelayMs > 0) {
    await sleep(Math.min(cfg.openingDelayMs, 10_000));
  }

  const result = await sendAgentMessage({
    conversationId: conversation.id,
    contactId: args.contactId,
    agentUserId: assignee.id,
    autonomyMode: cfg.autonomyMode,
    text: greeting,
    channel: args.channel ?? "meta",
    kind: "greeting",
    humanBehavior: {
      simulateTyping: cfg.simulateTyping,
      typingPerCharMs: cfg.typingPerCharMs,
      markMessagesRead: cfg.markMessagesRead,
    },
  });

  if (result.status !== "skipped") {
    await markAgentGreetedNow(conversation.id);
  }

  if (result.status === "sent") {
    return {
      status: "sent",
      messageId: result.messageId,
      conversationId: conversation.id,
    };
  }
  if (result.status === "draft") {
    return {
      status: "draft",
      messageId: result.messageId,
      conversationId: conversation.id,
    };
  }
  return { status: "skipped", reason: "no_contact" };
}

// ── Handoff ────────────────────────────────────────────────────

export type HandoffMode = "KEEP_OWNER" | "SPECIFIC_USER" | "UNASSIGN";

export type HandoffArgs = {
  conversationId: string;
  contactId: string | null;
  dealId: string | null;
  agentId: string;
  agentUserId: string;
  mode: HandoffMode;
  specificUserId?: string | null;
  reason: string;
};

/**
 * Executa o handoff determinístico. Retorna o userId que recebeu a
 * conversa (null se ficou em fila).
 */
export async function executeAgentHandoff(
  args: HandoffArgs,
): Promise<{ assignedToId: string | null }> {
  let newAssignee: string | null = null;

  if (args.mode === "SPECIFIC_USER" && args.specificUserId) {
    const exists = await prisma.user.findUnique({
      where: { id: args.specificUserId },
      select: { id: true, type: true },
    });
    if (exists && exists.type !== "AI") {
      newAssignee = exists.id;
    }
  } else if (args.mode === "KEEP_OWNER" && args.dealId) {
    const deal = await prisma.deal.findUnique({
      where: { id: args.dealId },
      select: { ownerId: true },
    });
    // Só mantém o dono se não for o próprio user IA (evita ficar em loop).
    if (deal?.ownerId && deal.ownerId !== args.agentUserId) {
      newAssignee = deal.ownerId;
    }
  }

  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: {
      assignedToId: newAssignee,
      // Reseta o marcador de saudação — se a conversa voltar pro
      // agente IA depois, ele cumprimenta de novo.
      aiGreetedAt: null,
      updatedAt: new Date(),
    },
  });

  if (args.contactId) {
    await createActivity({
      type: "NOTE",
      title: "Transferência IA → humano",
      description: args.reason,
      completed: true,
      contactId: args.contactId,
      dealId: args.dealId ?? undefined,
      userId: args.agentUserId,
      createdById: args.agentUserId,
    }).catch(() => null);
  }

  if (args.dealId) {
    createDealEvent(args.dealId, args.agentUserId, "AI_AGENT_ACTION", {
      action: "transferred_to_human",
      agentId: args.agentId,
      mode: args.mode,
      assignedToId: newAssignee,
      reason: args.reason,
    }).catch(() => null);
  }

  sseBus.publish(newAssignee ? "conversation_assigned" : "conversation_unassigned", {
    organizationId: getOrgIdOrNull(),
    conversationId: args.conversationId,
    contactId: args.contactId,
    assignedToId: newAssignee,
    reason: args.reason,
  });

  void logEvent({
    type: "AI_AGENT_HANDOFF",
    entityType: "CONVERSATION",
    entityId: args.conversationId,
    conversationId: args.conversationId,
    contactId: args.contactId ?? null,
    dealId: args.dealId ?? null,
    meta: { mode: args.mode, assignedToId: newAssignee, reason: args.reason },
    actor: { type: "AUTOMATION", label: "Agente IA" },
  });

  return { assignedToId: newAssignee };
}
