/**
 * Fallback opcional do Painel para o banco PRINCIPAL quando não há réplica de
 * leitura (`DATABASE_URL_REPLICA` ausente ou derrubada).
 *
 * Desligado por padrão (`PAINEL_PRIMARY_FALLBACK`): sem a env, os blocos que só
 * rodam na réplica continuam voltando `reason: "no_replica"`. Ligado:
 *  - roda numa transação no primário com `statement_timeout` local
 *    (`set_config(..., true)` = `SET LOCAL`; `PAINEL_PRIMARY_TIMEOUT_MS`,
 *    padrão 8000) — a transação inteira também tem esse teto (+ folga);
 *  - resultado em cache por org + parâmetros (`cachedReport`: 60 s fresco +
 *    120 s vencido; quem chega com o vencido recebe ele na hora);
 *  - no máximo 1 cálculo simultâneo por org (lock curto no Redis; sem Redis,
 *    lock do processo). Quem não pega o lock espera ele soltar até o teto.
 * Falha, timeout ou espera esgotada lançam: quem chama devolve o bloco
 * `ok:false` com `reason: "primary_timeout"`. Nada de erro vai para o cache.
 */

import { getCacheClient } from "@/lib/cache/redis-client";
import { getLogger } from "@/lib/logger";
import { prisma, type ScopedTx } from "@/lib/prisma";
import { cachedReport, type ReportCacheStatus } from "@/lib/report-cache";

const log = getLogger("painel-primary-fallback");

export const PAINEL_PRIMARY_TIMEOUT_DEFAULT_MS = 8_000;
const TIMEOUT_MIN_MS = 500;
const TIMEOUT_MAX_MS = 60_000;
/** Folga da transação sobre o `statement_timeout` (BEGIN, SET, COMMIT). */
const TX_SLACK_MS = 2_000;
/** Espera por uma conexão livre do pool antes de desistir. */
const TX_MAX_WAIT_MS = 2_000;
/** Intervalo entre tentativas de pegar o lock da org. */
const LOCK_POLL_MS = 200;
const LOCK_PREFIX = "painel-primary-lock:";
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Lock do processo quando o Redis não está disponível (org → token). */
const localLocks = new Map<string, string>();

/** `PAINEL_PRIMARY_FALLBACK=1|true|on` liga o fallback. Padrão: desligado. */
export function isPainelPrimaryFallbackEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.PAINEL_PRIMARY_FALLBACK ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** `PAINEL_PRIMARY_TIMEOUT_MS` inteiro entre 500 e 60000; senão 8000. */
export function painelPrimaryTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.PAINEL_PRIMARY_TIMEOUT_MS);
  return Number.isInteger(n) && n >= TIMEOUT_MIN_MS && n <= TIMEOUT_MAX_MS
    ? n
    : PAINEL_PRIMARY_TIMEOUT_DEFAULT_MS;
}

/** Outra requisição da mesma org segurou o lock até o fim da espera. */
export class PainelPrimaryBusyError extends Error {
  constructor() {
    super("painel: cálculo no primário ocupado para esta org");
    this.name = "PainelPrimaryBusyError";
  }
}

type LockHandle = { kind: "redis" | "local"; key: string; token: string };

async function tryAcquire(orgId: string, token: string, ttlMs: number): Promise<LockHandle | null> {
  const key = LOCK_PREFIX + orgId;
  const client = getCacheClient();
  if (client) {
    try {
      const reply = await client.set(key, token, "PX", ttlMs, "NX");
      return reply === "OK" ? { kind: "redis", key, token } : null;
    } catch (err) {
      // Redis fora: o lock do processo ainda evita cálculos paralelos nesta réplica.
      log.warn({ err, orgId }, "[painel/primary] lock no Redis falhou; usando lock do processo");
    }
  }
  if (localLocks.has(orgId)) return null;
  localLocks.set(orgId, token);
  return { kind: "local", key: orgId, token };
}

async function release(lock: LockHandle): Promise<void> {
  if (lock.kind === "local") {
    if (localLocks.get(lock.key) === lock.token) localLocks.delete(lock.key);
    return;
  }
  const client = getCacheClient();
  if (!client) return;
  // Compare-and-delete: não solta o lock de outro se o nosso já expirou.
  await client.eval(RELEASE_LOCK_SCRIPT, 1, lock.key, lock.token).catch(() => undefined);
}

function newToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/**
 * Roda `fn` segurando o lock da org. O lock expira sozinho em `timeoutMs` +
 * folga (curto: se o processo morrer, a org não fica travada). Quem espera
 * desiste em duas vezes esse tempo (um cálculo inteiro de outro bloco + o seu).
 */
async function withOrgLock<T>(orgId: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const ttlMs = timeoutMs + TX_SLACK_MS + TX_MAX_WAIT_MS;
  const deadline = Date.now() + 2 * ttlMs;
  const token = newToken();
  let lock = await tryAcquire(orgId, token, ttlMs);
  while (!lock) {
    if (Date.now() >= deadline) throw new PainelPrimaryBusyError();
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    lock = await tryAcquire(orgId, token, ttlMs);
  }
  try {
    return await fn();
  } finally {
    await release(lock);
  }
}

/**
 * Transação no primário com `statement_timeout` local. `set_config(..., true)`
 * é o `SET LOCAL` parametrizado (mesmo padrão de `lib/rls.ts`): vale só até o
 * COMMIT/ROLLBACK, a conexão volta ao pool com o timeout de sempre.
 */
async function runOnPrimary<T>(timeoutMs: number, fn: (tx: ScopedTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`;
      return fn(tx);
    },
    { maxWait: TX_MAX_WAIT_MS, timeout: timeoutMs + TX_SLACK_MS },
  );
}

/**
 * Calcula no primário com cache + lock por org (ver o topo do arquivo).
 * `parts` entra na chave junto com a org (`cachedReport`): período, relógio e
 * os blocos pedidos.
 */
export function cachedOnPrimary<T>(
  name: string,
  orgId: string,
  parts: Record<string, unknown>,
  compute: (tx: ScopedTx) => Promise<T>,
  opts?: { onStatus?: (status: ReportCacheStatus) => void },
): Promise<T> {
  const timeoutMs = painelPrimaryTimeoutMs();
  return cachedReport(
    `painel_primary:${name}`,
    orgId,
    parts,
    () => withOrgLock(orgId, timeoutMs, () => runOnPrimary(timeoutMs, compute)),
    opts,
  );
}
