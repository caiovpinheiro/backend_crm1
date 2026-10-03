/**
 * Envia o tutorial do modelo interno depois da resposta de texto da IA.
 * Reusa o mesmo pipeline do inbox humano (pending + meta-attach / Baileys).
 */

import { WHATSAPP_VIDEO_MAX_BYTES } from "@/lib/audio-convert";
import { enqueueMetaAttach, type MetaAttachPayload } from "@/lib/queue";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { touchConversationLastMessageAt } from "@/lib/conversation-last-message";
import { prisma } from "@/lib/prisma";
import { publishNewMessage } from "@/lib/realtime-events";
import { isBaileysChannel, sendWhatsAppMedia } from "@/lib/send-whatsapp";
import { resolveOutboundAttachmentMime } from "@/lib/storage/local";
import { isOrgOwnedStorageUrl, isStorageUrlOfOrg, readStoredMediaForSend } from "@/lib/storage/read-for-send";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import type { AgentFaqMedia } from "@/services/ai/message-models-retrieval";
import { traceStep } from "@/services/ai-v2/trace";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai.send-agent-media");

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

/** Anexos que não saíram e por quê. */
export type MediaSendReport = { otherOrg: string[]; alreadySent: string[] };

/** Linha do rastro para anexos que não saíram, com o motivo real. */
export function mediaNotSentTrace(what: string, report: MediaSendReport | undefined): string {
  if (report?.otherOrg.length) {
    return `${what} não enviados: o arquivo está guardado em outra organização e não existe aqui (${report.otherOrg.join(", ")}) — anexe o arquivo de novo`;
  }
  if (report?.alreadySent.length) {
    return `${what} não enviados: já entregues nesta conversa dentro da trava de repetição (${report.alreadySent.join(", ")})`;
  }
  return `${what} não enviados: a conversa não tem canal para envio de arquivo`;
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
  /** Por que um anexo não saiu (o rastro do turno mostra o motivo real). */
  report?: (r: MediaSendReport) => void;
}): Promise<number> {
  const orgId = getOrgIdOrThrow();
  const nameOf = (att: AgentFaqMedia) => att.name?.trim() || "arquivo";
  const otherOrg = args.attachments.filter((att) => isOrgOwnedStorageUrl(att.url) && !isStorageUrlOfOrg(att.url, orgId)).map(nameOf);
  const allowed = args.attachments.filter((att) => isStorageUrlOfOrg(att.url, orgId));
  if (allowed.length === 0) {
    args.report?.({ otherOrg, alreadySent: [] });
    return 0;
  }

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
  args.report?.({ otherOrg, alreadySent: allowed.filter((a) => sent.has(a.url)).map(nameOf) });
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
    // Este envio não atualiza a conversa: grava só a ordem da lista.
    await touchConversationLastMessageAt({
      conversationId: conv.id,
      at: msgRow.createdAt,
    }).catch(() => {});

    try {
      publishNewMessage({
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
    // No rastro do turno: se mesmo assim a entrega falhar com "Arquivo não
    // encontrado no storage", o worker de WhatsApp está na versão antiga.
    if (mediaId) traceStep("mídia", `Arquivo "${fileName}" já enviado à Meta pela API (o worker só envia pelo id)`);
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
    log.warn(
      { err: err instanceof Error ? err.message : err },
      "[send-agent-media] upload prévio à Meta falhou; o worker tenta com o arquivo",
    );
    return undefined;
  }
}
