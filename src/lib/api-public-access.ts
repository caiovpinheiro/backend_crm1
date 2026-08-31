/**
 * Bearer de org (`eduit_…`) só no processo `APP_MODE=api-public`.
 * A API privada (inbox/sessão) recusa token válido e aponta para
 * `API_PUBLIC_BASE_URL`. Dev local e `ALLOW_BEARER_ON_PRIVATE_API=1`
 * continuam aceitando para não quebrar `next dev` / rollback.
 */

const DEFAULT_PUBLIC_API_BASE = "https://integrations.bwipo.com";

export function resolveAppMode(env: NodeJS.ProcessEnv = process.env): string {
  return (env.APP_MODE ?? "api").trim().toLowerCase() || "api";
}

export function publicApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.API_PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_API_BASE).trim();
  return (raw || DEFAULT_PUBLIC_API_BASE).replace(/\/$/, "");
}

export function isBearerAllowedOnThisProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (resolveAppMode(env) === "api-public") return true;
  if (env.ALLOW_BEARER_ON_PRIVATE_API === "1") return true;
  const nodeEnv = (env.NODE_ENV ?? "development").trim().toLowerCase();
  return nodeEnv !== "production";
}

export function bearerRequiresPublicApiMessage(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `Tokens de API só são aceitos em ${publicApiBaseUrl(env)}. Atualize a Base URL da integração.`;
}
