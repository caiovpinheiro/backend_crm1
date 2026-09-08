/**
 * Criptografia simétrica para segredos persistidos em `system_settings`
 * (chaves de API de provedores externos: OpenAI, Groq, etc.).
 *
 * Formato do ciphertext armazenado:
 *   `enc:v1:<iv_b64>:<tag_b64>:<cipher_b64>`
 *
 * O prefixo `enc:v1:` permite distinguir de valores legados gravados em
 * texto puro (caso migremos de setting já existente) e evoluir o esquema
 * sem quebrar linhas antigas.
 *
 * Chave: derivada via SHA-256 de `ENCRYPTION_KEY` (se presente) ou
 * `NEXTAUTH_SECRET` (fallback — o secret da app já é obrigatório e
 * setado em prod). Derivar via hash garante 32 bytes independentemente
 * do comprimento do segredo original.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "enc:v1:";

function readSecret(): string {
  return (
    process.env.ENCRYPTION_KEY?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    ""
  );
}

/**
 * `false` quando o processo não tem segredo de criptografia. Serve pra
 * distinguir "ambiente mal configurado" de "blob gravado com outro
 * segredo" — os dois falham em `decryptSecret`, mas a correção é oposta.
 */
export function hasCryptoSecret(): boolean {
  return readSecret() !== "";
}

function getKey(): Buffer {
  const secret = readSecret();
  if (!secret) {
    throw new Error(
      "Nenhum segredo disponível para criptografar (defina ENCRYPTION_KEY ou NEXTAUTH_SECRET).",
    );
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  // Compatibilidade retroativa: se o valor não tem prefixo, assumimos
  // texto puro (ex.: setting pré-existente antes da criptografia).
  if (!stored.startsWith(PREFIX)) return stored;

  const body = stored.slice(PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    throw new Error("Formato de segredo criptografado inválido.");
  }
  const [ivB64, tagB64, cipherB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const enc = Buffer.from(cipherB64, "base64");

  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/** Mascara uma chave p/ exibir sem vazar o valor inteiro ("sk-...abcd"). */
export function maskSecret(value: string): string {
  if (!value) return "";
  const v = value.trim();
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}
