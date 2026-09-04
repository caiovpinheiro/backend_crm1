import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { getContactChannelSession, getConversationSession } from "@/lib/channel-session";
import { requireConversationAccess } from "@/lib/conversation-access";
import { resolveOutboundChannel } from "@/lib/outbound-channel";
import {
  WHATSAPP_VIDEO_MAX_BYTES,
  WHATSAPP_VIDEO_TOO_LARGE_MESSAGE,
} from "@/lib/audio-convert";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { enqueueMetaAttach } from "@/lib/queue";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { sendWhatsAppMedia, isBaileysChannel } from "@/lib/send-whatsapp";
import { sseBus } from "@/lib/sse-bus";
import {
  generateFileName,
  locateReusableStoredObject,
  resolveOrgOwnedReuseUrl,
  resolveOutboundAttachmentMime,
  reuseFileNameAliases,
  saveFile,
  statStoredFile,
  type OrgOwnedReuseUrl,
} from "@/lib/storage/local";
import { readUpstreamFallbackBytes } from "@/lib/storage/upstream-fallback";
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
 * Derive a reliable MIME from blob type + filename(s).
 * `.mp4` / "WhatsApp Video" are video — never audio/mp4 from audio-convert.
 */
function resolveMime(rawType: string, ...fileNames: string[]): string {
  return resolveOutboundAttachmentMime({ rawType, fileNames });
}

type AttachmentSource =
  | {
      mode: "upload";
      file: Blob & { name?: string };
      caption: string;
      requestedChannelId: string | null;
    }
  | {
      mode: "reuse";
      publicUrl: string;
      fileName: string;
      mimeBase: string;
      caption: string;
      requestedChannelId: string | null;
    };

function readChannelId(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function urlsFromTemplateAttachments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const url = (item as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) out.push(url.trim());
  }
  return out;
}

/** Outra URL gravada no modelo (path legado / bucket diferente). */
async function locateFromTemplateRow(
  orgId: string,
  parsedReuse: OrgOwnedReuseUrl,
): Promise<OrgOwnedReuseUrl | null> {
  const fileName = parsedReuse.fileName;
  const rows = await prisma.messageTemplate.findMany({
    where: {
      organizationId: orgId,
      OR: [
        { mediaUrl: parsedReuse.url },
        { mediaUrl: { contains: fileName } },
      ],
    },
    select: { mediaUrl: true, attachments: true },
    take: 8,
  });
  const seen = new Set<string>([parsedReuse.url]);
  for (const row of rows) {
    const candidates = [
      ...(typeof row.mediaUrl === "string" ? [row.mediaUrl] : []),
      ...urlsFromTemplateAttachments(row.attachments),
    ];
    for (const raw of candidates) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      const parsed = resolveOrgOwnedReuseUrl(raw, orgId);
      if (!parsed) continue;
      const hit = await locateReusableStoredObject(parsed);
      if (hit) {
        console.warn(
          "[attachments] reuse via template row",
          orgId,
          hit.bucket,
          hit.fileName,
        );
        return hit;
      }
    }
  }
  return null;
}

async function parseAttachmentRequest(
  request: Request,
  orgId: string,
): Promise<{ ok: true; source: AttachmentSource } | { ok: false; response: NextResponse }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return {
        ok: false,
        response: NextResponse.json({ message: "JSON inválido." }, { status: 400 }),
      };
    }
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const parsedReuse = resolveOrgOwnedReuseUrl(
      typeof rec.reuseUrl === "string" ? rec.reuseUrl : "",
      orgId,
    );
    if (!parsedReuse) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            message:
              "URL de mídia inválida. Só é possível reutilizar arquivos do storage desta organização.",
          },
          { status: 400 },
        ),
      };
    }
    let resolved = await locateReusableStoredObject(parsedReuse);
    if (!resolved) {
      const fromTemplate = await locateFromTemplateRow(orgId, parsedReuse);
      if (fromTemplate) resolved = fromTemplate;
    }
    if (!resolved) {
      // GET /api/storage ainda 200 via STORAGE_FALLBACK_URL (arquivo só
      // no backend legado). Reuse só via Spaces — 404. Importa o body
      // para a key canônica e segue por referência. Env vazia retorna
      // imediatamente. Vídeo: 15s (700ms não baixa mp4).
      const cookie = request.headers.get("cookie");
      const names = reuseFileNameAliases(parsedReuse.fileName);
      let imported: Buffer | null = null;
      let importName = parsedReuse.fileName;
      for (const fileName of names) {
        const joined = `${parsedReuse.orgId}/${parsedReuse.bucket}/${fileName}`;
        imported = await readUpstreamFallbackBytes(joined, cookie);
        if (imported) {
          importName = fileName;
          break;
        }
      }
      if (imported) {
        if (
          imported.length > WHATSAPP_VIDEO_MAX_BYTES &&
          resolveMime("", importName, parsedReuse.fileName).startsWith("video/")
        ) {
          return {
            ok: false,
            response: NextResponse.json(
              {
                message: WHATSAPP_VIDEO_TOO_LARGE_MESSAGE,
                code: "WHATSAPP_VIDEO_TOO_LARGE",
              },
              { status: 413 },
            ),
          };
        }
        const saved = await saveFile({
          orgId: parsedReuse.orgId,
          bucket: parsedReuse.bucket,
          fileName: importName,
          buffer: imported,
        });
        console.warn(
          "[attachments] reuse imported from STORAGE_FALLBACK_URL",
          parsedReuse.orgId,
          parsedReuse.bucket,
          importName,
        );
        resolved = {
          url: saved.url,
          orgId: parsedReuse.orgId,
          bucket: parsedReuse.bucket,
          fileName: importName,
        };
      }
    }
    if (!resolved) {
      console.warn(
        "[attachments] reuse miss",
        parsedReuse.orgId,
        parsedReuse.bucket,
        parsedReuse.fileName,
      );
      return {
        ok: false,
        response: NextResponse.json(
          {
            message:
              "Mídia do modelo não está no storage. Abra o modelo e envie o arquivo de novo.",
            code: "TEMPLATE_MEDIA_MISSING",
          },
          { status: 404 },
        ),
      };
    }
    const fileName =
      typeof rec.fileName === "string" && rec.fileName.trim()
        ? rec.fileName.trim().slice(0, 255)
        : resolved.fileName;
    const clientMime =
      typeof rec.mimeType === "string"
        ? rec.mimeType
        : typeof rec.mediaType === "string"
          ? rec.mediaType
          : "";
    const mimeBase = resolveMime(
      clientMime,
      fileName,
      resolved.fileName,
      parsedReuse.fileName,
    );
    if (mimeBase.startsWith("video/") && !resolved.legacyRelative) {
      const st = await statStoredFile(resolved.orgId, resolved.bucket, resolved.fileName);
      if (st && st.size > WHATSAPP_VIDEO_MAX_BYTES) {
        return {
          ok: false,
          response: NextResponse.json(
            {
              message: WHATSAPP_VIDEO_TOO_LARGE_MESSAGE,
              code: "WHATSAPP_VIDEO_TOO_LARGE",
            },
            { status: 413 },
          ),
        };
      }
    }
    if (!ALLOWED_PREFIXES.some((p) => mimeBase.startsWith(p))) {
      return {
        ok: false,
        response: NextResponse.json(
          { message: `Tipo não suportado: ${mimeBase}` },
          { status: 400 },
        ),
      };
    }
    return {
      ok: true,
      source: {
        mode: "reuse",
        publicUrl: resolved.url,
        fileName,
        mimeBase,
        caption: typeof rec.caption === "string" ? rec.caption : "",
        requestedChannelId: readChannelId(rec.channelId),
      },
    };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error("[attachments] formData parse error:", err);
    return {
      ok: false,
      response: NextResponse.json({ message: "Erro ao processar upload." }, { status: 400 }),
    };
  }

  const raw = form.get("file");
  if (!raw || !isFileLike(raw) || raw.size === 0) {
    return {
      ok: false,
      response: NextResponse.json({ message: "Nenhum arquivo enviado." }, { status: 400 }),
    };
  }

  return {
    ok: true,
    source: {
      mode: "upload",
      file: raw,
      caption: (form.get("caption") as string) ?? "",
      requestedChannelId: readChannelId(form.get("channelId")),
    },
  };
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

      const parsed = await parseAttachmentRequest(request, conv.organizationId);
      if (!parsed.ok) return parsed.response;
      const source = parsed.source;
      const caption = source.caption;
      const requestedChannelId = source.requestedChannelId;

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

      const senderName = session.user.name ?? session.user.email ?? "Agente";

      let fileName: string;
      let mimeBase: string;
      let publicUrl: string;

      if (source.mode === "reuse") {
        // Send-by-reference: aponta message.mediaUrl para o arquivo já
        // armazenado (biblioteca / automation-media). Não copia o blob.
        fileName = source.fileName;
        mimeBase = source.mimeBase;
        publicUrl = source.publicUrl;
      } else {
        const raw = source.file;
        if (raw.size > MAX_FILE_SIZE) {
          return NextResponse.json({ message: "Arquivo muito grande (máx 16 MB)." }, { status: 400 });
        }

        fileName = raw.name || "file";
        mimeBase = resolveMime(raw.type, fileName);

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

        const storeExt = fileName.includes(".")
          ? fileName.split(".").pop()!
          : mimeBase.split("/").pop() ?? "bin";
        const safeFileName = generateFileName({ prefix: "att", ext: storeExt });

        // PR 1.3: storage prefixado por org. Antes: `public/uploads/<file>`
        // (servido estático sem auth). Agora: `<STORAGE_ROOT>/<orgId>/attachments/<file>`,
        // entregue via `/api/storage/...` com validação de tenant.
        const saved = await saveFile({
          orgId: conv.organizationId,
          bucket: "attachments",
          fileName: safeFileName,
          buffer,
        });
        publicUrl = saved.url;
      }

      const mediaTypeResolved = resolveMediaType(mimeBase);
      const looksLikeVoice =
        mimeBase.startsWith("audio/webm") ||
        mimeBase.startsWith("audio/ogg") ||
        mimeBase === "audio/opus";

      // ── Send via WhatsApp (Meta Cloud API or Baileys) ──

      if (useBaileys) {
        const isAudio = mediaTypeResolved === "audio";
        const baileysType = isAudio
          ? looksLikeVoice ? "ptt" : "audio"
          : mediaTypeResolved;
        const displayContent =
          isAudio ? caption || "" : caption || `📎 ${fileName}`;
        const msgRow = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: conv.id,
            channelId: outboundChannelId ?? undefined,
            content: displayContent,
            direction: "out",
            messageType: baileysType,
            senderName,
            mediaUrl: publicUrl,
            ...(isAudio ? { sendStatus: "pending" } : {}),
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
          mime: mimeBase,
          originalName: fileName,
        });
        const metaSendError = baileysResult.failed ? baileysResult.error : null;
        if (metaSendError) {
          await prisma.message
            .updateMany({
              where: { id: msgRow.id, sendStatus: isAudio ? "pending" : undefined },
              data: { sendStatus: "failed", sendError: metaSendError },
            })
            .catch(() => {});
        }

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
            content: displayContent,
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
            content: displayContent,
            createdAt: msgRow.createdAt.toISOString(),
            direction: "out",
            messageType: baileysType,
            senderName,
            mediaUrl: publicUrl,
            sendStatus: metaSendError ? "failed" : isAudio ? "pending" : "sent",
          },
          conversationId: conv.id,
          ...(reopenedConversationId ? { reopenedConversationId } : {}),
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

      // Meta: persiste original + mensagem pending e devolve 201.
      // Upload Graph + sendMediaById (e remux de áudio) rodam no worker-whatsapp.
      if (metaClient.configured && (to || recipient)) {
        const pendingType =
          mediaTypeResolved === "audio"
            ? looksLikeVoice ? "ptt" : "audio"
            : mediaTypeResolved;
        const displayContent =
          mediaTypeResolved === "audio" ? caption || "" : caption || `📎 ${fileName}`;

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
          kind: mediaTypeResolved,
        };
        const job = await enqueueMetaAttach(jobPayload);
        let sendStatus = "pending";
        let storedType = pendingType;
        let delivery: "voice" | "audio" | "document" | null = null;
        let queuedMetaError: string | null = null;
        if (!job) {
          const errMsg = "Fila de envio indisponível (Redis). Tente novamente.";
          console.warn("[meta-attach] enqueue falhou — marcando failed (sem sync na API)");
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

      if (!metaClient.configured) {
        console.warn(
          `[meta-attach] Meta API nao configurada para o canal (channel=${outboundChannelRef?.id ?? "ENV"}), midia salva apenas localmente`,
        );
      } else if (!to && !recipient) {
        console.warn("[meta-attach] Contato sem telefone nem BSUID WhatsApp");
      }

      const displayContent =
        mediaTypeResolved === "audio" ? caption || "" : caption || `📎 ${fileName}`;

      const localMsg = await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: conv.id,
          channelId: outboundChannelId ?? undefined,
          content: displayContent,
          direction: "out",
          messageType: mediaTypeResolved === "audio" && looksLikeVoice ? "ptt" : mediaTypeResolved,
          senderName,
          mediaUrl: publicUrl,
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

      fireTrigger("message_sent", {
        contactId: conv.contactId,
        data: { channel: "WhatsApp", content: displayContent || "[Anexo]" },
      }).catch((err) => console.warn("[automation trigger] message_sent:", err));

      try {
        sseBus.publish("new_message", {
          organizationId: conv.organizationId,
          conversationId: conv.id,
          contactId: conv.contactId,
          direction: "out",
          content: displayContent,
          timestamp: localMsg.createdAt,
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
          id: localMsg.id,
          content: displayContent,
          createdAt: localMsg.createdAt.toISOString(),
          direction: "out",
          messageType: localMsg.messageType,
          senderName,
          mediaUrl: publicUrl,
        },
        conversationId: conv.id,
        ...(reopenedConversationId ? { reopenedConversationId } : {}),
      }, { status: 201 });
    } catch (e: unknown) {
      console.error("[attachments] Unhandled error:", e);
      const msg = e instanceof Error ? e.message : "Erro ao enviar anexo.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
