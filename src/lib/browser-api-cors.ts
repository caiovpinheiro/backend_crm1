import { getTenantBaseDomain } from "@/lib/tenant-url";

/**
 * CORS para o browser bater direto em api.{TENANT_BASE_DOMAIN} com o
 * cookie Domain=`.{base}` (SameSite=Lax, same-site — não cross-site).
 *
 * Política: **negar por padrão**. Só é refletida uma origem EXATA e já
 * normalizada (o browser sempre manda esquema e host em minúsculas e omite
 * a porta padrão — `https://BWIPO.COM` e `https://bwipo.com:443` não são
 * origens de browser e são recusadas):
 *
 *  1. extras de `BROWSER_API_CORS_ORIGINS` / `ALLOWED_ORIGINS` (lista CSV);
 *  2. o apex (`https://{base}` e `https://www.{base}`);
 *  3. `https://{slug}.{base}` de uma organização que EXISTE, está ACTIVE e
 *     tem ao menos um usuário com e-mail verificado — quem cria uma org em
 *     `/api/signup` e não confirma o e-mail não vira origem confiável.
 *     A consulta é injetada (`TenantOriginLookup`): no middleware (Edge)
 *     vem de `cors-tenant-lookup-edge`, nas rotas Node de
 *     `cors-tenant-origin`. Falha na consulta = origem negada.
 *
 * Por caminho (`corsPathPolicy`):
 *  - `none`: rotas sem consumidor browser cross-origin (health, cron,
 *    webhooks, métricas, internas) — nenhum header CORS, logo nenhum
 *    `Allow-Credentials`.
 *  - `first-party`: `/api/auth/*` (csrf, session, callback do next-auth e
 *    as rotas de e-mail/senha). O frontend SEMPRE chama `/api/auth/*` no
 *    próprio origin (rewrite; ver `SAME_ORIGIN_API_PREFIXES` em
 *    `frontend/src/lib/api.ts`, igual na main e na DEV) — subdomínio de
 *    organização não precisa e não recebe CORS aqui. Ficam só apex e extras.
 *  - `tenant`: o resto de `/api/*` (regras 1–3).
 *
 * `Vary: Origin` vai em toda resposta de `/api/*`, com ou sem CORS. Nunca `*`.
 */

const DEFAULT_ALLOW_HEADERS =
  "Accept, Authorization, Content-Type, Range, X-Requested-With, X-Tenant-Slug, X-Cockpit-Access";

/** Mesmo formato de slug do signup (`services/onboarding.ts`). */
const TENANT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Responde "esta org existe, está ativa e tem admin verificado?". */
export type TenantOriginLookup = (slug: string) => Promise<boolean>;

export type CorsPathPolicy = "none" | "first-party" | "tenant";

export type BrowserApiOrigin =
  | { kind: "extra"; origin: string }
  | { kind: "apex"; origin: string }
  | { kind: "tenant"; origin: string; slug: string };

const NO_CORS_PREFIXES = [
  "/api/health",
  "/api/cron",
  "/api/webhooks",
  "/api/metrics",
  "/api/internal",
  "/api/csp-report",
] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function corsPathPolicy(pathname: string): CorsPathPolicy {
  if (NO_CORS_PREFIXES.some((p) => matchesPrefix(pathname, p))) return "none";
  if (matchesPrefix(pathname, "/api/auth")) return "first-party";
  return "tenant";
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Aceita só a serialização canônica de uma origem (`esquema://host[:porta]`,
 * minúsculas, sem porta padrão, sem path/credenciais). Qualquer outra forma
 * devolve null.
 */
function parseCanonicalOrigin(origin: string): URL | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (`${url.protocol}//${url.host}` !== origin) return null;
  return url;
}

type ExtraOrigins = { origins: Set<string>; hosts: Set<string> };

let extrasMemo: { raw: string; value: ExtraOrigins } | null = null;

function extraAllowedOrigins(): ExtraOrigins {
  const raw = [
    process.env.BROWSER_API_CORS_ORIGINS ?? "",
    process.env.ALLOWED_ORIGINS ?? "",
  ].join(",");
  if (extrasMemo && extrasMemo.raw === raw) return extrasMemo.value;

  const origins = new Set<string>();
  const hosts = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim().replace(/\/+$/, "").toLowerCase();
    if (!entry || entry === "*") continue;
    if (entry.includes("://")) {
      try {
        const url = new URL(entry);
        origins.add(`${url.protocol}//${url.host}`);
      } catch {
        /* entrada inválida — ignorada */
      }
    } else {
      hosts.add(entry);
    }
  }
  const value = { origins, hosts };
  extrasMemo = { raw, value };
  return value;
}

/** `BROWSER_API_CORS_TRUST_ALL_TENANT_SUBDOMAINS=1`: volta de emergência. */
function trustAllTenantSubdomains(): boolean {
  const flag = (process.env.BROWSER_API_CORS_TRUST_ALL_TENANT_SUBDOMAINS ?? "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

/**
 * Classifica a origem sem consultar nada. `null` = nunca permitida.
 * `tenant` ainda depende da consulta de existência da organização.
 */
export function classifyBrowserApiOrigin(
  origin: string | null | undefined,
): BrowserApiOrigin | null {
  if (!origin) return null;
  const url = parseCanonicalOrigin(origin);
  if (!url) return null;
  const hostname = url.hostname;

  const extras = extraAllowedOrigins();
  if (extras.origins.has(origin)) return { kind: "extra", origin };
  // Entrada só com host (legado): https na porta padrão; http só em local.
  if (extras.hosts.has(hostname)) {
    if (url.protocol === "https:" && url.port === "") return { kind: "extra", origin };
    if (isLocalHostname(hostname)) return { kind: "extra", origin };
  }

  const base = getTenantBaseDomain();

  // Dev local (`TENANT_BASE_DOMAIN=localhost`): http e qualquer porta, sem
  // consulta — não existe deploy de produção com base `localhost`.
  if (base === "localhost") {
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return { kind: "apex", origin };
    }
    return null;
  }

  if (url.protocol !== "https:" || url.port !== "") return null;
  if (hostname === base || hostname === `www.${base}`) {
    return { kind: "apex", origin };
  }
  if (!hostname.endsWith(`.${base}`)) return null;

  const slug = hostname.slice(0, -(base.length + 1));
  if (!TENANT_SLUG_RE.test(slug)) return null;
  return { kind: "tenant", origin, slug };
}

/**
 * Origem a refletir em `Access-Control-Allow-Origin`, ou `null` (sem CORS).
 */
export async function resolveBrowserApiCorsOrigin(
  origin: string | null | undefined,
  pathname: string,
  lookup: TenantOriginLookup,
): Promise<string | null> {
  if (!origin) return null;
  const policy = corsPathPolicy(pathname);
  if (policy === "none") return null;

  const classified = classifyBrowserApiOrigin(origin);
  if (!classified) return null;
  if (classified.kind !== "tenant") return classified.origin;

  if (policy === "first-party") return null;
  if (trustAllTenantSubdomains()) return classified.origin;
  try {
    return (await lookup(classified.slug)) ? classified.origin : null;
  } catch {
    return null;
  }
}

function appendVaryOrigin(headers: Headers): void {
  const vary = headers.get("Vary");
  if (!vary) {
    headers.set("Vary", "Origin");
  } else if (!/\borigin\b/i.test(vary)) {
    headers.set("Vary", `${vary}, Origin`);
  }
}

/**
 * Escreve os headers de CORS para a origem já decidida por
 * `resolveBrowserApiCorsOrigin`. `allowedOrigin` null = só `Vary: Origin`.
 */
export function writeBrowserApiCorsHeaders(
  request: { headers: Headers },
  res: { headers: Headers },
  allowedOrigin: string | null,
): void {
  appendVaryOrigin(res.headers);
  if (!allowedOrigin) return;

  res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
  );
  const requested = request.headers.get("access-control-request-headers");
  res.headers.set(
    "Access-Control-Allow-Headers",
    requested && requested.trim() ? requested : DEFAULT_ALLOW_HEADERS,
  );
  res.headers.set(
    "Access-Control-Expose-Headers",
    "Content-Disposition, Content-Length, Content-Range, Accept-Ranges, X-Export-Total",
  );
  res.headers.set("Access-Control-Max-Age", "86400");
}
