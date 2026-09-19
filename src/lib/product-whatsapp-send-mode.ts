/**
 * Modo de envio de produtos pelo WhatsApp — setting da organização.
 * Ausente = `normal` (comportamento atual: texto/imagem via Inbox).
 */
export const PRODUCT_WHATSAPP_SEND_MODE_KEY = "products.whatsappSendMode";

export const PRODUCT_WHATSAPP_SEND_MODES = [
  "normal",
  "catalog_always",
  "catalog_multiple",
  "ask",
] as const;

export type ProductWhatsAppSendMode = (typeof PRODUCT_WHATSAPP_SEND_MODES)[number];

export const PRODUCT_SEND_FORMATS = [
  "legacy",
  "catalog_product",
  "catalog_product_list",
] as const;

export type ProductSendFormat = (typeof PRODUCT_SEND_FORMATS)[number];

export function isProductWhatsAppSendMode(v: unknown): v is ProductWhatsAppSendMode {
  return typeof v === "string" && (PRODUCT_WHATSAPP_SEND_MODES as readonly string[]).includes(v);
}

export function isProductSendFormat(v: unknown): v is ProductSendFormat {
  return typeof v === "string" && (PRODUCT_SEND_FORMATS as readonly string[]).includes(v);
}

export function parseProductWhatsAppSendMode(raw: string | null | undefined): ProductWhatsAppSendMode {
  return isProductWhatsAppSendMode(raw) ? raw : "normal";
}

/**
 * Decide o formato efetivo. `ask` sem `requestedFormat` não envia —
 * o frontend escolhe no momento do envio.
 */
export function resolveProductSendFormat(opts: {
  mode: ProductWhatsAppSendMode;
  productCount: number;
  requestedFormat?: ProductSendFormat | "auto" | null;
}): { format: ProductSendFormat | null; needsChoice: boolean } {
  const requested =
    opts.requestedFormat && opts.requestedFormat !== "auto" ? opts.requestedFormat : null;

  if (opts.mode === "ask") {
    if (requested) return { format: requested, needsChoice: false };
    return { format: null, needsChoice: true };
  }

  if (requested === "legacy") return { format: "legacy", needsChoice: false };
  if (opts.mode === "normal") return { format: "legacy", needsChoice: false };

  if (opts.mode === "catalog_always") {
    return {
      format: opts.productCount <= 1 ? "catalog_product" : "catalog_product_list",
      needsChoice: false,
    };
  }

  if (opts.mode === "catalog_multiple") {
    return {
      format: opts.productCount <= 1 ? "legacy" : "catalog_product_list",
      needsChoice: false,
    };
  }

  return { format: "legacy", needsChoice: false };
}
