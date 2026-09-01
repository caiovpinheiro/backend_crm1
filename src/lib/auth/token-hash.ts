import crypto from "node:crypto";

/** SHA-256 hex. Nunca logar o `raw`. */
export function hashSecret(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

export function generateUrlToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashSecret(raw) };
}

/** Código numérico de `digits` dígitos (zero-padded). */
export function generateNumericCode(digits = 6): { raw: string; hash: string } {
  const max = 10 ** digits;
  const n = crypto.randomInt(0, max);
  const raw = String(n).padStart(digits, "0");
  return { raw, hash: hashSecret(raw) };
}
