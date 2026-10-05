import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { touchChatLastMessageAt } from "@/lib/conversation-last-message";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { sendWhatsAppText } from "@/lib/send-whatsapp";
import { publishNewMessage } from "@/lib/realtime-events";
import { getLogger } from "@/lib/logger";

const log = getLogger("whatsapp-inbound-call-routing");

/** Auto-resposta quando a ligação de entrada não tem consultor humano responsável. */
export const INBOUND_CALL_NO_AGENT_MESSAGE =
  "No momento não temos consultores disponíveis para atender sua ligação. Retornaremos o contato o quanto antes.";

/**
 * Responsável por atender ligações WhatsApp: `conversation.assignedToId`
 * quando o usuário é humano (agentes IA não atendem voz).
 */
export async function getInboundCallHumanAssigneeId(
  conversationId: string,
): Promise<string | null> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      assignedToId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!conv?.assignedToId) return null;
  if (conv.assignedTo?.type !== "HUMAN") return null;
  return conv.assignedToId;
}

/**
 * Recusa ligação de entrada sem responsável humano e envia orientação ao cliente.
 * Idempotente por `callId` (externalId `call_no_agent:{callId}`).
 */
export async function rejectInboundCallWithoutAgent(params: {
  callId: string;
  conversationId: string;
  contactId: string;
  organizationId: string | null;
}): Promise<void> {
  const extId = `call_no_agent:${params.callId}`;
  const dup = await prisma.message.findFirst({
    where: { conversationId: params.conversationId, externalId: extId },
    select: { id: true },
  });
  if (dup) return;

  const conv = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: {
      waJid: true,
      channelRef: { select: { id: true, config: true, provider: true } },
    },
  });
  if (!conv?.channelRef || conv.channelRef.provider !== "META_CLOUD_API") {
    log.warn("[inbound-call-routing] Canal não Meta — recusa automática omitida.");
    return;
  }

  const metaClient = metaClientFromConfig(
    conv.channelRef.config as Record<string, unknown> | null | undefined,
  );
  if (!metaClient.configured) {
    log.warn("[inbound-call-routing] Meta não configurado — recusa automática omitida.");
    return;
  }

  try {
    await metaClient.rejectCall(params.callId);
  } catch (e) {
    log.warn({ err: e }, "[inbound-call-routing] rejectCall falhou, tentando terminate");
    try {
      await metaClient.terminateCall(params.callId);
    } catch (e2) {
      log.warn({ err: e2 }, "[inbound-call-routing] terminateCall também falhou");
    }
  }

  const content = INBOUND_CALL_NO_AGENT_MESSAGE;
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: params.conversationId,
      content,
      direction: "out",
      messageType: "text",
      senderName: "WhatsApp",
      externalId: extId,
    }),
  });

  const sendResult = await sendWhatsAppText({
    conversationId: params.conversationId,
    contactId: params.contactId,
    channelRef: conv.channelRef,
    content,
    messageId: saved.id,
    waJid: conv.waJid,
  });

  await prisma.conversation
    .update({
      where: { id: params.conversationId },
      data: {
        lastMessageDirection: "out",
        updatedAt: new Date(),
        ...(sendResult.failed ? { hasError: true } : {}),
      },
    })
    .catch(() => {});
  await touchChatLastMessageAt({
    conversationId: params.conversationId,
    message: saved,
  }).catch(() => {});

  if (!sendResult.failed && params.organizationId) {
    publishNewMessage({
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      contactId: params.contactId,
      direction: "out",
      content,
      timestamp: new Date(),
    });
  }
}
