/**
 * Material de base importado de modelo de mensagem chega como o payload do
 * WhatsApp: `{"type":"text","body":"📄 Como emitir…\n1️⃣ …"}`, com `\n`
 * literal. Indexado assim, o embedding é de um JSON (a busca por
 * similaridade perde qualidade) e o trecho devolvido ao agente — que pode
 * ir literalmente para o cliente — é o JSON cru.
 *
 * Devolve só o texto do `body`, com quebras de linha reais. Texto comum
 * passa intacto.
 */
export function unwrapMessagePayloadText(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith("{")) return raw;
  try {
    const parsed = JSON.parse(text) as { body?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.body === "string") {
      return parsed.body.trim();
    }
    return raw;
  } catch {
    // Trecho cortado no meio de um material maior: o JSON não fecha, mas
    // o envelope e os escapes são os mesmos.
    const envelope = /^\{\s*"type"\s*:\s*"[^"]*"\s*,\s*"body"\s*:\s*"/;
    if (!envelope.test(text)) return raw;
    return text
      .replace(envelope, "")
      .replace(/"\s*\}\s*$/, "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim();
  }
}
