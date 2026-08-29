import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import path from "path";
import fs from "fs/promises";

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import {
  BAILEYS_OUTBOUND_QUEUE_NAME,
  type BaileysOutboundPayload,
} from "@/lib/queue";
import { parseStoragePath, readStoredFile } from "@/lib/storage/local";
import { logMessageFailed } from "@/services/activity-log";
import { sseBus } from "@/lib/sse-bus";
import { withSystemContext } from "@/lib/webhook-context";
import type { BaileysManager } from "./baileys-manager";
import type { AnyMessageContent } from "@whiskeysockets/baileys";

export function startOutboundConsumer(
  manager: BaileysManager,
  redisUrl: string,
): Worker<BaileysOutboundPayload> {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<BaileysOutboundPayload>(
    BAILEYS_OUTBOUND_QUEUE_NAME,
    async (job: Job<BaileysOutboundPayload>) => {
      const { channelId, to, content, mediaUrl, replyTo, messageType, messageId } = job.data;

      const session = manager.getSession(channelId);
      if (!session?.socket) {
        await markFailed(messageId, "Sessão Baileys não está conectada");
        throw new Error(`Sessão ${channelId} não conectada`);
      }

      const jid = to.includes("@") ? to : to.replace(/\D/g, "") + "@s.whatsapp.net";
      let waContent: AnyMessageContent;

      if (mediaUrl && messageType !== "text") {
        // PR 1.3: storage tenant-scoped passou a usar `/api/storage/...`.
        // Mantemos compatibilidade com `/uploads/...` legacy enquanto
        // mídias antigas existirem no FS.
        let buffer: Buffer | undefined;

        const parsed = parseStoragePath(mediaUrl);
        if (parsed) {
          const stored = await readStoredFile(parsed.orgId, parsed.bucket, parsed.fileName);
          if (stored) buffer = stored.buffer;
        } else if (mediaUrl.startsWith("/uploads/")) {
          const localPath = path.join(process.cwd(), "public", mediaUrl);
          try {
            buffer = await fs.readFile(localPath);
          } catch {
            /* file not found — fallback to URL */
          }
        }

        const mediaPayload = buffer
          ? buffer
          : { url: mediaUrl };

        const ext = mediaUrl.split(".").pop()?.toLowerCase() ?? "";
        const mimeFromExt: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
          mp4: "video/mp4", mov: "video/quicktime", "3gp": "video/3gpp",
          ogg: "audio/ogg; codecs=opus", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
          pdf: "application/pdf", doc: "application/msword",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xls: "application/vnd.ms-excel",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
        const detectedMime = mimeFromExt[ext] ?? "application/octet-stream";

        switch (messageType) {
          case "image":
            waContent = { image: mediaPayload, caption: content || undefined };
            break;
          case "video":
            waContent = { video: mediaPayload, caption: content || undefined };
            break;
          case "audio":
          case "ptt": {
            const isPtt = messageType === "ptt";
            waContent = {
              audio: mediaPayload,
              mimetype: isPtt ? "audio/ogg; codecs=opus" : (detectedMime.startsWith("audio/") ? detectedMime : "audio/mpeg"),
              ptt: isPtt,
            };
            break;
          }
          case "sticker":
            waContent = { sticker: mediaPayload };
            break;
          case "document":
            waContent = {
              document: mediaPayload,
              mimetype: detectedMime,
              fileName: content || mediaUrl.split("/").pop() || "file",
            };
            break;
          default:
            waContent = { text: content || "[media]" };
        }
      } else {
        waContent = { text: content };
      }

      if (replyTo) {
        (waContent as Record<string, unknown>).quoted = {
          key: { remoteJid: jid, id: replyTo },
        };
      }

      const sent = await session.sendMessage(jid, waContent);

      // Prisma scoped exige RequestContext. Sem withSystemContext o
      // externalId nunca era gravado (.catch engolia) → ACKs de
      // delivered/read do Baileys não achavam a mensagem por wamid.
      const meta = await prismaBase.message.findUnique({
        where: { id: messageId },
        select: { organizationId: true, conversationId: true },
      });
      if (meta?.organizationId && sent?.key?.id) {
        await withSystemContext(meta.organizationId, async () => {
          await prisma.message.update({
            where: { id: messageId },
            data: { externalId: sent.key!.id!, sendStatus: "sent" },
          });
          sseBus.publish("message_status", {
            organizationId: meta.organizationId,
            conversationId: meta.conversationId,
            messageId,
            status: "sent",
          });
        });
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    console.error(`[baileys-outbound] job ${job?.id} falhou:`, err.message);
  });

  worker.on("completed", (job) => {
    console.info(`[baileys-outbound] job ${job.id} concluído`);
  });

  console.info(`[baileys-outbound] ouvindo fila "${BAILEYS_OUTBOUND_QUEUE_NAME}"`);
  return worker;
}

async function markFailed(messageId: string, error: string) {
  // Activity Log (feed /logs + estatisticas). O worker roda fora de um
  // request — resolve org via prismaBase e envolve updates em contexto.
  void (async () => {
    const msg = await prismaBase.message.findUnique({
      where: { id: messageId },
      select: {
        organizationId: true,
        conversationId: true,
        conversation: {
          select: {
            contactId: true,
            contact: { select: { name: true, phone: true } },
          },
        },
      },
    });
    if (!msg?.organizationId) return;
    await withSystemContext(msg.organizationId, async () => {
      await prisma.message.update({
        where: { id: messageId },
        data: { sendStatus: "failed", sendError: error },
      });
      sseBus.publish("message_status", {
        organizationId: msg.organizationId,
        conversationId: msg.conversationId,
        messageId,
        status: "failed",
        error,
      });
      await logMessageFailed({
        messageId,
        conversationId: msg.conversationId,
        contactId: msg.conversation?.contactId ?? null,
        contactLabel: msg.conversation?.contact?.name ?? null,
        contactSublabel: msg.conversation?.contact?.phone ?? null,
        error,
        source: "baileys",
        channel: "WhatsApp",
      });
    });
  })();
}
