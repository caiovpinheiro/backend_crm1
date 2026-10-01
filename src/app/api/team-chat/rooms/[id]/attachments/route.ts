import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { sniffAttachment } from "@/lib/file-sniff";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { denyUnless, jsonError, viewerOf } from "../../../_guard";
import { isOwnedStorageUrl, type TeamChatAttachmentKind } from "@/services/team-chat";
import { prisma } from "@/lib/prisma";

const MAX_FILE_SIZE = 16 * 1024 * 1024;
// SEC2-3: allowlist aplicada ao MIME DETECTADO por magic bytes (nunca ao
// Content-Type do cliente). `application/octet-stream` saiu — binário
// não reconhecido (exe, js, html renomeado) é recusado.
const ALLOWED_PREFIXES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument",
  "application/zip",
  "text/plain",
  "text/csv",
];

function isFileLike(v: unknown): v is Blob & { name?: string } {
  return (
    v instanceof Blob ||
    (typeof v === "object" &&
      v !== null &&
      typeof (v as Blob).arrayBuffer === "function" &&
      typeof (v as Blob).size === "number")
  );
}

function kindFromMime(mime: string, asSticker: boolean): TeamChatAttachmentKind {
  if (asSticker && mime.startsWith("image/")) return "sticker";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withOrgContext(async (session) => {
    const denied = await denyUnless(session, "team_chat:send");
    if (denied) return denied;
    const viewer = viewerOf(session);
    const { id: roomId } = await params;

    const member = await prisma.teamChatMember.findFirst({
      where: { roomId, userId: viewer.userId },
      select: { id: true },
    });
    if (!member) return jsonError("Conversa não encontrada.", 404);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonError("Erro ao processar upload.", 400);
    }

    const raw = form.get("file");
    if (!isFileLike(raw)) return jsonError("Arquivo obrigatório.", 400);
    if (raw.size > MAX_FILE_SIZE) return jsonError("Arquivo muito grande (máx 16 MB).", 400);

    const fileName = (raw as File).name || "arquivo";
    const buffer = Buffer.from(await raw.arrayBuffer());
    // Tipo real pelos magic bytes; nome/Content-Type só desempatam containers.
    const sniffed = sniffAttachment(buffer, { mime: raw.type, fileName });
    if (!sniffed || !ALLOWED_PREFIXES.some((p) => sniffed.mime.startsWith(p))) {
      return jsonError("Tipo de arquivo não suportado ou conteúdo não reconhecido.", 415);
    }
    const mime = sniffed.mime;

    const asSticker = form.get("sticker") === "1" || form.get("sticker") === "true";
    const safeFileName = generateFileName({ prefix: "orbita", ext: sniffed.ext });
    const saved = await saveFile({
      orgId: viewer.organizationId,
      bucket: "attachments",
      fileName: safeFileName,
      buffer,
    });

    if (!isOwnedStorageUrl(saved.url, viewer.organizationId)) {
      return jsonError("Falha ao gravar anexo.", 500);
    }

    return NextResponse.json({
      attachment: {
        url: saved.url,
        name: fileName,
        mimeType: mime,
        size: raw.size,
        kind: kindFromMime(mime, asSticker),
      },
    });
  });
}
