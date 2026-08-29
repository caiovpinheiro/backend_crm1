import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { getContactChannelSession, getConversationSession } from "@/lib/channel-session";
import { requireConversationAccess } from "@/lib/conversation-access";
import { resolveOutboundChannel } from "@/lib/outbound-channel";
import {
  guessInputExt,
  mimeFromExtension,
  prepareWhatsAppAudio,
} from "@/lib/audio-convert";
import { processMetaAttach } from "@/jobs/whatsapp/meta-attach.job";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { enqueueMetaAttach } from "@/lib/queue";
import { metaWhatsApp, metaClientFromConfig, formatMetaSendError } from "@/lib/meta-whatsapp/client";
import { sendWhatsAppMedia, isBaileysChannel } from "@/lib/send-whatsapp";
import { sseBus } from "@/lib/sse-bus";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { getConversationLite, reopenResolvedAsNewTicket } from "@/services/conversations";
import { fireTrigger } from "@/services/automation-triggers";
import { cancelPendingForConversation } from "@/services/scheduled-messages";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_FILE_SIZE = 16 * 1024 * 1024;
const ALLOWED_PREFIXES = [
  "image/", "video/", "audio/",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "text/plain", "text/csv",
];

function isFileLike(v: unknown): v is Blob & { name?: string } {
  return (
    v instanceof Blob ||
    (typeof v === "object" && v !== null && typeof (v as Blob).arrayBuffer === "function" && typeof (v as Blob).size === "number")
  );
}

async function blobToBuffer(blob: Blob): Promise<Buffer> {
  try {
    return Buffer.from(await blob.arrayBuffer());
  } catch {
    const reader = blob.stream().getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parts.push(value);
    }
    return Buffer.concat(parts);
  }
}

function resolveMediaType(mime: string): "image" | "audio" | "video" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

/**
 * Derive a reliable MIME from both the raw blob type and filename extension.
 * Some browsers/runtimes lose the blob MIME during FormData transport.
 */
function resolveMime(rawType: string, fileName: string): string {
  const blobMime = rawType?.split(";")[0].trim();
  if (blobMime && blobMime !== "application/octet-stream") return blobMime;

  const ext = fileName.includes(".") ? fileName.split(".").pop()! : "";
  const fromExt = mimeFromExtension(ext);
  if (fromExt) return fromExt;

  return blobMime || "application/octet-stream";
}

// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      let conv = await getConversationLite(id);
      if (!conv) {
        return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
      }

      // Regra "reabrir = novo id": anexo em conversa ENCERRADA reabre como
      // NOVO ticket (mesmo comportamento do POST /messages).
      let reopenedConversationId: string | null = null;
      if (conv.status === "RESOLVED" && conv.contactId) {
        const reopened = await reopenResolvedAsNewTicket(conv.id);
        if (reopened.id !== conv.id) {
          const fresh = await getConversationLite(reopened.id);
          if (fresh) {
            reopenedConversationId = reopened.id;
            conv = fresh;
          }
        }
      }

      const sendDenied = await requireChannelScope(session.user, "send", conv.channelId);
      if (sendDenied) return sendDenied;

      let form: FormData;
      try {
        form = await request.formData();
      } catch (err) {
        console.error("[attachments] formData parse error:", err);
        return NextResponse.json({ message: "Erro ao processar upload." }, { status: 400 });
      }

      const raw = form.get("file");
      const caption = (form.get("caption") as string) ?? "";
      // Override de canal vindo do composer (mesmo contrato do route de
      // /messages). Multipart envia como string; vazio == ausência.
      const requestedChannelIdRaw = form.get("channelId");
      const requestedChannelId =
        typeof requestedChannelIdRaw === "string" && requestedChannelIdRaw.trim()
          ? requestedChannelIdRaw.trim()
          : null;

      if (!raw || !isFileLike(raw) || raw.size === 0) {
        return NextResponse.json({ message: "Nenhum arquivo enviado." }, { status: 400 });
      }

      // Resolve o canal de envio (com override se válido). Vem ANTES dos
      // metaClient/baileys para que `channelId` snapshotado em
      // `message.channelId` já reflita o canal escolhido.
      const resolved = await resolveOutboundChannel({
        conv: {
          channelId: conv.channelId,
          channelRef: conv.channelRef,
          organizationId: conv.organizationId,
        },
        user: session.user as {
          id: string;
          role?: string | null;
          organizationId: string | null;
          isSuperAdmin?: boolean;
        },
        requestedChannelId,
      });
      if (!resolved.ok) return resolved.response;
      const outboundChannelRef = resolved.channelRef;
      const outboundChannelId = resolved.channelId;
      const useBaileys = isBaileysChannel(outboundChannelRef);

      // Bloqueio duro de envio humano fora da janela de 24h em canal Meta
      // Cloud API (mídia também é envio livre) — mesmo critério do POST
      // /messages. Roda ANTES de qualquer message.create: anexo bloqueado
      // não vira sendStatus=failed nem marca hasError na conversa. Esta
      // rota é session-only (withOrgContext), então todo caller é humano.
      if (outboundChannelRef?.provider === "META_CLOUD_API") {
        const hasChannelOverride =
          !!requestedChannelId && requestedChannelId !== conv.channelId;
        const targetSession =
          hasChannelOverride && conv.contactId
            ? await getContactChannelSession(conv.contactId, outboundChannelRef.id)
            : await getConversationSession(conv);
        if (!targetSession.active) {
          return NextResponse.json(
            {
              message: "Sessão de 24h encerrada neste canal. Envie um template.",
              code: "SESSION_CLOSED",
            },
            { status: 409 },
          );
        }
      }

      if (raw.size > MAX_FILE_SIZE) {
        return NextResponse.json({ message: "Arquivo muito grande (máx 16 MB)." }, { status: 400 });
      }

      const senderName = session.user.name ?? session.user.email ?? "Agente";
      const timestamp = Date.now();
      const fileName = (raw as File).name || "file";

      const mimeBase = resolveMime(raw.type, fileName);

      if (!ALLOWED_PREFIXES.some((p) => mimeBase.startsWith(p))) {
        return NextResponse.json({ message: `Tipo não suportado: ${mimeBase}` }, { status: 400 });
      }

      let buffer: Buffer;
      try {
        buffer = await blobToBuffer(raw);
      } catch (err) {
        console.error("[attachments] buffer read error:", err);
        return NextResponse.json({ message: "Erro ao ler arquivo." }, { status: 500 });
      }

      const mediaTypeResolved = resolveMediaType(mimeBase);
      let mediaType: "image" | "audio" | "video" | "document" = mediaTypeResolved;
      let storeBuffer = buffer;
      let uploadMime = mimeBase;
      let uploadName = fileName;
      let sendAsVoice = false;
      let audioDelivery: "voice" | "audio" | "document" | null = null;
      let storeExt = fileName.includes(".") ? fileName.split(".").pop()! : mimeBase.split("/").pop() ?? "bin";

      // Meta Cloud API: remux WebM→Ogg fica no worker-whatsapp (fila
      // meta-attach). Baileys ainda remuxa aqui — o outbound-consumer
      // não prepara áudio.
      if (mediaTypeResolved === "audio" && useBaileys) {
        const inputExt = guessInputExt(mimeBase);
        console.log(`[meta-attach] Convertendo audio ${mimeBase} (.${inputExt}) para formato aceito pela Meta`);
        const prepared = await prepareWhatsAppAudio(buffer, inputExt, fileName);
        if (!prepared.ok) {
          // Único caso restante: buffer vazio. Não aborta mais por FFmpeg.
          console.error(`[meta-attach] preparo de audio falhou: ${prepared.reason}`);
          return NextResponse.json(
            { message: prepared.reason, code: "AUDIO_CONVERT_FAILED" },
            { status: 400 },
          );
        }
        storeBuffer = prepared.payload.buffer;
        uploadMime = prepared.payload.mime;
        uploadName = prepared.payload.fileName;
        sendAsVoice = prepared.payload.voice;
        audioDelivery = prepared.payload.delivery;
        storeExt = prepared.payload.fileName.split(".").pop() || (audioDelivery === "document" ? storeExt : "ogg");
        if (audioDelivery === "document") mediaType = "document";
        console.log(
          `[meta-attach] Preparo OK (${audioDelivery}), ${buffer.length} -> ${storeBuffer.length} bytes | mime=${uploadMime} | voice=${sendAsVoice}`,
        );
      }

      const safeFileName = generateFileName({ prefix: "att", ext: storeExt });

      // PR 1.3: storage prefixado por org. Antes: `public/uploads/<file>`
      // (servido estático sem auth). Agora: `<STORAGE_ROOT>/<orgId>/attachments/<file>`,
      // entregue via `/api/storage/...` com validação de tenant.
      const saved = await saveFile({
        orgId: conv.organizationId,
        bucket: "attachments",
        fileName: safeFileName,
        buffer: storeBuffer,
      });
      const publicUrl = saved.url;

      // ── Send via WhatsApp (Meta Cloud API or Baileys) ──

      let metaSendError: string | null = null;
      let externalId: string | null = null;

      if (useBaileys) {
        const baileysType = sendAsVoice ? "ptt" : mediaType;
        const msgRow = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: conv.id,
            channelId: outboundChannelId ?? undefined,
            content: caption || `📎 ${fileName}`,
            direction: "out",
            messageType: baileysType,
            senderName,
            mediaUrl: publicUrl,
          }),
        });
        const baileysResult = await sendWhatsAppMedia({
          conversationId: conv.id,
          contactId: conv.contactId,
          channelRef: outboundChannelRef,
          messageId: msgRow.id,
          mediaUrl: publicUrl,
          messageType: baileysType,
          caption: caption || undefined,
          waJid: conv.waJid,
        });
        if (baileysResult.failed) metaSendError = baileysResult.error;

        try {
          await prisma.conversation.update({
            where: { id: conv.id },
            data: {
              lastMessageDirection: "out",
              hasAgentReply: true,
              hasHumanReply: true,
              ...(metaSendError ? { hasError: true } : { hasError: false }),
            },
          });
        } catch { /* columns may not exist yet */ }

        fireTrigger("message_sent", {
          contactId: conv.contactId,
          data: { channel: "WhatsApp", content: caption || "[Anexo]" },
        }).catch((err) => console.warn("[automation trigger] message_sent:", err));

        try {
          sseBus.publish("new_message", {
            organizationId: conv.organizationId,
            conversationId: conv.id,
            contactId: conv.contactId,
            direction: "out",
            content: caption || `📎 ${fileName}`,
            timestamp: msgRow.createdAt,
          });
        } catch {
          // best-effort
        }

        cancelPendingForConversation(conv.id, "agent_reply").catch((err) =>
          console.warn(
            "[scheduled-messages] falha ao cancelar apos envio de anexo (baileys):",
            err,
          ),
        );

        return NextResponse.json({
          message: {
            id: msgRow.id,
            content: caption || `📎 ${fileName}`,
            createdAt: msgRow.createdAt.toISOString(),
            direction: "out",
            messageType: baileysType,
            senderName,
            mediaUrl: publicUrl,
            sendStatus: metaSendError ? "failed" : "sent",
          },
          conversationId: conv.id,
          ...(reopenedConversationId ? { reopenedConversationId } : {}),
          ...(audioDelivery ? { audioDelivery } : {}),
        }, { status: 201 });
      }

      const contact = await prisma.contact.findUnique({
        where: { id: conv.contactId },
        select: { phone: true, whatsappBsuid: true },
      });
      const digits = contact?.phone?.replace(/\D/g, "") ?? "";
      const to = digits.length >= 8 ? digits : undefined;
      const recipient = contact?.whatsappBsuid?.trim() || undefined;

      // CRITICO: respeitar o canal RESOLVIDO (com override) em vez do
      // singleton global. Sem isso, midias da org saiam pelo numero do .env
      // -> cross-tenant leak. Com override, o usuário pode escolher por
      // qual número da org enviar (caso `outboundChannelId != conv.channelId`).
      const channelConfig = outboundChannelRef?.config as Record<string, unknown> | null | undefined;
      const metaClient = metaClientFromConfig(channelConfig);

      // Áudio Meta: persiste original + mensagem pending e devolve 201.
      // Remux WebM/Opus → Ogg/Opus e o POST Graph rodam no worker-whatsapp.
      if (mediaTypeResolved === "audio" && metaClient.configured && (to || recipient)) {
        const looksLikeVoice =
          mimeBase.startsWith("audio/webm") ||
          mimeBase.startsWith("audio/ogg") ||
          mimeBase === "audio/opus";
        const pendingType = looksLikeVoice ? "ptt" : "audio";
        const displayContent = caption || "";

        const msgRow = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: conv.id,
            channelId: outboundChannelId ?? undefined,
            content: displayContent,
            direction: "out",
            messageType: pendingType,
            senderName,
            mediaUrl: publicUrl,
            sendStatus: "pending",
          }),
        });

        try {
          await prisma.conversation.update({
            where: { id: conv.id },
            data: {
              lastMessageDirection: "out",
              hasAgentReply: true,
              hasHumanReply: true,
              hasError: false,
            },
          });
        } catch { /* columns may not exist yet */ }

        try {
          sseBus.publish("new_message", {
            organizationId: conv.organizationId,
            conversationId: conv.id,
            contactId: conv.contactId,
            direction: "out",
            content: displayContent,
            timestamp: msgRow.createdAt,
          });
        } catch {
          // best-effort
        }

        cancelPendingForConversation(conv.id, "agent_reply").catch((err) =>
          console.warn(
            "[scheduled-messages] falha ao cancelar apos envio de anexo:",
            err,
          ),
        );

        const jobPayload = {
          conversationId: conv.id,
          messageId: msgRow.id,
          organizationId: conv.organizationId,
          originalName: fileName,
          mime: mimeBase,
          caption,
        };
        const job = await enqueueMetaAttach(jobPayload);
        let sendStatus = "pending";
        let storedType = pendingType;
        let delivery: "voice" | "audio" | "document" | null = null;
        let queuedMetaError: string | null = null;
        if (!job) {
          console.warn("[meta-attach] Redis indisponível — remux+send síncrono na API");
          try {
            const result = await processMetaAttach(jobPayload);
            sendStatus = result.sendStatus;
            storedType = result.messageType;
            delivery = result.audioDelivery;
            queuedMetaError = result.metaError;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : "Falha no envio de áudio";
            await prisma.message
              .updateMany({
                where: { id: msgRow.id, sendStatus: "pending" },
                data: { sendStatus: "failed", sendError: errMsg },
              })
              .catch(() => {});
            await prisma.conversation
              .update({ where: { id: conv.id }, data: { hasError: true } })
              .catch(() => {});
            sendStatus = "failed";
            queuedMetaError = errMsg;
          }
        }

        return NextResponse.json({
          message: {
            id: msgRow.id,
            content: displayContent,
            createdAt: msgRow.createdAt.toISOString(),
            direction: "out",
            messageType: storedType,
            senderName,
            mediaUrl: publicUrl,
            sendStatus,
            status: sendStatus === "failed" ? "FAILED" : sendStatus === "sent" ? "SENT" : "PENDING",
            channelId: outboundChannelId ?? null,
          },
          conversationId: conv.id,
          ...(reopenedConversationId ? { reopenedConversationId } : {}),
          ...(delivery ? { audioDelivery: delivery } : {}),
          ...(queuedMetaError ? { metaError: queuedMetaError } : {}),
        }, { status: 201 });
      }

      if (metaClient.configured && (to || recipient)) {
        try {
          const mediaId = await metaClient.uploadMedia(storeBuffer, uploadMime, uploadName);

          const result = await metaClient.sendMediaById(
            to,
            mediaId,
            mediaType,
            mediaType !== "audio" ? caption || undefined : undefined,
            mediaType === "document" ? fileName : undefined,
            sendAsVoice,
            recipient,
          );

          externalId = result.messages?.[0]?.id ?? null;
          const channelLabel = outboundChannelRef?.id
            ? `channel=${outboundChannelRef.id}`
            : "channel=ENV(global)";
          console.log(
            `[meta-attach] Enviado ${mediaType} (${to ?? "—"}/${recipient ?? "—"}) | ${channelLabel} | mime=${uploadMime} | mediaId=${mediaId} | wamid=${externalId} | voice=${sendAsVoice}`
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
                caption || undefined,
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
      } else if (!metaClient.configured) {
        console.warn(
          `[meta-attach] Meta API nao configurada para o canal (channel=${outboundChannelRef?.id ?? "ENV"}), midia salva apenas localmente`,
        );
      } else if (!to && !recipient) {
        console.warn("[meta-attach] Contato sem telefone nem BSUID WhatsApp");
      }
      void metaWhatsApp;

      const isAudioFile = mediaType === "audio";
      const storedType = sendAsVoice ? "ptt" : mediaType;
      const displayContent = caption || (isAudioFile ? "" : `📎 ${fileName}`);

      await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: conv.id,
          channelId: outboundChannelId ?? undefined,
          content: displayContent,
          direction: "out",
          messageType: storedType,
          senderName,
          mediaUrl: publicUrl,
          ...(externalId ? { externalId } : {}),
          ...(metaSendError ? { sendStatus: "failed", sendError: metaSendError } : {}),
        }),
      });

      try {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: {
            lastMessageDirection: "out",
            hasAgentReply: true,
            hasHumanReply: true,
            ...(metaSendError ? { hasError: true } : { hasError: false }),
          },
        });
      } catch { /* columns may not exist yet */ }

      fireTrigger("message_sent", {
        contactId: conv.contactId,
        data: { channel: "WhatsApp", content: displayContent || "[Anexo]" },
      }).catch((err) => console.warn("[automation trigger] message_sent:", err));

      // Tempo real: notifica abas/inboxes que a conversa mudou (vai pra
      // 'respondidas') sem esperar polling de 15-20s.
      try {
        sseBus.publish("new_message", {
          organizationId: conv.organizationId,
          conversationId: conv.id,
          contactId: conv.contactId,
          direction: "out",
          content: displayContent,
          timestamp: new Date(),
        });
      } catch {
        // best-effort
      }

      cancelPendingForConversation(conv.id, "agent_reply").catch((err) =>
        console.warn(
          "[scheduled-messages] falha ao cancelar apos envio de anexo:",
          err,
        ),
      );

      return NextResponse.json({
        message: {
          id: `att-${timestamp}`,
          content: displayContent,
          createdAt: new Date().toISOString(),
          direction: "out",
          messageType: storedType,
          senderName,
          mediaUrl: publicUrl,
        },
        conversationId: conv.id,
        ...(reopenedConversationId ? { reopenedConversationId } : {}),
        ...(audioDelivery ? { audioDelivery } : {}),
        ...(metaSendError ? { metaError: metaSendError } : {}),
      }, { status: 201 });
    } catch (e: unknown) {
      console.error("[attachments] Unhandled error:", e);
      const msg = e instanceof Error ? e.message : "Erro ao enviar anexo.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
