/**
 * Envia o tutorial do modelo interno depois da resposta de texto da IA.
 * Reusa o mesmo pipeline do inbox humano (pending + meta-attach / Baileys).
 */

import { enqueueMetaAttach } from "@/lib/queue";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { prisma } from "@/lib/prisma";
import { sseBus } from "@/lib/sse-bus";
import { isBaileysChannel, sendWhatsAppMedia } from "@/lib/send-whatsapp";
import { parseStoragePath } from "@/lib/storage/local";
import { isOrgOwnedStorageUrl } from "@/lib/storage/read-for-send";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import type { AgentFaqMedia } from "@/services/ai/message-models-retrieval";

function kindFromMime(mime: string | null): "image" | "video" | "audio" | "document" {
  const t = (mime ?? "").toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  return "document";
}

function mimeFromName(name: string | null, fallback: string | null): string {
  if (fallback?.includes("/")) return fallback;
  const n = (name ?? "").toLowerCase();
  if (n.endsWith(".mp4") || n.endsWith(".mov")) return "video/mp4";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  return fallback || "application/octet-stream";
}

export async function sendAgentFollowUpMedia(args: {
  conversationId: string;
  contactId: string;
  agentUserId: string;
  attachments: AgentFaqMedia[];
}): Promise<number> {
  const orgId = getOrgIdOrThrow();
  const allowed = args.attachments.filter((att) => {
    if (!isOrgOwnedStorageUrl(att.url)) return false;
    const parsed = parseStoragePath(
      att.url.startsWith("http")
        ? (() => {
            try {
              return new URL(att.url).pathname;
            } catch {
              return att.url;
            }
          })()
        : att.url,
    );
    return !parsed || parsed.orgId === orgId;
  });
  if (allowed.length === 0) return 0;

  const already = await prisma.message.findMany({
    where: {
      conversationId: args.conversationId,
      mediaUrl: { in: allowed.map((a) => a.url) },
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    select: { mediaUrl: true },
  });
  const sent = new Set(already.map((m) => m.mediaUrl).filter(Boolean));
  const pending = allowed.filter((a) => !sent.has(a.url));
  if (pending.length === 0) return 0;

  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      id: true,
      organizationId: true,
      channelId: true,
      waJid: true,
      channelRef: { select: { id: true, config: true, provider: true } },
    },
  });
  if (!conv) return 0;

  const useBaileys = isBaileysChannel(conv.channelRef);
  let sentCount = 0;

  for (const att of pending.slice(0, 2)) {
    const mime = mimeFromName(att.name, att.mimeType);
    const kind = kindFromMime(mime);
    const fileName = att.name?.trim() || "tutorial";
    const displayContent = `📎 ${fileName}`;

    const msgRow = await prisma.message.create({
      data: withOrgFromCtx({
        conversationId: conv.id,
        channelId: conv.channelRef?.id ?? conv.channelId ?? undefined,
        content: displayContent,
        direction: "out",
        messageType: kind,
        authorType: "bot",
        aiAgentUserId: args.agentUserId,
        senderName: "Agente IA",
        mediaUrl: att.url,
        sendStatus: "pending",
      }),
    });

    try {
      sseBus.publish("new_message", {
        organizationId: orgId,
        conversationId: conv.id,
        contactId: args.contactId,
        direction: "out",
        content: displayContent,
        timestamp: msgRow.createdAt,
      });
    } catch {
      /* best-effort */
    }

    if (useBaileys) {
      const result = await sendWhatsAppMedia({
        conversationId: conv.id,
        contactId: args.contactId,
        channelRef: conv.channelRef,
        messageId: msgRow.id,
        mediaUrl: att.url,
        messageType: kind,
        caption: undefined,
        waJid: conv.waJid,
        mime,
        originalName: fileName,
      });
      if (result.failed) {
        await prisma.message
          .updateMany({
            where: { id: msgRow.id, sendStatus: "pending" },
            data: { sendStatus: "failed", sendError: result.error },
          })
          .catch(() => {});
        continue;
      }
      sentCount += 1;
      continue;
    }

    const channelConfig = conv.channelRef?.config as Record<string, unknown> | null;
    const metaClient = metaClientFromConfig(channelConfig);
    if (!metaClient.configured) {
      await prisma.message
        .updateMany({
          where: { id: msgRow.id, sendStatus: "pending" },
          data: { sendStatus: "failed", sendError: "Canal Meta não configurado." },
        })
        .catch(() => {});
      continue;
    }

    const job = await enqueueMetaAttach({
      conversationId: conv.id,
      messageId: msgRow.id,
      organizationId: conv.organizationId,
      originalName: fileName,
      mime,
      caption: "",
      kind,
    });
    if (!job) {
      await prisma.message
        .updateMany({
          where: { id: msgRow.id, sendStatus: "pending" },
          data: {
            sendStatus: "failed",
            sendError: "Fila de envio indisponível (Redis).",
          },
        })
        .catch(() => {});
      continue;
    }
    sentCount += 1;
  }

  return sentCount;
}
