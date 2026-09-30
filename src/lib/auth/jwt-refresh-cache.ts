/**
 * Cache em memória (por processo) do "refresh" que o callback `jwt` do
 * NextAuth faz no banco (SS-2).
 *
 * Antes, TODA chamada de `auth()` fazia `user.findUnique` (com join em
 * organization) só pra espelhar role/avatar/org no token — ≈45 % das
 * queries ociosas (ping, heartbeat, polling, SSE). Agora o resultado fica
 * aqui por `JWT_REFRESH_TTL_MS` (30 s) por `userId`.
 *
 * Por que memória e não `refreshedAt` no token: `auth()` chamado sem
 * `(req, ctx)` em route handlers NÃO regrava o cookie, então um carimbo no
 * token só seria atualizado nas chamadas a `/api/auth/session` — na prática
 * quase toda request voltaria ao banco. A memória vale para qualquer forma
 * de `auth()`.
 *
 * Invalidação
 * ───────────
 * - `invalidateJwtRefreshCache(userId)`: imediata NO PROCESSO atual. É
 *   chamada por `invalidateAuthzForUser` (troca de papel).
 * - Usuário apagado (`isErased`) / org suspensa / troca de org: não há
 *   sinal para o token hoje — o atraso máximo até o logout forçado é
 *   `JWT_REFRESH_TTL_MS` (30 s) por réplica. As permissões reais
 *   (`can()`) não passam por aqui: usam o cache authz com invalidação
 *   própria.
 * - Estado "inválido" (erased/suspensa) também é cacheado: dentro da janela
 *   a sessão continua caindo sem tocar no banco.
 *
 * Tamanho limitado (`MAX_ENTRIES`) com descarte do mais antigo — o Map
 * preserva a ordem de inserção; um `set` reinsere a chave no fim.
 */

import type { AppUserRole } from "../auth-types";

export const JWT_REFRESH_TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

export type JwtRefreshSnapshot =
  | { invalid: true }
  | {
      invalid: false;
      role: AppUserRole | null;
      organizationId: string | null;
      organizationSlug: string | null;
      isSuperAdmin: boolean;
      picture: string | null;
    };

type Entry = { expiresAt: number; snapshot: JwtRefreshSnapshot };

const store = new Map<string, Entry>();

export function getJwtRefreshSnapshot(
  userId: string,
  now = Date.now(),
): JwtRefreshSnapshot | null {
  const entry = store.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    store.delete(userId);
    return null;
  }
  return entry.snapshot;
}

export function setJwtRefreshSnapshot(
  userId: string,
  snapshot: JwtRefreshSnapshot,
  now = Date.now(),
): void {
  store.delete(userId);
  store.set(userId, { expiresAt: now + JWT_REFRESH_TTL_MS, snapshot });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Invalidação imediata (processo atual). Idempotente. */
export function invalidateJwtRefreshCache(userId: string): void {
  store.delete(userId);
}

/** Só testes. */
export function clearJwtRefreshCacheForTests(): void {
  store.clear();
}
