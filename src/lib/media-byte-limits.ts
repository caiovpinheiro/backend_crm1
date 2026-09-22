/**
 * Tetos de bytes para proxy Meta, transcrição e re-hospedagem.
 * Upload de conversa já limita 16 MB; vídeo no proxy precisa de teto maior.
 */

export const MEDIA_PROCESS_MAX_BYTES = 16 * 1024 * 1024;
export const MEDIA_PROXY_MAX_BYTES = 50 * 1024 * 1024;
export const RECORDING_FETCH_MAX_BYTES = 64 * 1024 * 1024;

export class MediaTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Arquivo excede o limite de ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
    this.name = "MediaTooLargeError";
  }
}

export function contentLengthExceeds(res: Response, maxBytes: number): boolean {
  const raw = res.headers.get("content-length");
  if (raw == null || raw === "") return false;
  const len = Number(raw);
  return Number.isFinite(len) && len > maxBytes;
}

export async function readResponseBodyLimited(
  res: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (contentLengthExceeds(res, maxBytes)) {
    throw new MediaTooLargeError(maxBytes);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new MediaTooLargeError(maxBytes);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new MediaTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Corta o stream do proxy se o upstream omitir Content-Length. */
export function limitReadableStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new MediaTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
