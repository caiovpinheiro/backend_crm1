/**
 * Teto duro de API por organização. Fonte única do número — não copiar
 * `400` em rotas. Override: `ORG_RATE_LIMIT_RPM`.
 */
export const DEFAULT_ORG_RATE_LIMIT_RPM = 400;
export const ORG_RATE_LIMIT_WINDOW_MS = 60_000;

export function getOrgRateLimitRpm(): number {
  const raw = process.env.ORG_RATE_LIMIT_RPM?.trim();
  if (!raw) return DEFAULT_ORG_RATE_LIMIT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ORG_RATE_LIMIT_RPM;
  return Math.floor(n);
}

/** Chave canônica do bucket: `org:{organizationId}:rpm`. */
export function orgRpmKey(organizationId: string): string {
  return `org:${organizationId}:rpm`;
}

/**
 * Paths que nunca entram no bucket da org — callbacks de plataforma,
 * health, cron e auth (login ainda não tem org).
 */
export function isOrgRpmExemptPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/cron") ||
    pathname.startsWith("/api/auth")
  );
}
