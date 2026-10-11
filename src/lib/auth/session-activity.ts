/**
 * Expiração da sessão por inatividade REAL (padrão 12 h).
 *
 * Contrato com o frontend: `POST /api/agents/me/activity` só sai quando houve
 * interação real (clique, tecla, navegação) desde o último envio; o ping de
 * presença (`/api/agents/me/ping`) NÃO conta. O login também conta.
 *
 * Registro: último instante de atividade real por SESSÃO, no Redis
 * (`auth:session-activity:sid:<sid>`), em ms. `sid` é a claim estável que o
 * callback `jwt` cria no login (o `jti` do Auth.js muda a cada reemissão do
 * cookie). Token antigo, sem `sid`, cai no nível do usuário
 * (`auth:session-activity:user:<userId>`): atividade de qualquer token antigo
 * do usuário vale para todos os tokens antigos dele.
 *
 * Leitura (`isSessionIdleExpired`, chamada pelo wrapper de `auth()` em
 * `auth.ts`, portanto por toda rota com sessão): cache em memória por sessão
 * (`SESSION_ACTIVITY_CACHE_MS`, 30 s) + Redis; nunca Postgres. Veredito de
 * "expirada" tirado do cache é reconfirmado no Redis (outra réplica pode ter
 * registrado atividade nos últimos 30 s).
 *
 * Deploy: sessão SEM registro (Redis vazio no primeiro deploy, chave
 * expirada) NÃO expira — o registro é semeado com "agora" (`SET NX`) e ela
 * passa. Ninguém é deslogado no deploy; quem ficar 12 h sem atividade real
 * depois disso, cai.
 *
 * Redis fora / sem `REDIS_URL`: fail-open (não expira ninguém).
 *
 * TTL da chave (`SESSION_ACTIVITY_TTL_MS`, 31 dias) > vida máxima do JWT
 * (30 dias): uma sessão parada não "renasce" por a chave ter sumido e ser
 * semeada de novo. Sessão já expirada renova o TTL a cada verificação.
 */
import { getCacheClient, noteFailure, noteSuccess } from "@/lib/cache/redis-client";

export const SESSION_IDLE_TIMEOUT_DEFAULT_HOURS = 12;
export const SESSION_ACTIVITY_CACHE_MS = 30_000;
export const SESSION_ACTIVITY_TTL_MS = 31 * 24 * 60 * 60_000;
const KEY_PREFIX = "auth:session-activity:";
const MAX_ENTRIES = 20_000;

export type SessionActivityRef = {
  userId: string;
  /** Claim `sid` do JWT; ausente em tokens emitidos antes deste deploy. */
  sid?: string | null;
};

type Entry = {
  /** Último instante (ms) de atividade real conhecido. */
  lastActivityAt: number;
  /** Quando este processo leu/gravou o valor (validade do cache). */
  readAt: number;
  /** Veredito "expirada" já confirmado no Redis. */
  expired: boolean;
};

const memory = new Map<string, Entry>();

/** `SESSION_IDLE_TIMEOUT_HOURS` (horas, > 0; fração aceita). Padrão 12. */
export function sessionIdleTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.SESSION_IDLE_TIMEOUT_HOURS);
  const hours =
    Number.isFinite(raw) && raw > 0 ? raw : SESSION_IDLE_TIMEOUT_DEFAULT_HOURS;
  return Math.round(hours * 60 * 60_000);
}

export function sessionActivityKey(ref: SessionActivityRef): string {
  return ref.sid ? `${KEY_PREFIX}sid:${ref.sid}` : `${KEY_PREFIX}user:${ref.userId}`;
}

function remember(key: string, entry: Entry): void {
  memory.delete(key);
  memory.set(key, entry);
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function parseMs(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Registra atividade real agora (login ou `/api/agents/me/activity` com
 * pulsos > 0). Best-effort: nunca lança.
 */
export async function touchSessionActivity(
  ref: SessionActivityRef,
  now = Date.now(),
): Promise<void> {
  const key = sessionActivityKey(ref);
  remember(key, { lastActivityAt: now, readAt: now, expired: false });
  const client = getCacheClient();
  if (!client) return;
  try {
    await client.set(key, String(now), "PX", SESSION_ACTIVITY_TTL_MS);
    noteSuccess();
  } catch (err) {
    noteFailure(err, key, "session-activity.touch");
  }
}

/**
 * `true` quando a última atividade real da sessão passou de
 * `SESSION_IDLE_TIMEOUT_HOURS`. Sem registro → semeia com `now` e devolve
 * `false`. Redis indisponível → `false` (fail-open).
 */
export async function isSessionIdleExpired(
  ref: SessionActivityRef,
  now = Date.now(),
): Promise<boolean> {
  const timeoutMs = sessionIdleTimeoutMs();
  const key = sessionActivityKey(ref);

  const cached = memory.get(key);
  if (cached && now - cached.readAt < SESSION_ACTIVITY_CACHE_MS) {
    if (cached.expired) return true;
    if (now - cached.lastActivityAt <= timeoutMs) return false;
    // Cache diz "expirou", mas pode estar até 30 s atrasado: confirma no Redis.
  }

  const client = getCacheClient();
  if (!client) return false;

  let last: number;
  try {
    const stored = parseMs(await client.get(key));
    if (stored !== null) {
      last = stored;
    } else {
      // Sem registro (deploy / Redis novo): semeia "agora" e deixa passar.
      const seeded = await client.set(key, String(now), "PX", SESSION_ACTIVITY_TTL_MS, "NX");
      last = seeded === "OK" ? now : (parseMs(await client.get(key)) ?? now);
    }
    noteSuccess();
  } catch (err) {
    noteFailure(err, key, "session-activity.read");
    return false;
  }

  const expired = now - last > timeoutMs;
  remember(key, { lastActivityAt: last, readAt: now, expired });
  if (expired) {
    // Mantém o registro vivo enquanto o cookie velho insistir: sem ele, a
    // chave expiraria e a sessão seria semeada de novo ("renasceria").
    client.pexpire(key, SESSION_ACTIVITY_TTL_MS).catch(() => undefined);
  }
  return expired;
}

/** Só testes. */
export function clearSessionActivityCacheForTests(): void {
  memory.clear();
}
