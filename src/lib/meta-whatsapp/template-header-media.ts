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
import {
  resolveTemplateHeaderMediaExample,
  resolveTemplateHeaderMediaFormat,
} from "@/lib/meta-whatsapp/enrich-template-flow";
import type { MetaWhatsAppClient } from "@/lib/meta-whatsapp/client";
import { getLogger } from "@/lib/logger";

const log = getLogger("meta-whatsapp.template-header-media");

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

  // Nome curto e estável — evita filename=hash enorme no multipart da Meta.
  const ext =
    mediaType === "video" ? "mp4" : mediaType === "document" ? "pdf" : "png";
  const fromUrl = fileNameFromUrl(absolute, mediaType);
  const fileName = /\.(jpe?g|png|gif|webp|mp4|pdf)$/i.test(fromUrl)
    ? `header.${fromUrl.split(".").pop()!.toLowerCase()}`
    : `header.${ext}`;

  return {
    buffer,
    mimeType,
    fileName,
  };
}

/** Diagnóstico do header montado (aparece no erro 132012 / logs do worker). */
export function describeTemplateHeaderMedia(
  components: unknown[] | undefined,
): string {
  if (!Array.isArray(components)) return "missing";
  for (const c of components) {
    const o = asRecord(c);
    if (String(o?.type ?? "").toLowerCase() !== "header") continue;
    const params = Array.isArray(o.parameters) ? o.parameters : [];
    const p0 = asRecord(params[0]);
    if (!p0) return "header-empty";
    const pType = String(p0.type ?? "").toLowerCase();
    const media = asRecord(p0[pType] ?? p0.image ?? p0.video ?? p0.document);
    if (!media) return `header-type=${pType || "?"} sem objeto`;
    if (typeof media.id === "string" && media.id.trim()) {
      return `id:${media.id.trim().slice(0, 12)}`;
    }
    if (typeof media.link === "string" && media.link.trim()) {
      return `link`;
    }
    return `header-type=${pType || "?"} sem id/link`;
  }
  return "no-header";
}

/**
 * Resolve parâmetro de mídia do header.
 * Sempre faz upload e devolve `{ id }` — evita 132012
 * "expected IMAGE, received UNKNOWN" do caminho `{ link }`.
 */
export async function resolveTemplateHeaderMediaParam(
  client: MetaWhatsAppClient,
  mediaUrl: string,
  mediaType: "image" | "video" | "document",
): Promise<{ id: string }> {
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

/** Media id da mídia original do template, por número + template + idioma. */
const TEMPLATE_EXAMPLE_MEDIA_TTL_MS = 6 * 60 * 60 * 1000;
const templateExampleMediaCache = new Map<
  string,
  { at: number; id: Promise<{ id: string; format: "IMAGE" | "VIDEO" | "DOCUMENT" }> }
>();

/** Só para testes. */
export function clearTemplateExampleMediaCache(): void {
  templateExampleMediaCache.clear();
}

/**
 * Sobe UMA vez a mídia de exemplo do template aprovado (a "mídia original"
 * cadastrada na Meta) e reaproveita o media id — uma campanha de milhares de
 * contatos não pode baixar/subir o mesmo arquivo por destinatário.
 */
export async function resolveTemplateOriginalHeaderMedia(
  client: MetaWhatsAppClient,
  args: { templateName: string; languageCode: string; templateGraphId: string | null },
): Promise<{ id: string; format: "IMAGE" | "VIDEO" | "DOCUMENT" }> {
  const key = `${client.phoneId}::${args.templateName}::${args.languageCode}`;
  const hit = templateExampleMediaCache.get(key);
  if (hit && Date.now() - hit.at < TEMPLATE_EXAMPLE_MEDIA_TTL_MS) return hit.id;

  const pending = (async () => {
    const { format, exampleUrl } = await resolveTemplateHeaderMediaExample(client, args);
    if (!format) {
      throw new TemplateHeaderMediaError(
        `template "${args.templateName}": não foi possível ler o cabeçalho de mídia do template aprovado na Meta.`,
      );
    }
    if (!exampleUrl) {
      throw new TemplateHeaderMediaError(
        `template "${args.templateName}": a Meta não devolveu a mídia original do cabeçalho. Use um campo do negócio com a URL da mídia.`,
      );
    }
    const mediaType = format.toLowerCase() as "image" | "video" | "document";
    const fetched = await fetchPublicMediaBytes(exampleUrl, mediaType);
    const id = await client.uploadMedia(fetched.buffer, fetched.mimeType, fetched.fileName);
    if (!id) {
      throw new TemplateHeaderMediaError(
        `template "${args.templateName}": upload da mídia original na Meta não devolveu media id.`,
      );
    }
    log.info(
      { template: args.templateName, format, id: id.slice(0, 12) },
      "[template-header-media] mídia original do template enviada",
    );
    return { id, format };
  })();
  templateExampleMediaCache.set(key, { at: Date.now(), id: pending });
  // Falha não fica no cache: o próximo destinatário tenta de novo.
  pending.catch(() => {
    if (templateExampleMediaCache.get(key)?.id === pending) templateExampleMediaCache.delete(key);
  });
  return pending;
}

function replaceHeaderComponent(
  components: unknown[] | undefined,
  mediaType: "image" | "video" | "document",
  id: string,
): unknown[] {
  const headerComponent: Record<string, unknown> = {
    type: "header",
    parameters: [{ type: mediaType, [mediaType]: { id } }],
  };
  const withoutExistingHeader = (components ?? []).filter((c) => {
    const o = asRecord(c);
    return String(o?.type ?? "").toLowerCase() !== "header";
  });
  return [headerComponent, ...withoutExistingHeader];
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
    /**
     * Sem URL: usa a mídia original cadastrada no template aprovado (exemplo
     * do HEADER na Meta), em vez de exigir URL/campo do CRM.
     */
    useTemplateOriginalMedia?: boolean;
  },
): Promise<unknown[] | undefined> {
  if (args.useTemplateOriginalMedia && !args.headerMediaUrl?.trim()) {
    const original = await resolveTemplateOriginalHeaderMedia(client, {
      templateName: args.templateName,
      languageCode: args.languageCode,
      templateGraphId: args.templateGraphId,
    });
    return replaceHeaderComponent(
      args.components,
      original.format.toLowerCase() as "image" | "video" | "document",
      original.id,
    );
  }

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
  if (!("id" in mediaParam) || !mediaParam.id) {
    throw new TemplateHeaderMediaError(
      `header de template: upload Meta não devolveu media id (mode=${"link" in mediaParam ? "link" : "unknown"}).`,
    );
  }
  const headerComponent: Record<string, unknown> = {
    type: "header",
    parameters: [{ type: mediaType, [mediaType]: { id: mediaParam.id } }],
  };

  const withoutExistingHeader = (args.components ?? []).filter((c) => {
    const o = asRecord(c);
    return String(o?.type ?? "").toLowerCase() !== "header";
  });

  const out = [headerComponent, ...withoutExistingHeader];
  log.info(
    {
      template: args.templateName,
      format: headerFormat,
      mode: "id",
      id: mediaParam.id.slice(0, 12),
    },
    "[template-header-media] header resolvido",
  );
  return out;
}
