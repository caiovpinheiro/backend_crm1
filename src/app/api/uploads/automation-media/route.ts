import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  extForMime,
  sniffAttachment,
  sniffAudioMime,
  sniffDocMime,
  sniffImageMime,
  sniffVideoMime,
  type SniffedMime,
} from "@/lib/file-sniff";
import { generateFileName, saveFile, storageDriver } from "@/lib/storage/local";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/uploads/automation-media");

const MAX_FILE_SIZE = 16 * 1024 * 1024;

// Defesa em profundidade: em vez de aceitar o Content-Type do cliente
// (facilmente falsificável), inspeciona os magic bytes do arquivo.
// SVG, HTML, docs Office e binários arbitrários caem em `null` e são
// rejeitados aqui — o storage já serve o MIME derivado da extensão
// (ver storage/local.ts `mimeFromFilename`) então também eliminamos
// qualquer discrepância entre `Content-Type` armazenado e o real.
function sniffMime(buf: Buffer): SniffedMime | null {
  return (
    sniffImageMime(buf) ??
    sniffVideoMime(buf) ??
    sniffAudioMime(buf) ??
    sniffDocMime(buf) ??
    null
  );
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const orgId = (session.user as { organizationId?: string | null }).organizationId ?? null;
    if (!orgId) {
      return NextResponse.json(
        { message: "Selecione uma organização antes de subir mídia." },
        { status: 400 },
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { message: "Erro ao processar upload." },
        { status: 400 },
      );
    }

    const raw = form.get("file");
    if (!raw || !(raw instanceof Blob)) {
      return NextResponse.json(
        { message: 'Envie o arquivo no campo "file".' },
        { status: 400 },
      );
    }

    const file = raw as Blob & { name?: string };
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { message: `Arquivo excede o limite de ${MAX_FILE_SIZE / 1024 / 1024} MB.` },
        { status: 413 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const origName = (file as { name?: string }).name ?? "file";
    const sniffed = sniffMime(buffer);
    const office = sniffed
      ? null
      : sniffAttachment(buffer, { fileName: origName, mime: file.type });
    if (!sniffed && (!office || office.mime === "application/zip")) {
      return NextResponse.json(
        {
          message:
            "Tipo de arquivo não permitido. Aceito: imagem, vídeo, áudio, PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT ou CSV.",
        },
        { status: 415 },
      );
    }

    const mime = sniffed ?? office!.mime;
    const ext = sniffed ? extForMime(sniffed) : office!.ext;
    const safeName = generateFileName({ prefix: "auto", ext });

    const saved = await saveFile({
      orgId,
      bucket: "automation-media",
      fileName: safeName,
      buffer,
    });
    log.info(
      { driver: storageDriver(), absolutePath: saved.absolutePath, bytes: buffer.length },
      "[automation-media] saved",
    );
    return NextResponse.json({ url: saved.url, fileName: origName, mimeType: mime });
  } catch (e) {
    log.error({ err: e }, "[automation-media] upload error");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro interno." },
      { status: 500 },
    );
  }
}
