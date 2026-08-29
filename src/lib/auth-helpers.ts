import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";

import {
  logApiAccessCompleted,
  logApiAccessRequireAuthFail,
  readApiAccessHeaders,
  resolveResponseStatus,
} from "@/lib/api-access-audit";
import { observeHttpRequest } from "@/lib/metrics";
import { enforceOrgApiRateLimit } from "@/lib/org-rate-limit";
import { enforceSessionApiRateLimit } from "@/lib/rate-limit";
import { auth } from "./auth";
import {
  loadAuthzContext,
  can,
  type AuthzContext,
  type PermissionKey,
} from "./authz";
import {
  enterRequestContext,
  runWithContext,
  type ContextActor,
  type RequestContext,
} from "./request-context";

/**
 * Resultado padronizado das checagens. Quando `ok=false`, devolve
 * direto um `NextResponse` 401/403 que o handler propaga sem precisar
 * decidir nada — reduz boilerplate e garante mesma resposta em todo
 * lugar.
 */
type AuthResult<T> =
  | { ok: true; session: T }
  | { ok: false; response: NextResponse };

/**
 * Session "achatada" — o tipo retornado pelo `auth()` da v5 é uma
 * união grande (middleware/handler/sem args) e a inferência via
 * `ReturnType<typeof auth>` perde a propriedade `user`. Definimos
 * o shape mínimo que usamos e fazemos cast no helper.
 */
type Session = {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    role?: UserRole;
    /// Id da organizacao resolvida no JWT. Null APENAS para super-admin EduIT.
    organizationId: string | null;
    /// Slug da org (subdomain). Null APENAS para super-admin sem org.
    organizationSlug?: string | null;
    /// Habilita bypass da RLS e acesso a /admin/organizations.
    isSuperAdmin: boolean;
    image?: string | null;
  };
};

function sessionHumanActor(session: Session): ContextActor {
  return {
    type: "HUMAN",
    label:
      session.user.name?.trim() ||
      session.user.email?.trim() ||
      session.user.id,
  };
}

/**
 * Exige sessão autenticada. Use no topo de qualquer route handler
 * que precise de usuário logado.
 *
 * ```ts
 * export async function GET() {
 *   const r = await requireAuth();
 *   if (!r.ok) return r.response;
 *   const { session } = r;
 *   ...
 * }
 * ```
 */
export async function requireAuth(): Promise<AuthResult<Session>> {
  const session = (await auth()) as Session | null;
  if (!session?.user) {
    await logApiAccessRequireAuthFail("no_session");
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Não autorizado." },
        { status: 401 },
      ),
    };
  }
  // Bloqueio defensivo: user nao-super-admin sem organizationId e
  // um estado corrompido (provavelmente migration manual incompleta).
  // Logar e rejeitar em vez de confiar no JWT.
  if (!session.user.isSuperAdmin && !session.user.organizationId) {
    await logApiAccessRequireAuthFail("session_missing_organization");
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Sessão sem organização — contate o suporte." },
        { status: 401 },
      ),
    };
  }

  // Per-credential (cookie): bloqueia loop de render no frontend (~15 req/s).
  // Org RPM abaixo só vale pra Bearer — sessão não compete com n8n.
  const sessionRpm = await enforceSessionApiRateLimit({
    userId: session.user.id,
    organizationId: session.user.organizationId,
  });
  if (sessionRpm) {
    return { ok: false, response: sessionRpm };
  }

  const orgRpm = await enforceOrgApiRateLimit({
    organizationId: session.user.organizationId,
    isSuperAdmin: session.user.isSuperAdmin,
    viaToken: false,
  });
  if (orgRpm) {
    // 429 da org já entra em logRateLimitReject (agregado) em enforceOrgApiRateLimit.
    return { ok: false, response: orgRpm };
  }

  // Ativa o RequestContext logo apos resolver a session. enterWith()
  // propaga o store pra continuation atual E pra todas as continuations
  // descendentes geradas pelos awaits subsequentes do caller — incluindo
  // o handler que recebe `await requireAuth()`. Isso elimina a
  // necessidade de envolver cada handler em runWithContext/withOrgContext
  // explicito, fazendo getOrgIdOrThrow() / Prisma extension funcionarem
  // em qualquer rota que chame requireAuth() (direto ou via requireRole/
  // requireAdmin/requireManager). O comentario antigo em request-context.ts
  // dizia que NAO funcionava — testes empiricos confirmam que funciona
  // sim (Node v18+, AsyncLocalStorage.enterWith propaga pro caller via
  // promise resolution).
  enterRequestContext({
    organizationId: session.user.organizationId,
    userId: session.user.id,
    isSuperAdmin: session.user.isSuperAdmin,
    actor: sessionHumanActor(session),
  });

  return { ok: true, session };
}

function getRole(session: Session): UserRole | null {
  const role = (session.user as { role?: unknown }).role;
  if (role === UserRole.ADMIN || role === UserRole.MANAGER || role === UserRole.MEMBER) {
    return role;
  }
  return null;
}

/**
 * Exige que o usuário tenha um dos roles permitidos. Retorna 403 caso
 * contrário (sessão presente mas sem permissão).
 */
export async function requireRole(
  allowed: UserRole[],
): Promise<AuthResult<Session>> {
  const r = await requireAuth();
  if (!r.ok) return r;
  const role = getRole(r.session);
  if (!role || !allowed.includes(role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Acesso negado." },
        { status: 403 },
      ),
    };
  }
  return r;
}

/** Atalho: somente ADMIN. */
export function requireAdmin() {
  return requireRole([UserRole.ADMIN]);
}

/** Atalho: ADMIN ou MANAGER (operações de gestão). */
export function requireManager() {
  return requireRole([UserRole.ADMIN, UserRole.MANAGER]);
}

/**
 * Exige super-admin EduIT (`isSuperAdmin=true`). Responde 403 pra qualquer
 * outra sessao. Use em rotas `/api/admin/*` e paginas `/admin/*` renderizadas
 * do servidor.
 */
export async function requireSuperAdmin(): Promise<AuthResult<Session>> {
  const r = await requireAuth();
  if (!r.ok) return r;
  if (!r.session.user.isSuperAdmin) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Acesso restrito a administradores da plataforma." },
        { status: 403 },
      ),
    };
  }
  return r;
}

/** Helper síncrono pra uso em código já com session em mãos. */
export function isAdmin(session: Session | null | undefined): boolean {
  if (!session?.user) return false;
  return getRole(session) === UserRole.ADMIN;
}

export function isManagerOrAdmin(session: Session | null | undefined): boolean {
  if (!session?.user) return false;
  const role = getRole(session);
  return role === UserRole.ADMIN || role === UserRole.MANAGER;
}

export function isSuperAdmin(session: Session | null | undefined): boolean {
  return Boolean(session?.user?.isSuperAdmin);
}

/**
 * Helper de filtro multi-tenancy para o model `User`.
 *
 * O model `User` NAO esta no SCOPED_MODELS da Prisma Extension porque o
 * login (NextAuth authorize) precisa achar User por email sem contexto.
 * Em troca, TODA rota que lista users via prisma.user.* precisa filtrar
 * manualmente pela org da sessao. Este helper centraliza essa logica.
 *
 * Semantica (ordem importa):
 *   1. Tem org ativa  -> { organizationId: <org> }. Vale TAMBEM para
 *      super-admin: operando "dentro" de uma org, ele enxerga apenas
 *      aquela org nas telas org-scoped (Equipe, filtros do Kanban, etc).
 *   2. Super-admin SEM org ativa -> {} (visao global). Esse e o unico
 *      caminho de bypass, reservado ao contexto de plataforma. As rotas
 *      `/admin/*` tem logica propria e NAO dependem deste helper.
 *   3. User normal sem org -> { organizationId: "__none__" } (nada).
 *
 * Uso:
 *   const where = { type: "HUMAN", ...userOrgFilter(session) };
 *   await prisma.user.findMany({ where, ... });
 *
 * Fix de regressao 24/abr/26: GET /api/users vazava lista global de users
 * entre tenants porque o filtro estava faltando.
 *
 * Fix 29/mai/26 (tenancy P0): o bypass `if (isSuperAdmin) return {}` vinha
 * ANTES da checagem de org ativa, entao um super-admin com org (ex.: dono
 * da plataforma que tambem e membro de uma org) via usuarios de TODAS as
 * orgs na tela de Equipe — e podia ate excluir/editar cross-org. Agora a
 * org ativa tem prioridade; o bypass so vale quando NAO ha org ativa.
 */
export function userOrgFilter(
  session: Session | { user: { organizationId: string | null; isSuperAdmin: boolean } },
): { organizationId?: string } {
  if (session.user.organizationId) {
    return { organizationId: session.user.organizationId };
  }
  if (session.user.isSuperAdmin) return {};
  return { organizationId: "__none__" };
}

/**
 * Alto nivel: valida auth + cria o AsyncLocalStorage ja embrulhando o
 * handler. A unica forma sanitaria de garantir que a Prisma Extension
 * tenha orgId/isSuperAdmin eh passando por aqui. Use assim em route
 * handlers que precisam de tenant scoped access:
 *
 * ```ts
 * export async function GET() {
 *   return withOrgContext(async (session) => {
 *     // prisma.contact.findMany() ja filtra por session.user.organizationId
 *     const contacts = await prisma.contact.findMany();
 *     return NextResponse.json(contacts);
 *   });
 * }
 * ```
 *
 * O handler interno pode retornar NextResponse ou dado serializavel; em
 * ambos os casos o callback principal devolve o Response final.
 */
export async function withOrgContext<T>(
  handler: (session: Session) => Promise<T> | T,
): Promise<NextResponse | T> {
  const r = await requireAuth();
  if (!r.ok) return r.response as unknown as NextResponse;
  const ctx: RequestContext = {
    organizationId: r.session.user.organizationId,
    userId: r.session.user.id,
    isSuperAdmin: r.session.user.isSuperAdmin,
    actor: sessionHumanActor(r.session),
  };
  const meta = await readApiAccessHeaders();
  const method = meta.method ?? "GET";
  const path = meta.path ?? "";
  const t0 = Date.now();
  try {
    const out = (await runWithContext(ctx, () => handler(r.session))) as T;
    const durationMs = Date.now() - t0;
    const status = resolveResponseStatus(out);
    observeHttpRequest({ method, path, status, durationMs });
    void logApiAccessCompleted({
      method,
      path,
      status,
      durationMs,
      userId: r.session.user.id,
      organizationId: r.session.user.organizationId,
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
      userId: r.session.user.id,
      organizationId: r.session.user.organizationId,
    });
    throw err;
  }
}

/**
 * Variante que roda o handler dentro do contexto SEM exigir auth — util
 * pra webhooks, cron jobs e consumers de fila onde o orgId eh resolvido
 * a partir de outra fonte (Channel.organizationId, ApiToken.user.orgId,
 * job payload). Deixa o caller responsavel por preencher o ctx.
 */
export function withResolvedContext<T>(
  ctx: RequestContext,
  handler: () => Promise<T> | T,
): Promise<T> | T {
  return runWithContext(ctx, handler);
}

// ──────────────────────────────────────────────
// Authz (Fase 1) — helpers compostos
// ──────────────────────────────────────────────
//
// `requireCan(key)` valida auth + carrega AuthzContext + checa permission.
// Retorna a session normalmente em caso de sucesso, com o contexto de
// authz anexado pra evitar reload no handler (passe `result.ctx` em
// chains de checagens subsequentes).

type AuthResultWithCtx<T> =
  | { ok: true; session: T; ctx: AuthzContext }
  | { ok: false; response: NextResponse };

/**
 * Atalho idiomatico pra rotas que exigem uma permission especifica.
 *
 * @example
 *   const r = await requireCan("pipeline:edit");
 *   if (!r.ok) return r.response;
 *   const { session, ctx } = r;
 *   // ctx ja e o AuthzContext do user — reaproveite em can(ctx, ...)
 *   if (!can(ctx, "pipeline:delete")) return forbiddenResponse;
 */
export async function requireCan(
  key: PermissionKey,
): Promise<AuthResultWithCtx<Session>> {
  const r = await requireAuth();
  if (!r.ok) return r;

  const ctx = await loadAuthzContext({
    userId: r.session.user.id,
    organizationId: r.session.user.organizationId,
    isSuperAdmin: r.session.user.isSuperAdmin,
  });

  if (!can(ctx, key)) {
    return {
      ok: false,
      response: NextResponse.json(
        { message: "Acesso negado.", required: key },
        { status: 403 },
      ),
    };
  }

  return { ok: true, session: r.session, ctx };
}

/**
 * Atalho que carrega o contexto sem checar permission. Util quando voce
 * precisa do `ctx` pra fazer checagens condicionais (ex.: filtrar campos
 * do payload baseado no que o user pode ver).
 */
export async function requireAuthWithCtx(): Promise<AuthResultWithCtx<Session>> {
  const r = await requireAuth();
  if (!r.ok) return r;
  const ctx = await loadAuthzContext({
    userId: r.session.user.id,
    organizationId: r.session.user.organizationId,
    isSuperAdmin: r.session.user.isSuperAdmin,
  });
  return { ok: true, session: r.session, ctx };
}
