/**
 * Graph sendText / sendTemplate do inbox.
 *
 * Roda no `worker-whatsapp` (withSystemContext no campaign-worker).
 * A API só persiste a mensagem `pending` e enfileira; fallback síncrono
 * quando Redis está down (rota de messages / sendTemplateToConversation).
 */
import { logEvent } from "@/services/activity-log";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
import { getContactWhatsAppTargets } from "@/lib/contact-whatsapp-target";
import {
  formatMetaSendError,
  metaClientFromConfig,
} from "@/lib/meta-whatsapp/client";
import { enrichTemplateComponentsForFlowSend } from "@/lib/meta-whatsapp/enrich-template-flow";
import { prisma } from "@/lib/prisma";
import { isMetaOutboundTemplate, type MetaOutboundPayload } from "@/lib/queue";
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

async function markConversationError(
  conversationId: string,
  hasError: boolean,
): Promise<void> {
  await prisma.conversation
    .update({
      where: { id: conversationId },
      data: { hasError },
    })
    .catch(() => {});
}

async function afterSuccessfulSend(
  payload: MetaOutboundPayload,
  externalId: string | null,
): Promise<MetaOutboundResult> {
  await markConversationError(payload.conversationId, false);
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
      via: payload.kind === "template" ? "meta-template" : "meta",
      externalId,
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
    externalId,
    metaError: null,
  };
}

async function failOutbound(
  payload: MetaOutboundPayload,
  error: string,
): Promise<never> {
  await prisma.message
    .updateMany({
      where: { id: payload.messageId, sendStatus: "pending" },
      data: { sendStatus: "failed", sendError: error },
    })
    .catch(() => {});
  await markConversationError(payload.conversationId, true);
  publishStatus(
    payload.organizationId,
    payload.conversationId,
    payload.messageId,
    "failed",
    error,
  );
  throw new Error(error);
}

async function processMetaOutboundTemplate(
  payload: MetaOutboundPayload,
): Promise<MetaOutboundResult> {
  const tpl = payload.template;
  if (!tpl?.templateName) {
    return failOutbound(payload, "Payload de template ausente");
  }

  const channel = payload.channelId
    ? await prisma.channel.findUnique({
        where: { id: payload.channelId },
        select: { id: true, config: true },
      })
    : null;
  const client = metaClientFromConfig(
    (channel?.config as Record<string, unknown> | null | undefined) ?? null,
  );
  if (!client.configured) {
    return failOutbound(payload, "Meta WhatsApp API não configurada.");
  }

  const waTarget = await getContactWhatsAppTargets(payload.contactId);
  if (!waTarget) {
    return failOutbound(payload, "Contato sem telefone nem BSUID WhatsApp.");
  }

  try {
    let sendComponents = Array.isArray(tpl.components) ? tpl.components : undefined;
    let resolvedFlowToken = tpl.flowToken?.trim() || null;
    if (tpl.knownHasFlowButton !== false) {
      const enrichResult = await enrichTemplateComponentsForFlowSend(client, {
        templateName: tpl.templateName,
        languageCode: tpl.languageCode,
        components: sendComponents,
        flowToken: resolvedFlowToken,
        flowActionData: tpl.flowActionData ?? null,
        templateGraphId: tpl.templateGraphId,
        strictFlowEnrich: false,
      });
      sendComponents = enrichResult.components;
      resolvedFlowToken = enrichResult.flowToken;
    }

    const result = await client.sendTemplate(
      waTarget.to,
      tpl.templateName,
      tpl.languageCode,
      sendComponents,
      waTarget.recipient,
    );
    const externalId = result.messages?.[0]?.id ?? null;
    console.log(
      `[meta-send-template] template=${tpl.templateName} channel=${payload.channelId ?? "ENV"} to=${waTarget.to ?? "—"}/${waTarget.recipient ?? "—"} wamid=${externalId} flowEnrich=${tpl.knownHasFlowButton !== false}`,
    );

    await prisma.message.update({
      where: { id: payload.messageId },
      data: {
        sendStatus: "sent",
        ...(externalId ? { externalId } : {}),
        ...(resolvedFlowToken?.trim() ? { flowToken: resolvedFlowToken.trim() } : {}),
        ...(tpl.templateConfigId ? { templateConfigId: tpl.templateConfigId } : {}),
      },
    });

    return afterSuccessfulSend(payload, externalId);
  } catch (err) {
    return failOutbound(payload, formatMetaSendError(err));
  }
}

export async function processMetaOutbound(
  payload: MetaOutboundPayload,
): Promise<MetaOutboundResult> {
  if (isMetaOutboundTemplate(payload)) {
    return processMetaOutboundTemplate(payload);
  }

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
    await markConversationError(payload.conversationId, true);
    publishStatus(
      payload.organizationId,
      payload.conversationId,
      payload.messageId,
      "failed",
      result.error,
    );
    throw new Error(result.error ?? "Falha no envio de texto Meta");
  }

  return afterSuccessfulSend(payload, result.externalId);
}
