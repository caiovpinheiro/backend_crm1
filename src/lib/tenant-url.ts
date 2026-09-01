/**
 * URLs de tenant no estilo Kommo: https://{slug}.{TENANT_BASE_DOMAIN}
 *
 * Env:
 *   TENANT_BASE_DOMAIN  — default `bwipo.com`
 *   TENANT_PROTOCOL     — default `https` (use `http` em dev local)
 */

const DEFAULT_BASE_DOMAIN = "bwipo.com";
const DEFAULT_PROTOCOL = "https";

export function getTenantBaseDomain(): string {
  const raw = process.env.TENANT_BASE_DOMAIN?.trim().toLowerCase();
  return raw && raw.length > 0 ? raw.replace(/^\.+/, "") : DEFAULT_BASE_DOMAIN;
}

export function getTenantProtocol(): string {
  const raw = process.env.TENANT_PROTOCOL?.trim().toLowerCase();
  if (!raw) return DEFAULT_PROTOCOL;
  return raw.replace(/:?\/?\/?$/, "").replace(/:$/, "") || DEFAULT_PROTOCOL;
}

/** Cookie Domain com ponto inicial (ex.: `.crm.eduit.com.br`) para SSO entre subdomínios. */
export function getAuthCookieDomain(): string | undefined {
  const explicit = process.env.AUTH_COOKIE_DOMAIN?.trim();
  if (explicit === "" || explicit === "none" || explicit === "off") {
    return undefined;
  }
  if (explicit) {
    return explicit.startsWith(".") ? explicit : `.${explicit}`;
  }
  // Só compartilha Domain quando NEXTAUTH_URL já está no domínio de tenant.
  // Em EasyPanel / preview (ex.: *.easypanel.host), Domain=.crm… faz o
  // browser rejeitar o Set-Cookie → login “ok” e middleware manda de volta
  // pro /login. Nesses hosts o cookie fica host-only.
  const nextAuthUrl = process.env.NEXTAUTH_URL ?? "";
  if (!nextAuthUrl.startsWith("https://")) return undefined;
  try {
    const host = new URL(nextAuthUrl).hostname.toLowerCase();
    const base = getTenantBaseDomain();
    if (host === base || host.endsWith(`.${base}`)) {
      return `.${base}`;
    }
  } catch {
    /* NEXTAUTH_URL inválida — host-only */
  }
  return undefined;
}

export function buildTenantUrl(slug: string): string {
  const clean = String(slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    ?.split(".")[0];
  if (!clean) {
    throw new Error("Slug vazio para buildTenantUrl.");
  }
  return `${getTenantProtocol()}://${clean}.${getTenantBaseDomain()}`;
}

/** Alias de `buildTenantUrl`. */
export function tenantUrl(slug: string): string {
  return buildTenantUrl(slug);
}

/**
 * Primeiro label de `{slug}.{TENANT_BASE_DOMAIN}`. Apex, www e hosts
 * sem subdomínio de org devolvem null.
 */
export function slugFromRequestHost(hostHeader: string | null | undefined): string | null {
  const hostname = String(hostHeader ?? "")
    .trim()
    .toLowerCase()
    .split(":")[0]
    ?.replace(/\.$/, "");
  if (!hostname) return null;
  const base = getTenantBaseDomain();
  if (hostname === base || hostname === `www.${base}`) return null;
  if (!hostname.endsWith(`.${base}`)) return null;
  const slug = hostname.slice(0, -(base.length + 1));
  if (!slug || slug.includes(".")) return null;
  if (slug === "www" || slug === "api" || slug === "app") return null;
  return slug;
}
