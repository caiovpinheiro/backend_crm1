/**
 * Versão da sessão (SV-1) — parte pura, sem Prisma (importável do
 * `auth.config.ts` e de qualquer lugar).
 *
 * O JWT carrega a claim `sessionVersion` gravada no login. O banco guarda
 * `users.sessionVersion`; quem incrementa (troca de senha, "sair de todos
 * os dispositivos", erase, remoção da org — `session-revocation.ts`) torna
 * todo token anterior inválido: o callback `jwt` e o `requireAuth`
 * comparam claim × banco e respondem 401.
 *
 * Cache em memória por processo, no mesmo molde de `jwt-refresh-cache.ts`:
 * TTL `SESSION_VERSION_TTL_MS` (60 s), invalidação imediata no processo
 * que incrementou, teto de entradas com descarte da mais antiga. O refresh
 * do JWT (a cada 30 s por usuário) re-prima este cache com o valor que já
 * leu — na prática o token antigo cai nas outras réplicas em ≤ 30 s.
 *
 * Compatibilidade: token sem a claim (emitido antes do deploy) vale 0,
 * igual ao default da coluna — nenhum usuário é deslogado no deploy.
 */

export const SESSION_VERSION_TTL_MS = 60_000;
const MAX_ENTRIES = 10_000;

type Entry = { expiresAt: number; version: number };

const store = new Map<string, Entry>();

/** Normaliza a claim/coluna: inteiro ≥ 0; qualquer outra coisa vale 0. */
export function sessionVersionFromClaim(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function getCachedSessionVersion(
  userId: string,
  now = Date.now(),
): number | null {
  const entry = store.get(userId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    store.delete(userId);
    return null;
  }
  return entry.version;
}

export function setCachedSessionVersion(
  userId: string,
  version: number,
  now = Date.now(),
): void {
  store.delete(userId);
  store.set(userId, { expiresAt: now + SESSION_VERSION_TTL_MS, version });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Invalidação imediata (processo atual). Idempotente. */
export function invalidateSessionVersionCache(userId: string): void {
  store.delete(userId);
}

/**
 * Compara a claim do token com a versão conhecida. `null` em `known` é
 * "sem veredito" (cache frio / linha não encontrada / banco fora) e deixa
 * passar — fail-open de propósito: a autenticação em si já foi validada e
 * usuário apagado cai pelo refresh do JWT, não por aqui.
 */
export function sessionVersionMatches(
  tokenVersion: number,
  known: number | null,
): boolean {
  if (known === null) return true;
  return known === tokenVersion;
}

/** Só testes. */
export function clearSessionVersionCacheForTests(): void {
  store.clear();
}
