/** Anexo enviado no grupo WhatsApp: tipo no WhatsApp e texto no histórico. */

/** Tipo da mensagem no WhatsApp: áudio de voz (gravado) sai como ptt. */
export function groupAttachmentMessageType(mime: string): "image" | "video" | "ptt" | "audio" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) {
    const voice = mime.startsWith("audio/webm") || mime.startsWith("audio/ogg") || mime === "audio/opus";
    return voice ? "ptt" : "audio";
  }
  return "document";
}

/** Texto da mensagem no histórico: legenda, ou o rótulo do inbox. */
export function groupAttachmentText(type: string, fileName: string, caption: string): string {
  const c = caption.trim();
  if (type === "document") return c ? `${c}\n📎 ${fileName}` : `📎 ${fileName}`;
  if (c) return c;
  return type === "ptt" || type === "audio" ? "[áudio]" : `📎 ${fileName}`;
}
