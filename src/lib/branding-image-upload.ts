import { extForMime, sniffImageMime, type SniffedImageMime } from "@/lib/file-sniff";

export type BrandingImageUpload =
  | { ok: true; buffer: Buffer; mimeType: SniffedImageMime; ext: string }
  | { ok: false; status: number; message: string };

/**
 * Imagem de marca enviada em multipart, no campo `file`. Valida pelos magic bytes,
 * sem confiar no Content-Type. Recusa SVG (vetor de XSS) e tudo que não for
 * JPEG, PNG, WEBP ou GIF.
 */
export async function readBrandingImageUpload(
  request: Request,
  maxBytes: number,
): Promise<BrandingImageUpload> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, status: 400, message: "Erro ao processar upload." };
  }
  const raw = form.get("file");
  if (!raw || !(raw instanceof Blob)) {
    return { ok: false, status: 400, message: 'Envie a imagem no campo "file".' };
  }
  if (raw.size > maxBytes) {
    return {
      ok: false,
      status: 413,
      message: `Imagem excede o limite de ${maxBytes / 1024 / 1024} MB.`,
    };
  }
  const buffer = Buffer.from(await raw.arrayBuffer());
  const mimeType = sniffImageMime(buffer);
  if (!mimeType) {
    return { ok: false, status: 415, message: "Envie uma imagem JPG, PNG, WEBP ou GIF." };
  }
  return { ok: true, buffer, mimeType, ext: extForMime(mimeType) };
}
