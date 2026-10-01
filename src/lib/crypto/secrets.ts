import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getLogger } from "@/lib/logger";

const log = getLogger("crypto.secrets");

/**
 * App-layer encryption para segredos sensiveis (tokens, chaves, etc.) que
 * vivem em colunas Json no Postgres (Channel.config, etc.).
 *
 * Algoritmo: AES-256-GCM (autenticado).
 * Formato do valor encriptado: `enc:v1:<base64url(IV || ciphertext || authTag)>`.
 *
 * Compatibilidade: durante a migracao, valores em plaintext convivem com os
 * encriptados. `decryptSecret` detecta o prefixo `enc:v1:` e devolve o
 * plaintext, ou retorna o input inalterado quando nao parece encriptado.
 *
 * Referencias:
 * - NIST SP 800-38D recomenda IV de 96 bits para GCM (12 bytes).
 * - Auth tag default do Node `aes-256-gcm` e 16 bytes.
 *
 * @see docs/secrets-encryption.md
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;
const PREFIX_V1 = "enc:v1:";

let cachedKey: Buffer | null = null;

/**
 * Carrega a chave de encriptacao. Aceita `KEYRING_SECRET` (canonico) ou
 * `ENCRYPTION_KEY` (alias documentado historicamente em `.env.example`)
 * — o .env.example antigo divergia do nome usado no codigo, o que abria
 * a possibilidade de rodar em producao sem chave e gravar plaintext.
 *
 * Espera 32 bytes em base64 padrao (44 chars).
 *
 * Politica fail-closed: fora de dev local, a chave e OBRIGATORIA. Se
 * ausente, o processo aborta em vez de silenciosamente cair em
 * plaintext. Em dev local (`NODE_ENV=development`, sem CI/STAGING), a
 * ausencia da chave apenas emite warning para nao travar setup inicial.
 */
function getKey(): Buffer | null {
  if (cachedKey) return cachedKey;

  const raw =
    process.env.KEYRING_SECRET?.trim() || process.env.ENCRYPTION_KEY?.trim();
  const source = process.env.KEYRING_SECRET?.trim()
    ? "KEYRING_SECRET"
    : "ENCRYPTION_KEY";

  const nodeEnv = process.env.NODE_ENV;
  const isRealEnv =
    nodeEnv === "production" ||
    nodeEnv === "staging" ||
    !!process.env.CI ||
    !!process.env.CI_STAGING;

  if (!raw) {
    if (isRealEnv || nodeEnv !== "development") {
      throw new Error(
        "KEYRING_SECRET (ou ENCRYPTION_KEY) nao configurado. Gere com `openssl rand -base64 32` e injete no secrets manager.",
      );
    }
    return null;
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${source} nao e base64 valido.`);
  }

  if (buf.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `${source} tem ${buf.length} bytes apos decodificar; esperado ${KEY_LENGTH_BYTES}. Use \`openssl rand -base64 ${KEY_LENGTH_BYTES}\`.`,
    );
  }

  cachedKey = buf;
  return buf;
}

/**
 * Detecta se a string ja esta no formato encriptado pelo modulo.
 * Util para skippar valores ja-encriptados em backfills idempotentes.
 */
export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX_V1);
}

/**
 * Encripta um valor string usando AES-256-GCM.
 *
 * Se `KEYRING_SECRET` nao estiver setado (dev sem chave), retorna o input
 * inalterado e loga warning. Em producao, throw.
 *
 * Idempotencia: se o input ja parece encriptado, retorna como esta.
 */
export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (isEncryptedSecret(plain)) return plain;

  const key = getKey();
  if (!key) {
    if (process.env.NODE_ENV !== "test") {
      log.warn("[crypto/secrets] encryptSecret chamado sem KEYRING_SECRET — gravando em plaintext (apenas dev).");
    }
    return plain;
  }

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, ciphertext, authTag]);
  return PREFIX_V1 + combined.toString("base64url");
}

/**
 * Decripta um valor encriptado pelo modulo. Se nao parecer encriptado
 * (sem prefixo `enc:v1:`), retorna o input inalterado — back-compat com
 * plaintext durante a migracao.
 *
 * Throws se o valor parece encriptado mas nao consegue decriptar
 * (auth tag invalido = chave errada ou ciphertext corrompido).
 */
export function decryptSecret(value: string): string {
  if (!value) return value;
  if (!isEncryptedSecret(value)) return value;

  const key = getKey();
  if (!key) {
    throw new Error(
      "Valor encriptado encontrado mas KEYRING_SECRET nao esta configurado.",
    );
  }

  const payload = value.slice(PREFIX_V1.length);
  let combined: Buffer;
  try {
    combined = Buffer.from(payload, "base64url");
  } catch {
    throw new Error("Valor encriptado com base64url invalido.");
  }

  if (combined.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES) {
    throw new Error("Valor encriptado muito curto.");
  }

  const iv = combined.subarray(0, IV_LENGTH_BYTES);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH_BYTES);
  const ciphertext = combined.subarray(
    IV_LENGTH_BYTES,
    combined.length - AUTH_TAG_LENGTH_BYTES,
  );

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(authTag);

  const plain = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

/**
 * Encripta uma lista de campos string em um objeto, nao mutando o input.
 * Campos ausentes ou nao-string sao ignorados silenciosamente.
 */
export function encryptObjectFields<T extends Record<string, unknown>>(
  obj: T,
  fields: ReadonlyArray<keyof T & string>,
): T {
  const out: Record<string, unknown> = { ...obj };
  for (const field of fields) {
    const v = out[field];
    if (typeof v === "string" && v.length > 0) {
      out[field] = encryptSecret(v);
    }
  }
  return out as T;
}

/**
 * Decripta uma lista de campos string em um objeto, nao mutando o input.
 * Campos ausentes, nao-string ou nao-encriptados sao retornados como esta.
 */
export function decryptObjectFields<T extends Record<string, unknown>>(
  obj: T,
  fields: ReadonlyArray<keyof T & string>,
): T {
  const out: Record<string, unknown> = { ...obj };
  for (const field of fields) {
    const v = out[field];
    if (typeof v === "string" && v.length > 0) {
      out[field] = decryptSecret(v);
    }
  }
  return out as T;
}

/** Apenas para testes: invalida o cache da chave (recarrega da env). */
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}
