/**
 * Teto duro de API por organização. Fonte única do número — não copiar
 * `400` em rotas. Override: `ORG_RATE_LIMIT_RPM`.
 * Lane Bearer/n8n: `TOKEN_ORG_RATE_LIMIT_RPM` (default 240) — não usa este.
 */
export const DEFAULT_ORG_RATE_LIMIT_RPM = 400;
export const DEFAULT_TOKEN_ORG_RATE_LIMIT_RPM = 240;
export const ORG_RATE_LIMIT_WINDOW_MS = 60_000;

export type OrgRpmLane = "session" | "token";

export function getOrgRateLimitRpm(): number {
  const raw = process.env.ORG_RATE_LIMIT_RPM?.trim();
  if (!raw) return DEFAULT_ORG_RATE_LIMIT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ORG_RATE_LIMIT_RPM;
  return Math.floor(n);
}

/** Teto Bearer por org (`org:{id}:rpm:token`). Override: `TOKEN_ORG_RATE_LIMIT_RPM`. */
export function getTokenOrgRateLimitRpm(): number {
  const raw = process.env.TOKEN_ORG_RATE_LIMIT_RPM?.trim();
  if (!raw) return DEFAULT_TOKEN_ORG_RATE_LIMIT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TOKEN_ORG_RATE_LIMIT_RPM;
  return Math.floor(n);
}

/** Chave isolada: `org:{id}:rpm:session` | `org:{id}:rpm:token`. */
export function orgRpmKey(
  organizationId: string,
  lane: OrgRpmLane = "token",
): string {
  return `org:${organizationId}:rpm:${lane}`;
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

/**
 * GET quentes do inbox (sessão). Não competem com o RPM de Bearer:
 * lista / tab-counts (`?counts=1`) e histórico de mensagens.
 */
export function isInboxHotSessionPath(pathname: string): boolean {
  if (pathname === "/api/conversations") return true;
  return /^\/api\/conversations\/[^/]+\/messages$/.test(pathname);
}
