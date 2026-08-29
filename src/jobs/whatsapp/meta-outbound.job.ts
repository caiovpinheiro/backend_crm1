/**
 * sendText Graph de texto livre do inbox.
 *
 * Roda no `worker-whatsapp`. A API só persiste a mensagem `pending` e
 * enfileira; fallback síncrono quando Redis está down (rota de messages).
 */
import { logEvent } from "@/services/activity-log";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
import { prisma } from "@/lib/prisma";
import type { MetaOutboundPayload } from "@/lib/queue";
import { sendWhatsAppText } from "@/lib/send-whatsapp";
import { sseBus } from "@/lib/sse-bus";

export type MetaOutboundResult = {
  sendStatus: "sent" | "failed";
  externalId: string | null;
  metaError: string | null;
};

function publishStatus(
  organizationId: string,
  conversationId: string,
  messageId: string,
  status: string,
  error?: string | null,
) {
  try {
    sseBus.publish("message_status", {
      organizationId,
      conversationId,
      messageId,
      internalId: messageId,
      status,
      ...(error ? { error } : {}),
    });
  } catch {
    // best-effort
  }
}

export async function processMetaOutbound(
  payload: MetaOutboundPayload,
): Promise<MetaOutboundResult> {
  let channelRef: { id: string; provider: string } | null = null;
  if (payload.channelId) {
    const ch = await prisma.channel.findUnique({
      where: { id: payload.channelId },
      select: { id: true, provider: true },
    });
    channelRef = ch;
  }

  const result = await sendWhatsAppText({
    conversationId: payload.conversationId,
    contactId: payload.contactId,
    channelRef,
    content: payload.content,
    messageId: payload.messageId,
    replyContextWamid: payload.replyContextWamid,
    waJid: payload.waJid,
  });

  if (result.failed) {
    await prisma.conversation
      .update({
        where: { id: payload.conversationId },
        data: { hasError: true },
      })
      .catch(() => {});
    publishStatus(
      payload.organizationId,
      payload.conversationId,
      payload.messageId,
      "failed",
      result.error,
    );
    throw new Error(result.error ?? "Falha no envio de texto Meta");
  }

  await prisma.conversation
    .update({
      where: { id: payload.conversationId },
      data: { hasError: false },
    })
    .catch(() => {});

  publishStatus(
    payload.organizationId,
    payload.conversationId,
    payload.messageId,
    "sent",
  );

  void logEvent({
    type: "MESSAGE_SENT",
    entityType: "MESSAGE",
    entityId: payload.messageId,
    entityLabel: payload.senderName ?? "Mensagem enviada",
    conversationId: payload.conversationId,
    contactId: payload.contactId,
    meta: {
      preview: payload.content.slice(0, 200),
      channel: "WhatsApp",
      via: "meta",
      externalId: result.externalId,
    },
  });

  fireTrigger("message_sent", {
    contactId: payload.contactId,
    data: buildMessageTriggerData({
      channel: "WhatsApp",
      channelId: payload.channelId ?? undefined,
      conversationId: payload.conversationId,
      content: payload.content,
    }),
  }).catch((err) => console.warn("[automation trigger] message_sent:", err));

  return {
    sendStatus: "sent",
    externalId: result.externalId,
    metaError: null,
  };
}
