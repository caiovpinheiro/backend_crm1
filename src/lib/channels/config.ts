import type { ChannelProvider } from "@prisma/client";

import {
  decryptObjectFields,
  encryptObjectFields,
} from "@/lib/crypto/secrets";

/**
 * Helpers para encriptar/decriptar campos sensiveis de `Channel.config`.
 *
 * O config e um Json livre — cada provider tem seus campos. Aqui mantemos
 * a lista canonica de campos que devem ser encriptados em repouso (banco)
 * e expomos helpers que aplicam encrypt/decrypt sem alterar a estrutura
 * do objeto.
 *
 * @see docs/secrets-encryption.md
 */

/** Campos sensiveis por provider. Adicionar aqui qualquer credencial nova. */
const SENSITIVE_FIELDS: Record<ChannelProvider, ReadonlyArray<string>> = {
  META_CLOUD_API: ["accessToken", "appSecret", "verifyToken"],
  BAILEYS_MD: [],
  META_INSTAGRAM_LOGIN: ["accessToken", "appSecret", "verifyToken"],
  // Webchat v2: segredos de identidade e do servidor a servidor
  // (docs/decisoes/webchat-widget.md §9.5; gerados em lib/webchat/secrets.ts).
  WEBCHAT: ["identitySecret", "s2sSecret"],
};

/** Recupera os campos sensiveis configurados para um provider. */
export function sensitiveFieldsFor(
  provider: ChannelProvider,
): ReadonlyArray<string> {
  return SENSITIVE_FIELDS[provider] ?? [];
}

/**
 * Encripta os campos sensiveis do `config` para o provider dado e retorna
 * o objeto novo (nao muta input). Use ANTES de gravar com Prisma.
 *
 * Compatibilidade: valores ja-encriptados sao mantidos como esta.
 */
export function encryptChannelConfig(
  provider: ChannelProvider,
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!config) return {};
  const fields = SENSITIVE_FIELDS[provider] ?? [];
  if (fields.length === 0) return { ...config };
  return encryptObjectFields(config, fields);
}

/**
 * Decripta os campos sensiveis do `config` para o provider dado e retorna
 * o objeto novo (nao muta input). Use DEPOIS de ler do Prisma e ANTES de
 * usar tokens/secrets.
 *
 * Back-compat: se algum campo estiver em plaintext (registro antigo,
 * pre-backfill), e retornado como esta.
 */
export function decryptChannelConfig(
  provider: ChannelProvider,
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!config) return {};
  const fields = SENSITIVE_FIELDS[provider] ?? [];
  if (fields.length === 0) return { ...config };
  return decryptObjectFields(config, fields);
}

/**
 * Helper conveniente: aceita o objeto Channel completo (ou parcial) do
 * Prisma e devolve um config decriptado. Util na maioria dos call sites.
 */
export function getDecryptedChannelConfig(channel: {
  provider: ChannelProvider;
  config: unknown;
}): Record<string, unknown> {
  const cfg = (channel.config ?? {}) as Record<string, unknown>;
  return decryptChannelConfig(channel.provider, cfg);
}

/**
 * Este canal deve enviar confirmação de leitura (read receipt / "visto azul")
 * ao WhatsApp/Meta? Controlado pela flag `config.sendReadReceipts`.
 *
 * Default = TRUE (retrocompat: canais antigos sem a chave continuam enviando).
 * Só desativa quando explicitamente `=== false`.
 */
export function channelSendsReadReceipts(
  config: Record<string, unknown> | null | undefined,
): boolean {
  return config?.sendReadReceipts !== false;
}
