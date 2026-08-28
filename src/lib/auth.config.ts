import type { NextAuthConfig } from "next-auth";

import type { AppUserRole } from "./auth-types";
import { getAuthCookieDomain, getTenantBaseDomain, getTenantProtocol } from "./tenant-url";

function apexLoginUrl(): string {
  return `${getTenantProtocol()}://${getTenantBaseDomain()}/login`;
}

function isAllowedAuthHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.includes("easypanel.host")) return false;
  const base = getTenantBaseDomain();
  return host === base || host.endsWith(`.${base}`) || host === "localhost" || host.endsWith(".localhost");
}

/**
 * Config compartilhada (sem Prisma) para uso no middleware Edge.
 * Os providers com credenciais ficam em `auth.ts`.
 */
const nextAuthUrl = process.env.NEXTAUTH_URL ?? "";
const useSecureCookies = nextAuthUrl.startsWith("https://");
const authCookieDomain = getAuthCookieDomain();

export default {
  /** Garante o mesmo segredo no middleware (Edge) e nos handlers (Node). */
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  trustHost: true,
  /** Em HTTPS, cookies só por canal seguro (mitiga roubo de sessão em redes mistas). */
  useSecureCookies,
  /**
   * Em produção, Domain=`.{TENANT_BASE_DOMAIN}` para a sessão sobreviver ao
   * redirect apex → `{slug}.bwipo.com` após o signup.
   * Desligar: AUTH_COOKIE_DOMAIN=none (dev/local).
   */
  cookies: {
    sessionToken: {
      name: `${useSecureCookies ? "__Secure-" : ""}authjs.session-token`,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
        ...(authCookieDomain ? { domain: authCookieDomain } : {}),
      },
    },
  },
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: AppUserRole | null }).role ?? undefined;
        token.organizationId =
          (user as { organizationId?: string | null }).organizationId ?? null;
        token.organizationSlug =
          (user as { organizationSlug?: string | null }).organizationSlug ??
          null;
        token.isSuperAdmin = Boolean(
          (user as { isSuperAdmin?: boolean }).isSuperAdmin,
        );
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { role?: unknown }).role = token.role;
        (session.user as { organizationId?: string | null }).organizationId =
          (token.organizationId as string | null | undefined) ?? null;
        (session.user as { organizationSlug?: string | null }).organizationSlug =
          (token.organizationSlug as string | null | undefined) ?? null;
        (session.user as { isSuperAdmin?: boolean }).isSuperAdmin = Boolean(
          token.isSuperAdmin,
        );
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      const login = apexLoginUrl();
      try {
        const dest = new URL(url, baseUrl);
        if (dest.pathname === "/" && !dest.search) {
          dest.pathname = "/login";
        }
        if (isAllowedAuthHost(dest.hostname)) {
          return dest.toString();
        }
      } catch {
        /* fallthrough */
      }
      if (url.startsWith("/") && !url.startsWith("//")) {
        const path = url === "/" ? "/login" : url;
        return `${getTenantProtocol()}://${getTenantBaseDomain()}${path}`;
      }
      return login;
    },
  },
} satisfies NextAuthConfig;
