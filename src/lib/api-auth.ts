import { NextResponse } from "next/server";

import { logApiAccessAuthReject, logApiAccessCompleted, resolveResponseStatus } from "@/lib/api-access-audit";
import { auth } from "@/lib/auth";
import { observeHttpRequest } from "@/lib/metrics";
import { enforceOrgApiRateLimit } from "@/lib/org-rate-limit";
import {
  consumeRateLimit,
  enforceSessionApiRateLimit,
  type RateLimitDecision,
} from "@/lib/rate-limit";
import { logRateLimitReject } from "@/lib/rate-limit-reject-log";
import { validateToken } from "@/services/api-tokens";
import {
  enterRequestContext,
  runWithContext,
  type ContextActor,
  type RequestContext,
} from "@/lib/request-context";

export type ApiUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  /// Orgid resolvido do ApiToken (Bearer) ou do session.user (NextAuth).
  /// Null so quando o caller e super-admin global (sem vinculo com org).
  organizationId: string | null;
  isSuperAdmin: boolean;
  /// Ator rico resolvido na autenticacao. Bearer token -> INTEGRATION
  /// (com nome do token); sessao NextAuth -> HUMAN (com nome do user).
  /// Propagado para `runWithApiUserContext` para que o activity log
  /// atribua corretamente a ORIGEM (ex.: lead criado via n8n aparece
  /// como integracao, nao como o usuario tecnico dono do token).
  actor?: ContextActor;
};

export type ApiAuthResult =
  | { ok: true; user: ApiUser; viaToken: boolean; tokenHash?: string }
  | { ok: false; response: NextResponse };

export async function authenticateApiRequest(
  request: Request
): Promise<ApiAuthResult> {
  const authHeader = request.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (match) {
    const rawToken = match[1].trim();
    const result = await validateToken(rawToken);

    if (result) {
      // Rate limit DISTRIBUÍDO (Redis) por token — o limiter em memória
      // anterior valia por processo: com N réplicas o teto efetivo era
      // N×400/min, e um restart zerava a janela.
      const rl = await consumeRateLimit(`token:${result.tokenHash}`, "api.token");
      if (!rl.allowed) {
        let route = "";
        try {
          route = new URL(request.url).pathname;
        } catch {
          route = "";
        }
        logRateLimitReject(`token:${result.tokenHash}`, {
          profile: "api.token",
          scope: "token",
          tokenHashPrefix: result.tokenHash.slice(0, 12),
          route: route || undefined,
          limit: rl.limit,
          retryAfterSec: rl.retryAfterSec,
        });
        const res = NextResponse.json(
          { message: "Limite de requisições excedido. Tente novamente em breve." },
          { status: 429 }
        );
        setTokenRateLimitHeaders(res.headers, rl);
        return { ok: false, response: res };
      }

      // Ativa o ctx ja aqui pra qualquer prisma.* seguinte no handler
      // funcionar sem precisar envolver em `withApiAuthContext`. Rotas
      // que usam a forma nova (runWithContext) sobrescrevem idempotente.
      // Bearer token -> ator INTEGRATION com o nome do token como label.
      // Permite que o feed mostre "n8n_comercial" em vez do email do user
      // tecnico dono do token.
      const tokenActor: ContextActor = {
        type: "INTEGRATION",
        label: result.tokenName ?? "API Token",
        ref: result.tokenId,
      };
      const bearerUser: ApiUser = {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role,
        organizationId: result.organizationId,
        isSuperAdmin: result.user.isSuperAdmin,
        actor: tokenActor,
      };
      const orgRpm = await rejectIfOrgRateLimited(request, bearerUser, true);
      if (orgRpm) return { ok: false, response: orgRpm };

      enterRequestContext({
        organizationId: result.organizationId,
        userId: result.user.id,
        isSuperAdmin: result.user.isSuperAdmin,
        actor: tokenActor,
      });

      return {
        ok: true,
        user: bearerUser,
        viaToken: true,
        tokenHash: result.tokenHash,
      };
    }

    // Bearer inválido/expirado: tenta sessão (ex.: cockpit no frontend com
    // cookie de login e token antigo ainda no localStorage).
    logApiAccessAuthReject(request, { reason: "invalid_bearer_token", status: 401, via: "bearer" });
  }

  const session = await auth();
  if (!session?.user?.id) {
    logApiAccessAuthReject(request, { reason: "no_session", status: 401, via: "session" });
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Não autorizado." },
        { status: 401 }
      ),
    };
  }

  const sessionUser = session.user as {
    id: string;
    name?: string | null;
    email?: string | null;
    role?: string;
    organizationId?: string | null;
    isSuperAdmin?: boolean;
  };

  if (!sessionUser.isSuperAdmin && !sessionUser.organizationId) {
    logApiAccessAuthReject(request, { reason: "session_missing_organization", status: 401, via: "session" });
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Sessão sem organização." },
        { status: 401 }
      ),
    };
  }

  const sessionApiUser: ApiUser = {
    id: sessionUser.id,
    name: sessionUser.name ?? "",
    email: sessionUser.email ?? "",
    role: sessionUser.role ?? "MEMBER",
    organizationId: sessionUser.organizationId ?? null,
    isSuperAdmin: Boolean(sessionUser.isSuperAdmin),
    actor: {
      type: "HUMAN",
      label: sessionUser.name ?? sessionUser.email ?? sessionUser.id,
    },
  };
  const sessionRpm = await enforceSessionApiRateLimit({
    userId: sessionApiUser.id,
    organizationId: sessionApiUser.organizationId,
  });
  if (sessionRpm) return { ok: false, response: sessionRpm };

  const orgRpm = await rejectIfOrgRateLimited(request, sessionApiUser, false);
  if (orgRpm) return { ok: false, response: orgRpm };

  // ATENCAO: NAO chamar enterRequestContext aqui. Ele usa enterWith()
  // que so se propaga pra continuations FILHAS — quando o handler
  // resume apos `const r = await authenticateApiRequest(req)`, o
  // store ja se foi (parent continuation nao herdou). Use
  // `withApiAuthContext(req, handler)` em vez de chamar este helper
  // direto, ou envolva o handler em runWithContext manualmente.
  return {
    ok: true,
    user: sessionApiUser,
    viaToken: false,
  };
}

async function rejectIfOrgRateLimited(
  request: Request,
  user: ApiUser,
  viaToken: boolean,
): Promise<NextResponse | null> {
  let pathname = "";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    pathname = "";
  }
  const res = await enforceOrgApiRateLimit({
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
    pathname,
    viaToken,
  });
  // 429 da org já entra em logRateLimitReject (agregado) em enforceOrgApiRateLimit.
  return res;
}

function setTokenRateLimitHeaders(
  headers: Headers,
  rl: RateLimitDecision
): void {
  headers.set("X-RateLimit-Limit", String(rl.limit));
  headers.set("X-RateLimit-Remaining", String(rl.remaining));
  headers.set("X-RateLimit-Reset", String(Math.floor(rl.resetAt / 1000)));
  if (!rl.allowed) {
    headers.set("Retry-After", String(rl.retryAfterSec));
  }
}

export async function withRateLimitHeaders(
  response: NextResponse,
  tokenHash?: string
): Promise<NextResponse> {
  if (tokenHash) {
    const rl = await consumeRateLimit(`token:${tokenHash}`, "api.token");
    setTokenRateLimitHeaders(response.headers, rl);
  }
  return response;
}

/**
 * Wrapper que roda o handler em contexto tenant-scoped usando o
 * organizationId resolvido pelo Bearer/session. Substitui o padrao de
 * authenticateApiRequest + executar logica — a vantagem eh garantir
 * que a Prisma Extension e a RLS tenham acesso ao ctx sem esforco.
 */
export async function withApiAuthContext<T>(
  request: Request,
  handler: (user: ApiUser) => Promise<T> | T,
): Promise<NextResponse | T> {
  const r = await authenticateApiRequest(request);
  if (!r.ok) return r.response;
  const actor: ContextActor = r.viaToken
    ? {
        type: "INTEGRATION",
        label: r.tokenHash ? `API Token (${r.user.name || r.user.email})` : "API Token",
        ref: r.tokenHash,
      }
    : { type: "HUMAN", label: r.user.name || r.user.email || r.user.id };
  const ctx: RequestContext = {
    organizationId: r.user.organizationId,
    userId: r.user.id,
    isSuperAdmin: r.user.isSuperAdmin,
    actor,
  };
  const method = request.method;
  let path = "";
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = "";
  }
  const t0 = Date.now();
  try {
    const out = (await runWithContext(ctx, () => handler(r.user))) as T;
    const durationMs = Date.now() - t0;
    const status = resolveResponseStatus(out);
    observeHttpRequest({ method, path, status, durationMs });
    void logApiAccessCompleted({
      method,
      path,
      status,
      durationMs,
      userId: r.user.id,
      organizationId: r.user.organizationId,
    });
    return out;
  } catch (err) {
    const durationMs = Date.now() - t0;
    observeHttpRequest({ method, path, status: 500, durationMs });
    void logApiAccessCompleted({
      method,
      path,
      status: 500,
      durationMs,
      userId: r.user.id,
      organizationId: r.user.organizationId,
    });
    throw err;
  }
}

/**
 * Helper compacto pra rotas que ja chamam authenticateApiRequest direto
 * (legado) — envolve a lambda em runWithContext usando o user resolvido.
 *
 * Use quando refatorar pra `withApiAuthContext` for muito invasivo. O
 * resultado eh equivalente: tudo dentro da lambda enxerga o ctx via
 * getOrgIdOrThrow(), prisma extension scopa por org, etc.
 */
export function runWithApiUserContext<T>(
  user: ApiUser,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  // Usa o ator resolvido na autenticacao (INTEGRATION p/ Bearer token,
  // HUMAN p/ sessao). Fallback HUMAN apenas se o user vier sem actor
  // (callers legados que montam ApiUser na mao). Isso preserva a ORIGEM
  // do lead no activity log — lead via n8n aparece como integracao.
  return runWithContext(
    {
      organizationId: user.organizationId,
      userId: user.id,
      isSuperAdmin: user.isSuperAdmin,
      actor: user.actor ?? {
        type: "HUMAN",
        label: user.name || user.email || user.id,
      },
    },
    fn,
  );
}
