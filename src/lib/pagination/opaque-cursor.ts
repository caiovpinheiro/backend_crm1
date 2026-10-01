/**
 * Cursor opaco de paginação keyset: JSON pequeno em base64url.
 *
 * O cliente só devolve a string que recebeu em `nextCursor` — nunca monta
 * nem interpreta. O conteúdo (chave de ordenação + id do último item) é
 * validado por quem decodifica; aqui só o envelope.
 */

const MAX_CURSOR_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeOpaqueCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** `null` quando não é base64url de um objeto JSON (nunca lança). */
export function decodeOpaqueCursor(raw: string): Record<string, unknown> | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !BASE64URL.test(raw)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
