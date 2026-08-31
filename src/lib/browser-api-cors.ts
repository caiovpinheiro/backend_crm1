import { getTenantBaseDomain } from "@/lib/tenant-url";

/**
 * CORS para o browser bater direto em api.{TENANT_BASE_DOMAIN} com o
 * cookie Domain=`.{base}` (SameSite=Lax, same-site — não cross-site).
 *
 * Só reflete origens do próprio tenant (https://bwipo.com,
 * https://{slug}.bwipo.com). Extra explícito: BROWSER_API_CORS_ORIGINS
 * (lista CSV). Nunca `*`.
 */

const DEFAULT_ALLOW_HEADERS =
  "Accept, Authorization, Content-Type, Range, X-Requested-With, X-Tenant-Slug, X-Cockpit-Access";

function extraAllowedOrigins(): Set<string> {
  const raw = [
    process.env.BROWSER_API_CORS_ORIGINS ?? "",
    process.env.ALLOWED_ORIGINS ?? "",
  ].join(",");
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().replace(/\/$/, "").toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedBrowserApiOrigin(origin: string | null): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const normalized = origin.replace(/\/$/, "").toLowerCase();
  if (extraAllowedOrigins().has(normalized) || extraAllowedOrigins().has(host)) {
    return url.protocol === "https:" || url.protocol === "http:";
  }

  const base = getTenantBaseDomain();
  const onTenant = host === base || host.endsWith(`.${base}`);
  if (!onTenant) return false;

  if (base === "localhost" || host === "localhost" || host.endsWith(".localhost")) {
    return url.protocol === "http:" || url.protocol === "https:";
  }
  return url.protocol === "https:";
}

export function applyBrowserApiCors(
  request: { headers: Headers },
  res: { headers: Headers },
): void {
  const origin = request.headers.get("origin");
  if (!isAllowedBrowserApiOrigin(origin) || !origin) return;

  res.headers.set("Access-Control-Allow-Origin", origin);
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
    "Content-Disposition, X-Export-Total",
  );
  res.headers.set("Access-Control-Max-Age", "86400");
  const vary = res.headers.get("Vary");
  if (!vary) {
    res.headers.set("Vary", "Origin");
  } else if (!/\borigin\b/i.test(vary)) {
    res.headers.set("Vary", `${vary}, Origin`);
  }
}
