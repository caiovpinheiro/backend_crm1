/**
 * Injeta o componente HEADER de mídia (IMAGE/VIDEO/DOCUMENT) no payload
 * de envio de template — mesmo contrato usado por automações e campanhas.
 *
 * Extraído de `automation-executor.ts` para o worker de campanhas poder
 * reutilizar sem puxar o executor inteiro.
 *
 * Preferimos sempre `{ id }` (upload no phone number) em vez de `{ link }`:
 * a Meta costuma devolver 132012 "expected IMAGE, received UNKNOWN" quando
 * o crawler dela não classifica o arquivo baixado do `link` (CDN própria,
 * headers atípicos, etc.), mesmo com Content-Type correto num GET externo.
 */

import { toAbsolutePublicMediaUrl } from "@/lib/meta-whatsapp/to-absolute-public-media-url";
import { resolveTemplateHeaderMediaFormat } from "@/lib/meta-whatsapp/enrich-template-flow";
import type { MetaWhatsAppClient } from "@/lib/meta-whatsapp/client";

export class TemplateHeaderMediaError extends Error {
  readonly name = "TemplateHeaderMediaError";
  constructor(message: string) {
    super(message);
  }
}

const HEADER_MEDIA_FETCH_TIMEOUT_MS = 20_000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function fileNameFromUrl(url: string, mediaType: string): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").filter(Boolean).pop() || "";
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return decodeURIComponent(base);
  } catch {
    /* ignore */
  }
  const ext =
    mediaType === "video" ? "mp4" : mediaType === "document" ? "pdf" : "png";
  return `header.${ext}`;
}

function mimeMatchesMediaType(
  mimeType: string,
  mediaType: "image" | "video" | "document",
): boolean {
  const m = mimeType.toLowerCase();
  if (mediaType === "image") return m.startsWith("image/");
  if (mediaType === "video") return m.startsWith("video/");
  // document: pdf, ms* , openxml, etc.
  return (
    m === "application/pdf" ||
    m.startsWith("application/") ||
    m.startsWith("text/") ||
    m.startsWith("image/") // alguns docs são imagem escaneada
  );
}

/** Baixa URL pública e devolve bytes p/ upload na Meta. */
async function fetchPublicMediaBytes(
  mediaUrl: string,
  mediaType: "image" | "video" | "document",
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const absolute = toAbsolutePublicMediaUrl(mediaUrl);
  // Custom field / URL digitada pelo operador — evita SSRF ao baixar no worker.
  const { assertSafeOutboundUrl } = await import("@/lib/safe-outbound-url");
  try {
    await assertSafeOutboundUrl(absolute);
  } catch (err) {
    throw new TemplateHeaderMediaError(
      `header de template: URL de mídia bloqueada (${absolute}): ${err instanceof Error ? err.message : err}`,
    );
  }

  let res: Response;
  try {
    res = await fetch(absolute, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(HEADER_MEDIA_FETCH_TIMEOUT_MS),
      headers: {
        // Alguns CDNs respondem UNKNOWN à Meta sem User-Agent de browser.
        Accept: "image/*,video/*,application/pdf,*/*",
        "User-Agent": "BWIPO-CRM-TemplateHeader/1.0",
      },
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    ) {
      throw new TemplateHeaderMediaError(
        `header de template: tempo limite ao baixar a mídia (${HEADER_MEDIA_FETCH_TIMEOUT_MS}ms): ${absolute}`,
      );
    }
    throw new TemplateHeaderMediaError(
      `header de template: falha ao baixar a mídia (${absolute}): ${err instanceof Error ? err.message : err}`,
    );
  }

  if (!res.ok) {
    throw new TemplateHeaderMediaError(
      `header de template: HTTP ${res.status} ao baixar a mídia (${absolute})`,
    );
  }

  const mimeType =
    (res.headers.get("content-type") || "").split(";")[0].trim() ||
    "application/octet-stream";
  if (!mimeMatchesMediaType(mimeType, mediaType)) {
    throw new TemplateHeaderMediaError(
      `header de template: Content-Type "${mimeType}" incompatível com header ${mediaType.toUpperCase()} (${absolute})`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new TemplateHeaderMediaError(
      `header de template: arquivo vazio em ${absolute}`,
    );
  }

  return {
    buffer,
    mimeType,
    fileName: fileNameFromUrl(absolute, mediaType),
  };
}

/**
 * Resolve parâmetro de mídia do header.
 * Sempre prefere `{ id }` (upload no phone number da Meta) — evita 132012
 * "expected IMAGE, received UNKNOWN" do caminho `{ link }`.
 */
export async function resolveTemplateHeaderMediaParam(
  client: MetaWhatsAppClient,
  mediaUrl: string,
  mediaType: "image" | "video" | "document",
): Promise<{ link: string } | { id: string }> {
  const trimmed = mediaUrl.trim();
  const { isOrgOwnedStorageUrl, readStoredMediaForSend } = await import(
    "@/lib/storage/read-for-send"
  );

  if (isOrgOwnedStorageUrl(trimmed)) {
    const stored = await readStoredMediaForSend(trimmed);
    if (!stored) {
      throw new TemplateHeaderMediaError(
        `header de template: arquivo não encontrado em storage (${trimmed})`,
      );
    }
    const metaMediaId = await client.uploadMedia(
      stored.buffer,
      stored.mimeType,
      stored.fileName,
    );
    return { id: metaMediaId };
  }

  if (trimmed.startsWith("https://") || trimmed.startsWith("/")) {
    const fetched = await fetchPublicMediaBytes(trimmed, mediaType);
    const metaMediaId = await client.uploadMedia(
      fetched.buffer,
      fetched.mimeType,
      fetched.fileName,
    );
    return { id: metaMediaId };
  }

  throw new TemplateHeaderMediaError(
    `header de template: URL inválida para ${mediaType} (use HTTPS público ou upload interno): ${trimmed}`,
  );
}

/**
 * Descobre o formato do header na Graph e injeta o parâmetro de mídia.
 * Se o template não exige mídia, devolve `components` intacto.
 */
export async function injectTemplateHeaderMediaComponent(
  client: MetaWhatsAppClient,
  args: {
    templateName: string;
    languageCode: string;
    templateGraphId: string | null;
    components: unknown[] | undefined;
    headerMediaUrl: string | null;
    headerMediaType?: "image" | "video" | "document" | null;
  },
): Promise<unknown[] | undefined> {
  const fromGraph = await resolveTemplateHeaderMediaFormat(client, {
    templateName: args.templateName,
    languageCode: args.languageCode,
    templateGraphId: args.templateGraphId,
  });
  const headerFormat =
    fromGraph ?? args.headerMediaType?.toUpperCase() ?? null;

  if (
    headerFormat !== "IMAGE" &&
    headerFormat !== "VIDEO" &&
    headerFormat !== "DOCUMENT"
  ) {
    // URL informada mas a Graph não confirmou o format e o chamador não
    // passou headerMediaType — falhar cedo em vez de enviar sem header
    // (132012) ou parecer “erro de phone number”.
    if (args.headerMediaUrl?.trim()) {
      throw new TemplateHeaderMediaError(
        `template "${args.templateName}": headerMediaUrl informado, mas o formato do cabeçalho não foi resolvido (Graph/headerMediaType). Use IMAGE, VIDEO ou DOCUMENT.`,
      );
    }
    return args.components;
  }

  if (!args.headerMediaUrl?.trim()) {
    throw new TemplateHeaderMediaError(
      `template "${args.templateName}" exige header ${headerFormat}; informe a URL (ou campo do CRM) da mídia.`,
    );
  }

  const mediaType = headerFormat.toLowerCase() as
    | "image"
    | "video"
    | "document";
  const mediaParam = await resolveTemplateHeaderMediaParam(
    client,
    args.headerMediaUrl,
    mediaType,
  );
  const headerComponent: Record<string, unknown> = {
    type: "header",
    parameters: [{ type: mediaType, [mediaType]: mediaParam }],
  };

  const withoutExistingHeader = (args.components ?? []).filter((c) => {
    const o = asRecord(c);
    return String(o?.type ?? "").toLowerCase() !== "header";
  });

  return [headerComponent, ...withoutExistingHeader];
}
