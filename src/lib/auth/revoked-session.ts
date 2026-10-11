/**
 * Sessão revogada identificável — parte pura (sem Prisma/Redis), importável
 * do middleware Edge, do `auth.ts` e das rotas.
 *
 * Antes, o callback `jwt` devolvia `null` (sessionVersion divergente) ou
 * `{}` (usuário apagado / org suspensa). Nos dois casos o `auth()` vinha sem
 * usuário e o `requireAuth` respondia 401 "no_session" SEM `code` — o
 * frontend só faz logout com `code: "SESSION_REVOKED"`, então as abas
 * abertas seguiam pingando a API sem parar.
 *
 * Agora o callback devolve um token MARCADO (`revokedToken`): sem nenhuma
 * claim de sessão útil (sem `id`/`sub`, org, papel, versão), só a marca, o
 * motivo e o id do usuário para log. O callback `session` não expõe usuário
 * para ele (`revokedSession`) e quem lê a sessão responde 401
 * `SESSION_REVOKED` (`sessionRevokedResponse`). Sem cookie continua "sem
 * sessão" (401 sem `code`).
 *
 * O mesmo vale para a expiração por inatividade (`idle_timeout`), marcada
 * no wrapper de `auth()` em `auth.ts`.
 */
import { NextResponse } from "next/server";

export const SESSION_REVOKED_CODE = "SESSION_REVOKED";
export const SESSION_REVOKED_MESSAGE = "Sessão expirada. Entre novamente.";

/**
 * - `session_revoked`: `users.sessionVersion` incrementado (troca de senha,
 *   "sair de todos os dispositivos", admin encerrou as sessões);
 * - `session_invalid`: usuário apagado/erased ou org suspensa;
 * - `idle_timeout`: sem atividade real há mais de `SESSION_IDLE_TIMEOUT_HOURS`.
 */
export type SessionRevokedReason = "session_revoked" | "session_invalid" | "idle_timeout";

const REASONS: ReadonlySet<string> = new Set<SessionRevokedReason>([
  "session_revoked",
  "session_invalid",
  "idle_timeout",
]);

export type RevokedToken = {
  revoked: true;
  revokedReason: SessionRevokedReason;
  /** Só para log/auditoria — NÃO é `id`/`sub`: nada trata o token como logado. */
  revokedUserId?: string;
};

export type RevokedSession = {
  revoked: true;
  revokedReason: SessionRevokedReason;
  expires?: string;
  user?: undefined;
};

export function revokedToken(userId: string | undefined, reason: SessionRevokedReason): RevokedToken {
  return {
    revoked: true,
    revokedReason: reason,
    ...(userId ? { revokedUserId: userId } : {}),
  };
}

function normalizeReason(value: unknown): SessionRevokedReason {
  return typeof value === "string" && REASONS.has(value)
    ? (value as SessionRevokedReason)
    : "session_revoked";
}

export function isRevokedToken(token: unknown): token is RevokedToken {
  return (
    typeof token === "object" &&
    token !== null &&
    (token as { revoked?: unknown }).revoked === true
  );
}

/**
 * Sessão (saída do callback `session`) para um token marcado: sem `user`.
 * A chave `user` vai explícita como `undefined` porque o `auth()` do
 * next-auth no servidor monta `{ user: token, ...session }` — sem ela, o
 * token inteiro viraria `session.user`.
 */
export function revokedSession(
  reason: unknown,
  expires?: string,
): RevokedSession {
  return {
    revoked: true,
    revokedReason: normalizeReason(reason),
    ...(expires ? { expires } : {}),
    user: undefined,
  };
}

/** Motivo da revogação quando `session` é uma sessão marcada; senão `null`. */
export function revokedReasonOf(session: unknown): SessionRevokedReason | null {
  if (
    typeof session !== "object" ||
    session === null ||
    (session as { revoked?: unknown }).revoked !== true
  ) {
    return null;
  }
  return normalizeReason((session as { revokedReason?: unknown }).revokedReason);
}

export function sessionRevokedBody(): { message: string; code: string } {
  return { message: SESSION_REVOKED_MESSAGE, code: SESSION_REVOKED_CODE };
}

/** 401 que o frontend entende como "sessão encerrada → login". */
export function sessionRevokedResponse(): NextResponse {
  return NextResponse.json(sessionRevokedBody(), { status: 401 });
}

const SESSION_COOKIE_RE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;
const EXPIRED = "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0";

function clearSessionCookie(setCookie: string): string | null {
  const [pair, ...attrs] = setCookie.split(";");
  const name = pair.split("=")[0]?.trim() ?? "";
  if (!SESSION_COOKIE_RE.test(name)) return null;
  const kept = attrs
    .map((a) => a.trim())
    .filter((a) => a && !/^(expires|max-age)=/i.test(a));
  return [`${name}=`, ...kept, EXPIRED].join("; ");
}

/**
 * `GET/POST /api/auth/session` (o `useSession` do frontend): para um token
 * marcado o `@auth/core` devolveria a sessão marcada e reemitiria o cookie
 * com ela. Aqui o contrato antigo fica igual: corpo `null` (cliente
 * "unauthenticated") e o cookie de sessão apagado, preservando Domain/Path
 * para o navegador realmente removê-lo. As rotas da API não passam por
 * aqui — elas não regravam o cookie e respondem 401 `SESSION_REVOKED`.
 */
export async function sanitizeRevokedSessionResponse(res: Response): Promise<Response> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  if (!revokedReasonOf(body)) return res;

  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.set(key, value);
  });
  for (const cookie of res.headers.getSetCookie()) {
    headers.append("set-cookie", clearSessionCookie(cookie) ?? cookie);
  }
  return new Response("null", { status: res.status, headers });
}
