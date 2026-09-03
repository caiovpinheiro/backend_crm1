/**
 * Injeta o componente HEADER de mídia (IMAGE/VIDEO/DOCUMENT) no payload
 * de envio de template — mesmo contrato usado por automações e campanhas.
 *
 * Extraído de `automation-executor.ts` para o worker de campanhas poder
 * reutilizar sem puxar o executor inteiro.
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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Resolve `{ link }` (URL pública) ou `{ id }` (upload interno → Meta media). */
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
    return { link: toAbsolutePublicMediaUrl(trimmed) };
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
