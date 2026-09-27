/**
 * Envia o tutorial do modelo interno depois da resposta de texto da IA.
 * Reusa o mesmo pipeline do inbox humano (pending + meta-attach / Baileys).
 */

import { WHATSAPP_VIDEO_MAX_BYTES } from "@/lib/audio-convert";
import { enqueueMetaAttach, type MetaAttachPayload } from "@/lib/queue";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { prisma } from "@/lib/prisma";
import { sseBus } from "@/lib/sse-bus";
import { isBaileysChannel, sendWhatsAppMedia } from "@/lib/send-whatsapp";
import { parseStoragePath, resolveOutboundAttachmentMime } from "@/lib/storage/local";
import { isOrgOwnedStorageUrl, readStoredMediaForSend } from "@/lib/storage/read-for-send";
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
  /** Conta repetição só a partir daqui (ex.: último #reset do teste). */
  since?: Date;
  /** Reenvio a pedido do cliente: ignora a trava de repetição. */
  ignoreRecent?: boolean;
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

  // Só envio que não falhou conta como "já enviado": a entrega com falha
  // ("Arquivo não encontrado no storage") travava o reenvio por 7 dias e o
  // cliente ficava sem o arquivo.
  const already = args.ignoreRecent
    ? []
    : await prisma.message.findMany({
        where: {
          conversationId: args.conversationId,
          mediaUrl: { in: allowed.map((a) => a.url) },
          createdAt: { gte: new Date(Math.max(Date.now() - 7 * 24 * 60 * 60 * 1000, args.since?.getTime() ?? 0)) },
          sendStatus: { not: "failed" },
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
        senderName: (
          await prisma.user.findUnique({
            where: { id: args.agentUserId },
            select: { name: true },
          })
        )?.name?.trim() || "Agente IA",
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

    // Sobe o arquivo para a Meta aqui, onde ele existe. O worker de WhatsApp
    // não compartilha o disco da API: sem isto o job gravava "Arquivo não
    // encontrado no storage" e a imagem/vídeo do material não chegava. Com o
    // id, o worker só envia. Áudio fica com o worker (precisa de conversão);
    // falha aqui → o job tenta ler o arquivo como antes.
    const mediaId = kind === "audio" ? undefined : await preuploadToMeta(metaClient, att.url, mime, fileName);
    const payload: MetaAttachPayload = {
      conversationId: conv.id,
      messageId: msgRow.id,
      organizationId: conv.organizationId,
      originalName: fileName,
      mime,
      caption: "",
      kind,
      ...(mediaId ? { mediaId } : {}),
    };
    const job = await enqueueMetaAttach(payload);
    if (!job) {
      // Já está na Meta: envia daqui mesmo (o job é o fallback síncrono sem Redis).
      if (mediaId) {
        const { processMetaAttach } = await import("@/jobs/whatsapp/meta-attach.job");
        const res = await processMetaAttach(payload).catch((err) => ({ sendStatus: "failed" as const, metaError: err instanceof Error ? err.message : String(err) }));
        if (res.sendStatus === "sent") {
          sentCount += 1;
          continue;
        }
      }
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

/**
 * Upload do anexo à Meta a partir do processo que tem o arquivo. `undefined`
 * quando não dá (arquivo não lido, vídeo acima do limite, erro da Meta): o
 * worker segue pelo caminho de antes.
 */
async function preuploadToMeta(
  metaClient: ReturnType<typeof metaClientFromConfig>,
  mediaUrl: string,
  mime: string,
  fileName: string,
): Promise<string | undefined> {
  try {
    const found = await readStoredMediaForSend(mediaUrl);
    if (!found?.buffer.length) return undefined;
    const uploadMime = resolveOutboundAttachmentMime({ rawType: mime || found.mimeType, fileNames: [fileName, found.fileName] });
    if (uploadMime.startsWith("video/") && found.buffer.length > WHATSAPP_VIDEO_MAX_BYTES) return undefined;
    const finalMime = uploadMime !== "application/octet-stream" ? uploadMime : mime || found.mimeType || "application/octet-stream";
    return await metaClient.uploadMedia(found.buffer, finalMime, fileName || found.fileName);
  } catch (err) {
    console.warn("[send-agent-media] upload prévio à Meta falhou; o worker tenta com o arquivo:", err instanceof Error ? err.message : err);
    return undefined;
  }
}
