/**
 * Anexo e áudio gravado no grupo WhatsApp (canal QR). Mesmo tratamento do
 * anexo do inbox: tipo pelos magic bytes, 16 MB, arquivo no storage da org,
 * envio pelo worker Baileys. Não espera o worker (o proxy corta ~10–15 s).
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { ATTACHMENT_MAX_BYTES, isAllowedAttachmentMime } from "@/lib/attachment-allowlist";
import { WHATSAPP_VIDEO_MAX_BYTES, WHATSAPP_VIDEO_TOO_LARGE_MESSAGE } from "@/lib/audio-convert";
import { sniffAttachment } from "@/lib/file-sniff";
import { getLogger } from "@/lib/logger";
import { enqueueBaileysOutbound } from "@/lib/queue";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { generateFileName, resolveOutboundAttachmentMime, saveFile } from "@/lib/storage/local";
import { groupAttachmentMessageType, groupAttachmentText } from "@/lib/whatsapp-group-attachment";
import {
  appendWhatsAppGroupMessage,
  findConnectedBaileysChannel,
  getWhatsAppGroup,
} from "@/services/whatsapp-groups";

export const dynamic = "force-dynamic";

const log = getLogger("whatsapp-groups");

type RouteContext = { params: Promise<{ id: string }> };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// `runWithContext` (withOrgContext) e não só o `enterWith` do requireAuth:
// depois de ler o corpo (`formData`/`json`) o contexto da org se perdia e
// `getOrgIdOrThrow` estourava — 500 sem corpo ("Servidor temporariamente
// indisponível") e mensagem enviada sem entrar no histórico do grupo.
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "whatsapp_group:send");
    if (denied) return denied;

    const channel = await findConnectedBaileysChannel();
    if (!channel) {
      return NextResponse.json({ message: "Conecte um WhatsApp QR Code em Canais." }, { status: 409 });
    }

    const { id } = await context.params;
    const group = await getWhatsAppGroup(id, channel.id);
    if (!group) {
      return NextResponse.json({ message: "Grupo não encontrado." }, { status: 404 });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ message: "Envie o arquivo como formulário." }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof Blob) || file.size === 0) {
      return NextResponse.json({ message: "Arquivo obrigatório." }, { status: 400 });
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      return NextResponse.json({ message: "Arquivo muito grande (máx 16 MB)." }, { status: 400 });
    }
    const caption = typeof form.get("caption") === "string" ? String(form.get("caption")).slice(0, 1024) : "";
    const fileName =
      (typeof (file as Blob & { name?: string }).name === "string" && (file as Blob & { name?: string }).name?.trim()) ||
      "arquivo";

    const buffer = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffAttachment(buffer, {
      mime: resolveOutboundAttachmentMime({ rawType: file.type, fileNames: [fileName] }),
      fileName,
    });
    if (!sniffed || !isAllowedAttachmentMime(sniffed.mime)) {
      return NextResponse.json(
        { message: "Tipo de arquivo não suportado ou conteúdo não reconhecido." },
        { status: 415 },
      );
    }
    if (sniffed.mime.startsWith("video/") && buffer.length > WHATSAPP_VIDEO_MAX_BYTES) {
      return NextResponse.json(
        { message: WHATSAPP_VIDEO_TOO_LARGE_MESSAGE, code: "WHATSAPP_VIDEO_TOO_LARGE" },
        { status: 413 },
      );
    }

    const orgId = getOrgIdOrThrow();
    let saved: { url: string };
    try {
      saved = await saveFile({
        orgId,
        bucket: "attachments",
        fileName: generateFileName({ prefix: "att", ext: sniffed.ext }),
        buffer,
      });
    } catch (err) {
      log.error({ groupId: group.id, err: errMessage(err) }, "[whatsapp-groups] falha ao guardar anexo");
      return NextResponse.json({ message: "Não foi possível guardar o arquivo. Tente de novo." }, { status: 500 });
    }

    const messageType = groupAttachmentMessageType(sniffed.mime);
    const job = await enqueueBaileysOutbound({
      channelId: channel.id,
      to: group.jid,
      // Documento: o worker usa `content` como nome do arquivo no WhatsApp.
      content: messageType === "document" ? fileName : caption.trim(),
      mediaUrl: saved.url,
      messageType,
      mime: sniffed.mime,
      originalName: fileName,
    });
    if (!job) {
      return NextResponse.json({ message: "Fila indisponível. Tente de novo." }, { status: 503 });
    }

    let message: Awaited<ReturnType<typeof appendWhatsAppGroupMessage>> = null;
    try {
      message = await appendWhatsAppGroupMessage({
        organizationId: orgId,
        groupId: group.id,
        fromJid: channel.phoneNumber ? `${channel.phoneNumber.replace(/\D/g, "")}@s.whatsapp.net` : "me",
        fromName: session.user.name ?? "Você",
        fromPhone: channel.phoneNumber,
        fromMe: true,
        text: groupAttachmentText(messageType, fileName, caption),
        messageType,
        mediaUrl: saved.url,
        mimeType: sniffed.mime,
        fileName,
      });
    } catch (err) {
      log.error(
        { groupId: group.id, jobId: job.id, err: errMessage(err) },
        "[whatsapp-groups] anexo enfileirado, mas não gravado no histórico",
      );
    }
    return NextResponse.json({ ok: true, groupId: group.id, message });
  });
}
