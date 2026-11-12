/**
 * Tipos de anexo aceitos no envio (inbox e grupos WhatsApp).
 * SEC2-3: comparado com o MIME DETECTADO por magic bytes, nunca com o
 * Content-Type do cliente. `application/octet-stream` fica de fora.
 */
export const ATTACHMENT_ALLOWED_PREFIXES = [
  "image/", "video/", "audio/",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument",
  "application/zip",
  "text/plain", "text/csv",
] as const;

/** Limite de arquivo do WhatsApp para anexos enviados pelo CRM. */
export const ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;

export function isAllowedAttachmentMime(mime: string): boolean {
  return ATTACHMENT_ALLOWED_PREFIXES.some((p) => mime.startsWith(p));
}
