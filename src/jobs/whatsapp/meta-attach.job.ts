/**
 * Upload Graph + sendMediaById de anexo do inbox (áudio/imagem/vídeo/doc).
 * Áudio: remux WebM/Opus → Ogg/Opus antes do POST.
 *
 * Roda no `worker-whatsapp` (campaign-worker). A API só persiste o
 * arquivo original e cria a mensagem `pending`.
 *
 * Também é o fallback síncrono quando Redis está indisponível — o
 * caller (rota de attachments) já está em RequestContext.
 */
import { guessInputExt, prepareWhatsAppAudio } from "@/lib/audio-convert";
import { getDecryptedChannelConfig } from "@/lib/channels/config";
import { formatMetaSendError, metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { prisma } from "@/lib/prisma";
import type { MetaAttachKind, MetaAttachPayload } from "@/lib/queue";
import { sseBus } from "@/lib/sse-bus";
import { parseStoragePath, readStoredFile } from "@/lib/storage/local";
import { logMessageFailed } from "@/services/activity-log";
import { fireTrigger } from "@/services/automation-triggers";

export type MetaAttachResult = {
  sendStatus: "sent" | "failed";
  audioDelivery: "voice" | "audio" | "document" | null;
  metaError: string | null;
  messageType: string;
  externalId: string | null;
};

const TERMINAL_OK = new Set(["sent", "delivered", "read"]);

function resolveKind(payload: MetaAttachPayload): MetaAttachKind {
  if (payload.kind) return payload.kind;
  const mime = payload.mime ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime) return "document";
  return "audio";
}

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

async function markFailed(
  payload: MetaAttachPayload,
  error: string,
  extras?: { messageType?: string; audioDelivery?: MetaAttachResult["audioDelivery"] },
): Promise<MetaAttachResult> {
  await prisma.message
    .updateMany({
      where: { id: payload.messageId, sendStatus: "pending" },
      data: {
        sendStatus: "failed",
        sendError: error,
        ...(extras?.messageType ? { messageType: extras.messageType } : {}),
      },
    })
    .catch(() => {});

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
    error,
  );

  const msg = await prisma.message
    .findUnique({
      where: { id: payload.messageId },
      select: {
        conversation: {
          select: { contactId: true, contact: { select: { name: true, phone: true } } },
        },
      },
    })
    .catch(() => null);

  void logMessageFailed({
    messageId: payload.messageId,
    conversationId: payload.conversationId,
    contactId: msg?.conversation?.contactId ?? null,
    contactLabel: msg?.conversation?.contact?.name ?? null,
    contactSublabel: msg?.conversation?.contact?.phone ?? null,
    error,
    source: "api",
    channel: "WhatsApp",
  });

  return {
    sendStatus: "failed",
    audioDelivery: extras?.audioDelivery ?? null,
    metaError: error,
    messageType: extras?.messageType ?? "audio",
    externalId: null,
  };
}

export async function processMetaAttach(
  payload: MetaAttachPayload,
): Promise<MetaAttachResult> {
  const msg = await prisma.message.findUnique({
    where: { id: payload.messageId },
    select: {
      id: true,
      sendStatus: true,
      externalId: true,
      mediaUrl: true,
      messageType: true,
      channelId: true,
      conversationId: true,
      conversation: {
        select: {
          id: true,
          contactId: true,
          channelId: true,
          organizationId: true,
          contact: { select: { phone: true, whatsappBsuid: true } },
        },
      },
    },
  });

  const kind = resolveKind(payload);

  if (!msg) {
    return {
      sendStatus: "failed",
      audioDelivery: null,
      metaError: "Mensagem não encontrada.",
      messageType: kind,
      externalId: null,
    };
  }

  const current = (msg.sendStatus ?? "").toLowerCase();
  if (msg.externalId || TERMINAL_OK.has(current)) {
    return {
      sendStatus: "sent",
      audioDelivery: null,
      metaError: null,
      messageType: msg.messageType,
      externalId: msg.externalId,
    };
  }

  const storedPath = msg.mediaUrl ? parseStoragePath(msg.mediaUrl) : null;
  if (!storedPath || storedPath.orgId !== payload.organizationId) {
    return markFailed(payload, "Arquivo não encontrado no storage.", {
      messageType: kind,
    });
  }

  const stored = await readStoredFile(
    storedPath.orgId,
    storedPath.bucket,
    storedPath.fileName,
  );
  if (!stored?.buffer.length) {
    return markFailed(payload, "Arquivo vazio ou ilegível.", { messageType: kind });
  }

  let mediaType: "image" | "audio" | "video" | "document" = kind;
  let sendAsVoice = false;
  let audioDelivery: MetaAttachResult["audioDelivery"] = null;
  let uploadMime = payload.mime || stored.mimeType || "application/octet-stream";
  let uploadName = payload.originalName || storedPath.fileName;
  let storeBuffer = stored.buffer;

  if (kind === "audio") {
    const inputExt = guessInputExt(payload.mime);
    console.log(
      `[meta-attach] Convertendo audio ${payload.mime} (.${inputExt}) para formato aceito pela Meta`,
    );
    const prepared = await prepareWhatsAppAudio(
      stored.buffer,
      inputExt,
      payload.originalName,
    );
    if (!prepared.ok) {
      return markFailed(payload, prepared.reason);
    }
    mediaType = prepared.payload.delivery === "document" ? "document" : "audio";
    sendAsVoice = prepared.payload.voice;
    audioDelivery = prepared.payload.delivery;
    uploadMime = prepared.payload.mime;
    uploadName = prepared.payload.fileName;
    storeBuffer = prepared.payload.buffer;
    console.log(
      `[meta-attach] Preparo OK (${audioDelivery}), ${stored.buffer.length} -> ${storeBuffer.length} bytes | mime=${uploadMime} | voice=${sendAsVoice}`,
    );
  }

  const channelId = msg.channelId ?? msg.conversation.channelId;
  const channel = channelId
    ? await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true, provider: true, config: true },
      })
    : null;

  const config = channel
    ? getDecryptedChannelConfig({
        provider: channel.provider,
        config: channel.config,
      })
    : null;
  const metaClient = metaClientFromConfig(config);

  const digits = msg.conversation.contact?.phone?.replace(/\D/g, "") ?? "";
  const to = digits.length >= 8 ? digits : undefined;
  const recipient = msg.conversation.contact?.whatsappBsuid?.trim() || undefined;

  if (!metaClient.configured) {
    return markFailed(
      payload,
      `Meta API nao configurada para o canal (channel=${channel?.id ?? "ENV"})`,
      { messageType: sendAsVoice ? "ptt" : mediaType, audioDelivery },
    );
  }
  if (!to && !recipient) {
    return markFailed(payload, "Contato sem telefone nem BSUID WhatsApp", {
      messageType: sendAsVoice ? "ptt" : mediaType,
      audioDelivery,
    });
  }

  let externalId: string | null = null;
  let metaSendError: string | null = null;

  try {
    const mediaId = await metaClient.uploadMedia(storeBuffer, uploadMime, uploadName);
    const result = await metaClient.sendMediaById(
      to,
      mediaId,
      mediaType,
      mediaType !== "audio" ? payload.caption || undefined : undefined,
      mediaType === "document" ? payload.originalName : undefined,
      sendAsVoice,
      recipient,
    );
    externalId = result.messages?.[0]?.id ?? null;
    console.log(
      `[meta-attach] Enviado ${mediaType} (${to ?? "—"}/${recipient ?? "—"}) | channel=${channel?.id ?? "ENV"} | mime=${uploadMime} | mediaId=${mediaId} | wamid=${externalId} | voice=${sendAsVoice}`,
    );
  } catch (err) {
    const errMsg = formatMetaSendError(err);
    console.error("[meta-attach] Falha ao enviar para Meta:", errMsg);
    if (mediaType === "audio") {
      try {
        const retryName = uploadName.includes(".") ? uploadName : `${uploadName}.bin`;
        const mediaId = await metaClient.uploadMedia(
          storeBuffer,
          "application/octet-stream",
          retryName,
        );
        const result = await metaClient.sendMediaById(
          to,
          mediaId,
          "document",
          payload.caption || undefined,
          retryName,
          false,
          recipient,
        );
        externalId = result.messages?.[0]?.id ?? null;
        mediaType = "document";
        sendAsVoice = false;
        audioDelivery = "document";
        metaSendError = null;
        console.warn(
          `[meta-attach] Retry como documento OK após falha de áudio | wamid=${externalId}`,
        );
      } catch (retryErr) {
        metaSendError = errMsg;
        console.error(
          "[meta-attach] Retry como documento também falhou:",
          formatMetaSendError(retryErr),
        );
      }
    } else {
      metaSendError = errMsg;
    }
  }

  const storedType = sendAsVoice ? "ptt" : mediaType;

  if (metaSendError) {
    // Erro de rede/Graph: relança pra o BullMQ retryar (até 3x).
    // O handler `failed` do worker marca a mensagem se esgotar.
    throw new Error(metaSendError);
  }

  await prisma.message.update({
    where: { id: payload.messageId },
    data: {
      sendStatus: "sent",
      sendError: null,
      messageType: storedType,
      ...(externalId ? { externalId } : {}),
    },
  });

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

  fireTrigger("message_sent", {
    contactId: msg.conversation.contactId,
    data: { channel: "WhatsApp", content: payload.caption || "[Anexo]" },
  }).catch((err) => console.warn("[automation trigger] message_sent:", err));

  return {
    sendStatus: "sent",
    audioDelivery,
    metaError: null,
    messageType: storedType,
    externalId,
  };
}
