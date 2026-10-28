/**
 * Webchat v2 — segredos do canal (docs/decisoes/webchat-widget.md §9.5).
 *
 * Dois segredos independentes por canal WEBCHAT:
 *  - `identity`: assina o `userHash` do `identify` (HMAC do externalId);
 *  - `s2s`: assina a entrada servidor a servidor e o callback.
 *
 * Gravados em `Channel.config` (`identitySecret`/`s2sSecret`) encriptados
 * como as outras credenciais (`lib/channels/config.ts`, AES-256-GCM), com a
 * data da última geração ao lado. Nunca saem pela API do painel: as rotas
 * devolvem só `{ configured, rotatedAt }` (`webchatSecretsStatus`) — o valor
 * em claro aparece uma única vez, na resposta da geração/rotação.
 */
import { randomBytes } from "node:crypto";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";

export const WEBCHAT_SECRET_KINDS = ["identity", "s2s"] as const;
export type WebchatSecretKind = (typeof WEBCHAT_SECRET_KINDS)[number];

/** Campo do config que guarda o valor encriptado. */
export const WEBCHAT_SECRET_FIELD: Record<WebchatSecretKind, string> = {
  identity: "identitySecret",
  s2s: "s2sSecret",
};
/** Campo do config com a data (ISO) da última geração. */
export const WEBCHAT_SECRET_ROTATED_FIELD: Record<WebchatSecretKind, string> = {
  identity: "identitySecretRotatedAt",
  s2s: "s2sSecretRotatedAt",
};
/** Prefixo visível (ajuda a não trocar um pelo outro na integração). */
const PREFIX: Record<WebchatSecretKind, string> = { identity: "wcid_", s2s: "wcsk_" };

/** Todos os campos de segredo do config (para preservar/remover em bloco). */
export const WEBCHAT_SECRET_CONFIG_FIELDS: readonly string[] = WEBCHAT_SECRET_KINDS.flatMap((k) => [
  WEBCHAT_SECRET_FIELD[k],
  WEBCHAT_SECRET_ROTATED_FIELD[k],
]);

export type WebchatSecretStatus = { configured: boolean; rotatedAt: string | null };
export type WebchatSecretsStatus = Record<WebchatSecretKind, WebchatSecretStatus>;

export function isWebchatSecretKind(v: unknown): v is WebchatSecretKind {
  return typeof v === "string" && (WEBCHAT_SECRET_KINDS as readonly string[]).includes(v);
}

/** Segredo novo: prefixo + 32 bytes aleatórios em base64url (43 chars). */
export function generateWebchatSecret(kind: WebchatSecretKind): string {
  return `${PREFIX[kind]}${randomBytes(32).toString("base64url")}`;
}

function rec(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

/** O que o painel pode ver: configurado sim/não e quando foi gerado. */
export function webchatSecretsStatus(config: unknown): WebchatSecretsStatus {
  const c = rec(config);
  const one = (kind: WebchatSecretKind): WebchatSecretStatus => {
    const value = c[WEBCHAT_SECRET_FIELD[kind]];
    const at = c[WEBCHAT_SECRET_ROTATED_FIELD[kind]];
    const configured = typeof value === "string" && value.length > 0;
    return { configured, rotatedAt: configured && typeof at === "string" ? at : null };
  };
  return { identity: one("identity"), s2s: one("s2s") };
}

/** Config sem nenhum campo de segredo (para devolver ao painel). */
export function stripWebchatSecrets(config: unknown): Record<string, unknown> {
  const out = { ...rec(config) };
  for (const f of WEBCHAT_SECRET_CONFIG_FIELDS) delete out[f];
  return out;
}

/** Só os campos de segredo do config gravado (para preservar num PUT). */
export function pickWebchatSecretFields(config: unknown): Record<string, unknown> {
  const c = rec(config);
  const out: Record<string, unknown> = {};
  for (const f of WEBCHAT_SECRET_CONFIG_FIELDS) {
    if (c[f] !== undefined) out[f] = c[f];
  }
  return out;
}

/**
 * Config com o segredo `kind` trocado (encriptado) e a data carimbada.
 * Não muta `config`. O chamador grava e devolve `plain` uma única vez.
 */
export function withRotatedWebchatSecret(
  config: unknown,
  kind: WebchatSecretKind,
  now: Date = new Date(),
): { config: Record<string, unknown>; plain: string; rotatedAt: string } {
  const plain = generateWebchatSecret(kind);
  const rotatedAt = now.toISOString();
  return {
    config: {
      ...rec(config),
      [WEBCHAT_SECRET_FIELD[kind]]: encryptSecret(plain),
      [WEBCHAT_SECRET_ROTATED_FIELD[kind]]: rotatedAt,
    },
    plain,
    rotatedAt,
  };
}

/**
 * Valor em claro do segredo, a partir do `Channel.config` cru (como está no
 * banco). `null` = não configurado. Para as rotas públicas (identify, S2S):
 * leia o config do banco na hora — não guarde o valor em cache.
 */
export function readWebchatSecret(config: unknown, kind: WebchatSecretKind): string | null {
  const value = rec(config)[WEBCHAT_SECRET_FIELD[kind]];
  if (typeof value !== "string" || !value) return null;
  const plain = decryptSecret(value);
  return plain || null;
}
