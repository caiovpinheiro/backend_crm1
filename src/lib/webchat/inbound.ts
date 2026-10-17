/**
 * Inbound do webchat (visitante → inbox) — docs/decisoes/webchat-widget.md §3.5.
 *
 * Cópia disciplinada de `processEvent` (src/lib/meta-webhook/messaging-handler.ts)
 * com platform "webchat": mesma ordem de contato → gatilho → deal → ticket →
 * mensagem → SSE/push/gatilho/IA, para o inbox, a distribuição e as
 * automações enxergarem o webchat sem código novo.
 *
 * Roda dentro de `withSystemContext(organizationId)` (rota pública): o
 * `prisma` scoped injeta a org do canal.
 *
 * Idempotência: `externalId = "wc:{visitorId}:{clientMessageId}"` + unique
 * (organizationId, externalId) via `createMessageDedup`. Repetir o mesmo
 * `clientMessageId` devolve a mensagem já gravada sem novos efeitos.
 */
import { Prisma } from "@prisma/client";

import { touchInbound, warnTouchInboundFailed } from "@/lib/conversation-inbound";
import { noteMessageRowChange } from "@/lib/cache/message-versions";
import { getLogger } from "@/lib/logger";
import { createMessageDedup } from "@/lib/message-dedup";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { publishNewMessage } from "@/lib/realtime-events";
import { notifyInboundMessage } from "@/lib/web-push";
import { contactTrackingFromSession, type WebchatSessionRow } from "@/lib/webchat/session";
import { inheritContactAssigneeForNewTicket } from "@/services/ai/attendance-gate";
import { onInboundMessageForAi } from "@/services/ai/turn-manager";
import { ensureOpenDealForContact } from "@/services/auto-deals";
import {
  buildMessageTriggerData,
  emitConversationCreated,
  fireTrigger,
  openingMessageTriggerExtra,
} from "@/services/automation-triggers";
import { insertContactWithNextNumber, isPrismaUniqueViolation } from "@/services/contacts";
import {
  activeConversationOnAccountWhere,
  isActiveConversationUniqueViolation,
  withConversationNumberRetry,
} from "@/services/conversations";
import { maybeDistributeNewInboundTicket } from "@/services/distribution";

const log = getLogger("webchat-inbound");

/** `Conversation.channel` do webchat (minúsculo, como "whatsapp"). */
export const WEBCHAT_CONVERSATION_CHANNEL = "webchat";
const SOURCE_NAME = "Webchat";
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidClientMessageId(v: unknown): v is string {
  return typeof v === "string" && CLIENT_MESSAGE_ID_RE.test(v);
}

export function webchatExternalId(visitorId: string, clientMessageId: string): string {
  return `wc:${visitorId}:${clientMessageId}`;
}

/** Nome do contato anônimo: "Visitante a1b2c3". */
export function anonymousVisitorName(visitorId: string): string {
  return `Visitante ${visitorId.slice(-6)}`;
}

export type WebchatInboundMessage = {
  id: string;
  externalId: string | null;
  conversationId: string;
  content: string;
  createdAt: Date;
};

export type WebchatInboundResult = {
  duplicate: boolean;
  message: WebchatInboundMessage;
  conversationId: string;
  contactId: string;
};

const MESSAGE_SELECT = {
  id: true,
  externalId: true,
  conversationId: true,
  content: true,
  createdAt: true,
} as const;

// ── Contato do visitante ────────────────────────────────────────────

/**
 * Contato da sessão; sem contato ainda (visitante anônimo que só abriu o
 * chat), cria por `webchatVisitorId` e grava na sessão. Corrida (duas
 * primeiras mensagens juntas) cai no unique (org, webchatVisitorId).
 */
export async function ensureVisitorContact(
  session: WebchatSessionRow,
  fields: { name?: string | null; email?: string | null; phone?: string | null } = {},
): Promise<{ id: string; name: string; isNew: boolean }> {
  if (session.contactId) {
    const existing = await prisma.contact.findUnique({
      where: { id: session.contactId },
      select: { id: true, name: true },
    });
    if (existing) return { ...existing, isNew: false };
  }

  const byVisitor = await prisma.contact.findFirst({
    where: { webchatVisitorId: session.id },
    select: { id: true, name: true },
  });
  let contact: { id: string; name: string; isNew: boolean };
  if (byVisitor) {
    contact = { ...byVisitor, isNew: false };
  } else {
    try {
      const created = await insertContactWithNextNumber(
        {
          name: fields.name?.trim() || anonymousVisitorName(session.id),
          ...(fields.email ? { email: fields.email } : {}),
          ...(fields.phone ? { phone: fields.phone } : {}),
          webchatVisitorId: session.id,
          lifecycleStage: "LEAD",
          source: SOURCE_NAME,
          ...contactTrackingFromSession(session),
        } as Omit<Prisma.ContactUncheckedCreateInput, "number" | "organizationId">,
        { id: true, name: true },
      );
      contact = { ...(created as { id: string; name: string }), isNew: true };
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err;
      const won = await prisma.contact.findFirst({
        where: { webchatVisitorId: session.id },
        select: { id: true, name: true },
      });
      if (!won) throw err;
      contact = { ...won, isNew: false };
    }
  }

  await prisma.webchatSession.update({
    where: { id: session.id },
    data: { contactId: contact.id },
  });
  session.contactId = contact.id;

  if (contact.isNew) {
    fireTrigger("contact_created", {
      contactId: contact.id,
      data: { source: SOURCE_NAME, channel: SOURCE_NAME },
    }).catch((err) => log.warn({ err }, "Falha no gatilho contact_created"));
  }
  return contact;
}

// ── Ticket ──────────────────────────────────────────────────────────

/** Mesma regra de `findOrCreateConversation` do Messenger/Instagram. */
export async function findOrCreateWebchatConversation(
  contactId: string,
  channelId: string,
  opening?: { content?: string | null; messageType?: string | null },
): Promise<{ id: string; assignedToId: string | null; created: boolean }> {
  const findOnAccount = (accountId: string | null) =>
    prisma.conversation.findFirst({
      where: activeConversationOnAccountWhere({
        contactId,
        channel: WEBCHAT_CONVERSATION_CHANNEL,
        channelId: accountId,
      }),
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, channelId: true, assignedToId: true },
    });

  const existing = await findOnAccount(channelId);
  if (existing) {
    await maybeDistributeNewInboundTicket({
      conversationId: existing.id,
      contactId,
      assignedToId: existing.assignedToId ?? null,
    });
    return { id: existing.id, assignedToId: existing.assignedToId ?? null, created: false };
  }

  const orphan = await findOnAccount(null);
  if (orphan) {
    await prisma.conversation.update({ where: { id: orphan.id }, data: { channelId } });
    await maybeDistributeNewInboundTicket({
      conversationId: orphan.id,
      contactId,
      assignedToId: orphan.assignedToId ?? null,
    });
    return { id: orphan.id, assignedToId: orphan.assignedToId ?? null, created: false };
  }

  const inheritAssignee = await inheritContactAssigneeForNewTicket(contactId);
  try {
    const created = await withConversationNumberRetry((number) =>
      prisma.conversation.create({
        data: withOrgFromCtx({
          number,
          contactId,
          channel: WEBCHAT_CONVERSATION_CHANNEL,
          channelId,
          status: "OPEN" as const,
          ...(inheritAssignee ? { assignedToId: inheritAssignee } : {}),
        }),
        select: { id: true, assignedToId: true },
      }),
    );
    await maybeDistributeNewInboundTicket({
      conversationId: created.id,
      contactId,
      assignedToId: inheritAssignee,
    });
    emitConversationCreated({
      contactId,
      channel: WEBCHAT_CONVERSATION_CHANNEL,
      channelId,
      conversationId: created.id,
      source: "inbound_webchat",
      extra: openingMessageTriggerExtra({
        content: opening?.content,
        messageType: opening?.messageType,
      }),
    });
    return {
      id: created.id,
      assignedToId: created.assignedToId ?? inheritAssignee,
      created: true,
    };
  } catch (err) {
    if (isActiveConversationUniqueViolation(err)) {
      const won = await findOnAccount(channelId);
      if (won) return { id: won.id, assignedToId: won.assignedToId ?? null, created: false };
    }
    throw err;
  }
}

// ── Mensagem ────────────────────────────────────────────────────────

export async function processWebchatInbound(args: {
  organizationId: string;
  channelId: string;
  session: WebchatSessionRow;
  clientMessageId: string;
  content: string;
  now?: Date;
}): Promise<WebchatInboundResult> {
  const { organizationId, channelId, session, clientMessageId, content } = args;
  const externalId = webchatExternalId(session.id, clientMessageId);
  const timestamp = args.now ?? new Date();

  // Reenvio do widget (retry de rede): devolve o que já foi gravado.
  const already = await prisma.message.findFirst({
    where: { externalId },
    select: MESSAGE_SELECT,
  });
  if (already) {
    return {
      duplicate: true,
      message: already,
      conversationId: already.conversationId,
      contactId: session.contactId ?? "",
    };
  }

  const contact = await ensureVisitorContact(session);

  ensureOpenDealForContact({
    contactId: contact.id,
    contactName: contact.name,
    source: "auto_webchat",
    logTag: "webchat-inbound",
    channelId,
  }).catch((err) => log.warn({ err }, "Falha ao garantir deal aberto"));

  const conversation = await findOrCreateWebchatConversation(contact.id, channelId, {
    content,
    messageType: "text",
  });

  const msgCreated = await createMessageDedup(() =>
    prisma.message.create({
      data: withOrgFromCtx({
        conversationId: conversation.id,
        channelId,
        direction: "in" as const,
        messageType: "text",
        content,
        externalId,
        createdAt: timestamp,
      }),
      select: { ...MESSAGE_SELECT, organizationId: true },
    }),
  );
  if (!msgCreated) {
    // Corrida com o mesmo clientMessageId: o outro request gravou.
    const won = await prisma.message.findFirst({ where: { externalId }, select: MESSAGE_SELECT });
    if (!won) throw new Error("Mensagem do webchat sumiu após conflito de dedup.");
    return { duplicate: true, message: won, conversationId: won.conversationId, contactId: contact.id };
  }
  void noteMessageRowChange(msgCreated, "new");

  // Mesmo efeito do inbound WhatsApp no card: não lida, direção, sai de Erro.
  await prisma.conversation
    .update({
      where: { id: conversation.id },
      data: {
        updatedAt: new Date(),
        unreadCount: { increment: 1 },
        lastMessageDirection: "in",
        hasAgentReply: false,
        hasError: false,
      },
    })
    .catch((err) => log.warn({ err, conversationId: conversation.id }, "update do card falhou"));
  await touchInbound({ conversationId: conversation.id, at: timestamp }).catch((err) =>
    warnTouchInboundFailed(err, { conversationId: conversation.id, channel: WEBCHAT_CONVERSATION_CHANNEL }),
  );

  try {
    publishNewMessage({
      organizationId,
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "in",
      assignedToId: conversation.assignedToId ?? null,
      content,
      messageType: "text",
      timestamp,
    });
  } catch (err) {
    log.warn({ err }, "SSE publish falhou (não-fatal)");
  }

  notifyInboundMessage({
    conversationId: conversation.id,
    contactId: contact.id,
    contactName: contact.name,
    preview: content,
    channel: "Webchat",
  }).catch((err) => log.debug({ err }, "push falhou (não-fatal)"));

  try {
    await fireTrigger("message_received", {
      contactId: contact.id,
      data: buildMessageTriggerData({
        channel: WEBCHAT_CONVERSATION_CHANNEL,
        channelId,
        conversationId: conversation.id,
        content,
      }),
    });
  } catch (err) {
    log.error({ err }, "Falha ao disparar gatilho message_received");
  }

  // IA: o turno é avaliado como nos outros canais; responder pelo webchat
  // ainda não existe (fora de escopo — §6).
  if (content.trim()) {
    void onInboundMessageForAi({
      conversationId: conversation.id,
      contactId: contact.id,
      messageId: msgCreated.id,
      userMessage: content,
      channel: "messaging",
    });
  }

  const { organizationId: _org, ...message } = msgCreated;
  return { duplicate: false, message, conversationId: conversation.id, contactId: contact.id };
}
