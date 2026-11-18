/**
 * Configuração do servidor MCP (Model Context Protocol).
 *
 * Processo isolado: `APP_MODE=mcp` (mesma imagem da API, sem migrate e sem
 * sweepers). Só esse processo responde `/mcp`, `/oauth/*` e
 * `/.well-known/oauth-*`. A API privada (`api`) e a pública (`api-public`)
 * recusam essas rotas em produção — salvo `MCP_ALLOW_ON_MAIN_API=1`.
 *
 * Variáveis (lidas em runtime, nunca congeladas no build):
 *   - `MCP_PUBLIC_URL`  — origem pública do MCP (ex.: https://mcp.bwipo.com).
 *     Vira o `issuer` OAuth e o recurso protegido (`<url>/mcp`).
 *   - `MCP_CONSENT_URL` — página de consentimento no frontend
 *     (default `<APP_URL>/oauth/consent`).
 *   - `MCP_ACCESS_TOKEN_TTL_SEC` (default 3600), `MCP_REFRESH_TOKEN_TTL_DAYS`
 *     (default 30), `MCP_RATE_LIMIT_RPM` (default 60 por conexão).
 */
import { runtimeEnv } from "@/lib/runtime-env";

export const MCP_APP_MODE = "mcp";

export function currentAppMode(): string {
  return (runtimeEnv("APP_MODE") ?? "api").toLowerCase();
}

/** Rotas do servidor MCP/OAuth só no processo `mcp` (ou em dev/flag). */
export function isMcpServerAllowedOnThisProcess(): boolean {
  if (currentAppMode() === MCP_APP_MODE) return true;
  if (runtimeEnv("MCP_ALLOW_ON_MAIN_API") === "1") return true;
  return (runtimeEnv("NODE_ENV") ?? "development").toLowerCase() !== "production";
}

function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Origem pública do MCP. Sem `MCP_PUBLIC_URL`, usa a origem do pedido
 * (dev local / testes). Em produção configure sempre a env: o `issuer` e o
 * `resource` precisam ser estáveis para os clientes.
 */
export function mcpPublicOrigin(request?: Request): string {
  const env = originOf(runtimeEnv("MCP_PUBLIC_URL"));
  if (env) return env;
  if (request) {
    try {
      const url = new URL(request.url);
      const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
      const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
      return `${proto}://${host}`;
    } catch {
      /* cai no default */
    }
  }
  return "http://localhost:3001";
}

/**
 * `MCP_PUBLIC_URL` definida? Em produção é obrigatória nos serviços `api`
 * (tela, consentimento) e `mcp`; sem ela a URL cairia em localhost.
 */
export function isMcpPublicUrlConfigured(): boolean {
  if (originOf(runtimeEnv("MCP_PUBLIC_URL"))) return true;
  return (runtimeEnv("NODE_ENV") ?? "development").toLowerCase() !== "production";
}

export function mcpResourceUrl(request?: Request): string {
  return `${mcpPublicOrigin(request)}/mcp`;
}

export function mcpConsentUrl(): string {
  const explicit = runtimeEnv("MCP_CONSENT_URL");
  if (explicit) return explicit;
  const app =
    originOf(runtimeEnv("NEXT_PUBLIC_APP_URL")) ??
    originOf(runtimeEnv("APP_URL")) ??
    "http://localhost:3000";
  return `${app}/oauth/consent`;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = runtimeEnv(name);
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function accessTokenTtlSec(): number {
  return intEnv("MCP_ACCESS_TOKEN_TTL_SEC", 3600, 300, 24 * 3600);
}

export function refreshTokenTtlMs(): number {
  return intEnv("MCP_REFRESH_TOKEN_TTL_DAYS", 30, 1, 180) * 24 * 3600 * 1000;
}

/** Authorization code: uso único, 5 minutos. */
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
