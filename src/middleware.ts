import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

import {
  CRM_API_PATH_HEADER,
  CRM_HTTP_METHOD_HEADER,
  CRM_REQUEST_ID_HEADER,
} from "@/lib/api-access-audit-constants";
import {
  applyBrowserApiCors,
  isAllowedBrowserApiOrigin,
} from "@/lib/browser-api-cors";

/**
 * Mesma regra que `useSecureCookies` em `auth.config.ts` — define o nome do
 * cookie de sessão (`__Secure-` + `Secure` em HTTPS).
 */
function secureCookieFromEnv(): boolean {
  return (process.env.NEXTAUTH_URL ?? "").startsWith("https://");
}

const AUTH_SECRET = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;

/**
 * Lê o JWT do cookie do pedido atual (sem `createActionURL` / NEXTAUTH_URL).
 * O wrapper `NextAuth(authConfig)` no Edge usava `NEXTAUTH_URL` fixo; se a
 * porta ou o host da barra de endereço diferirem (ex. :3001, 127.0.0.1), a
 * sessão vinha vazia e o utilizador era mandado para /login após entrar.
 */
async function readAuthFromRequestCookie(
  req: NextRequest,
): Promise<{ user?: { id: string; isSuperAdmin?: boolean } } | null> {
  if (!AUTH_SECRET) return null;
  // O cookie é emitido pelo frontend (HTTPS → `__Secure-authjs.session-token`).
  // Este serviço só API recebe o header Cookie via rewrite. Se NEXTAUTH_URL
  // da API estiver sem `https://`, `secureCookie: false` procura o nome
  // errado e a sessão some → redirect /login HTML → toast genérico no FE.
  // Tentamos o valor do env e o fallback HTTPS/HTTP.
  const secureAttempts = [secureCookieFromEnv(), true, false];
  const tried = new Set<boolean>();
  try {
    for (const secureCookie of secureAttempts) {
      if (tried.has(secureCookie)) continue;
      tried.add(secureCookie);
      const token = await getToken({
        req,
        secret: AUTH_SECRET,
        secureCookie,
      });
      if (!token || typeof token !== "object") continue;
      const rec = token as Record<string, unknown>;
      const id =
        typeof rec.id === "string"
          ? rec.id
          : typeof rec.sub === "string"
            ? rec.sub
            : null;
      if (!id) continue;
      return {
        user: {
          id,
          isSuperAdmin: Boolean(rec.isSuperAdmin),
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Headers de seguranca aplicados em TODA resposta que sai do middleware.
 *
 * - Strict-Transport-Security: forca HTTPS pros proximos 12 meses e sub-dominios.
 *   `preload` pra permitir submissao na HSTS preload list da Google (quando
 *   quisermos entrar nela). Sem efeito em ambientes HTTP puros (o Chrome
 *   ignora HSTS via HTTP).
 * - X-Content-Type-Options: nosniff — bloqueia MIME sniffing.
 * - Referrer-Policy: strict-origin-when-cross-origin — envia referer completo
 *   em requests same-origin, apenas a origem em cross-origin HTTPS, e nada
 *   em downgrade pra HTTP.
 * - X-Frame-Options: SAMEORIGIN — anti-clickjacking; so o proprio dominio
 *   pode embedar o CRM em iframe.
 * - X-DNS-Prefetch-Control: on — libera DNS prefetch pra assets externos
 *   (CDNs de fotos, Baileys, etc.) sem afetar privacidade critica.
 *
 * NAO setamos Content-Security-Policy aqui pra nao quebrar o service worker
 * / inline scripts do Next. CSP fica de TODO separado com testes.
 */
function withSecurityHeaders(
  res: NextResponse,
  req?: { headers: Headers; nextUrl: { pathname: string } },
): NextResponse {
  // HSTS só em HTTPS — em HTTP local causaria Mixed Content e bloquearia SSE
  if ((process.env.NEXTAUTH_URL ?? "").startsWith("https://")) {
    res.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Frame-Options", "SAMEORIGIN");
  res.headers.set("X-DNS-Prefetch-Control", "on");
  if (req?.nextUrl.pathname.startsWith("/api/")) {
    applyBrowserApiCors(req, res);
  }
  return res;
}

/** Request mínimo do middleware. */
type MiddlewareReq = {
  nextUrl: { pathname: string };
  headers: Headers;
  method: string;
};

/** Repassa path/método/request-id para handlers Node auditarem acesso. */
function forwardApiAuditHeaders(req: MiddlewareReq, apiPath: string): Headers {
  const h = new Headers(req.headers);
  h.set(CRM_API_PATH_HEADER, apiPath);
  h.set(CRM_HTTP_METHOD_HEADER, req.method);
  if (!h.has(CRM_REQUEST_ID_HEADER)) {
    h.set(CRM_REQUEST_ID_HEADER, crypto.randomUUID());
  }
  return h;
}

function nextWithSecurityAndAudit(req: MiddlewareReq): NextResponse {
  const pathname = req.nextUrl.pathname;
  if (pathname.startsWith("/api/")) {
    return withSecurityHeaders(
      NextResponse.next({
        request: { headers: forwardApiAuditHeaders(req, pathname) },
      }),
      req,
    );
  }
  return withSecurityHeaders(NextResponse.next(), req);
}

const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/register",
  "/health",
  "/accept-invite",
  // Cockpit do Agente: shell estático sem dados sensíveis. Os dados vêm de
  // /api/public/agent-cockpit autenticado por Bearer token (não por cookie).
  "/cockpit-agente.html",
]);

const PUBLIC_API_PATHS = new Set([
  "/api/signup",
  "/api/organization/by-slug",
]);

const PWA_PUBLIC_PATHS = new Set([
  "/manifest.webmanifest",
  "/sw.js",
  "/sw.js.map",
  "/icon",
  "/icon0",
  "/icon1",
  "/icon2",
  "/icon.svg",
  "/icon-maskable.svg",
  "/apple-icon",
  "/api/push/vapid-public",
]);

export async function middleware(req: NextRequest) {
  // Preflight do browser → api.{tenant} (antes do 401 JSON). Origens
  // cockpit/widgets (não-tenant) caem nas rotas que já têm CORS próprio.
  if (req.method === "OPTIONS" && req.nextUrl.pathname.startsWith("/api/")) {
    if (isAllowedBrowserApiOrigin(req.headers.get("origin"))) {
      const preflight = new NextResponse(null, { status: 204 });
      applyBrowserApiCors(req, preflight);
      return preflight;
    }
  }

  let reqAuth: { user?: { id: string; isSuperAdmin?: boolean } } | null = null;
  try {
    reqAuth = await readAuthFromRequestCookie(req);
    const { pathname, search } = req.nextUrl;

    if (pathname.startsWith("/uploads/")) {
      const rewritten = req.nextUrl.clone();
      rewritten.pathname = `/api${pathname}`;
      rewritten.search = search;
      const apiPath = `/api${pathname}`;
      return withSecurityHeaders(
        NextResponse.rewrite(rewritten, {
          request: { headers: forwardApiAuditHeaders(req, apiPath) },
        }),
        req,
      );
    }

    if (
      pathname.startsWith("/api/auth") ||
      pathname.startsWith("/api/webhooks") ||
      pathname.startsWith("/api/health") ||
      pathname.startsWith("/api/cron") ||
      // Endpoints publicos do marketplace de widgets — parceiros chamam
      // do backend deles sem cookie (a confianca esta no JWT assinado).
      pathname.startsWith("/api/public/") ||
      pathname.startsWith("/_next") ||
      pathname.startsWith("/favicon.ico")
    ) {
      return nextWithSecurityAndAudit(req);
    }

    if (/\.(?:svg|png|jpg|jpeg|gif|webp|ico)$/i.test(pathname)) {
      return nextWithSecurityAndAudit(req);
    }

    if (
      PWA_PUBLIC_PATHS.has(pathname) ||
      pathname.startsWith("/swe-worker-") ||
      pathname.startsWith("/workbox-")
    ) {
      return nextWithSecurityAndAudit(req);
    }

    if (PUBLIC_PATHS.has(pathname) || PUBLIC_API_PATHS.has(pathname)) {
      return nextWithSecurityAndAudit(req);
    }

    if (
      !reqAuth &&
      pathname.startsWith("/api/") &&
      !pathname.startsWith("/api/auth") &&
      !pathname.startsWith("/api/sse")
    ) {
      const authHeader = req.headers.get("authorization") ?? "";
      if (/^Bearer\s+.+/i.test(authHeader)) {
        return nextWithSecurityAndAudit(req);
      }
    }

    if (!reqAuth) {
      // /api/* sem sessão → 401 JSON (nunca redirect pra /login).
      // Este backend é só API: /login não existe (404 HTML). O frontend
      // faz rewrite same-origin → se redirecionássemos, o fetch recebia
      // HTML e a UI mascarava como "Servidor temporariamente indisponível".
      if (pathname.startsWith("/api/")) {
        return withSecurityHeaders(
          NextResponse.json(
            { message: "Unauthorized", code: "AUTH_REQUIRED" },
            { status: 401 },
          ),
          req,
        );
      }
      const loginUrl = new URL("/login", req.nextUrl.origin);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return withSecurityHeaders(NextResponse.redirect(loginUrl), req);
    }

    const isSuperAdmin = Boolean(reqAuth.user?.isSuperAdmin);

    if (
      (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) &&
      !isSuperAdmin
    ) {
      if (pathname.startsWith("/api/admin")) {
        return withSecurityHeaders(
          NextResponse.json(
            { message: "Acesso restrito a administradores da plataforma." },
            { status: 403 },
          ),
          req,
        );
      }
      return withSecurityHeaders(
        NextResponse.redirect(new URL("/", req.nextUrl.origin)),
        req,
      );
    }

    return nextWithSecurityAndAudit(req);
  } catch {
    // Mesma regra: erro no middleware em rota API não pode virar HTML.
    try {
      const pathname = req.nextUrl.pathname;
      if (pathname.startsWith("/api/")) {
        return withSecurityHeaders(
          NextResponse.json(
            { message: "Unauthorized", code: "AUTH_REQUIRED" },
            { status: 401 },
          ),
          req,
        );
      }
    } catch {
      /* fall through */
    }
    const loginUrl = new URL("/login", req.nextUrl.origin);
    return withSecurityHeaders(NextResponse.redirect(loginUrl), req);
  }
}

export const config = {
  // api/uploads e academic-records/upload ficam fora do catch-all: multipart
  // grande não deve passar pelo buffer do middleware. Auth já roda na rota.
  matcher: [
    "/uploads/:path*",
    "/((?!_next/static|_next/image|favicon.ico|api/uploads|api/academic-records/upload|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
