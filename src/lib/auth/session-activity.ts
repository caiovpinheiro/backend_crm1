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
 * Sessão SEM registro no Redis (Redis vazio/limpo, chave expirada): o
 * registro é semeado (`SET NX`) com a última atividade real do usuário no
 * banco — `MAX(system_activity_sessions.lastActivityAt)`, ou o último login
 * bem-sucedido (`login_attempts`) se for mais recente — numa consulta só,
 * feita apenas nesse caso; depois o valor fica no Redis. Se a semente já
 * passou do limite, a sessão expira. Usuário SEM nenhuma linha em
 * `system_activity_sessions` (nunca mandou `/activity`, ex.: só usa o app
 * mobile) é semeado com "agora" e passa. Banco fora: não semeia, passa.
 *
 * Redis fora / sem `REDIS_URL`: fail-open (não expira ninguém).
 *
 * TTL da chave (`SESSION_ACTIVITY_TTL_MS`, 31 dias) > vida máxima do JWT
 * (30 dias): uma sessão parada não "renasce" por a chave ter sumido e ser
 * semeada de novo. Sessão já expirada renova o TTL a cada verificação.
 */
import { Prisma } from "@prisma/client";

import { getCacheClient, noteFailure, noteSuccess } from "@/lib/cache/redis-client";
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";

const log = getLogger("auth/session-activity");

export const SESSION_IDLE_TIMEOUT_DEFAULT_HOURS = 12;
export const SESSION_ACTIVITY_CACHE_MS = 30_000;
export const SESSION_ACTIVITY_TTL_MS = 31 * 24 * 60 * 60_000;
const KEY_PREFIX = "auth:session-activity:";
const MAX_ENTRIES = 20_000;

export type SessionActivityRef = {
  userId: string;
  /** Claim `sid` do JWT; ausente em tokens emitidos antes deste deploy. */
  sid?: string | null;
  /** Org da sessão: só restringe a consulta da semente (índice por org). */
  organizationId?: string | null;
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

const IDLE_HOURS_ENV = ["SESSION_IDLE_HOURS", "SESSION_IDLE_TIMEOUT_HOURS"] as const;

/**
 * Limite de inatividade em ms. Env em horas (> 0; fração aceita — 0.05 =
 * 3 min, para teste na DEV): `SESSION_IDLE_HOURS` (nome preferido) ou o
 * alias antigo `SESSION_IDLE_TIMEOUT_HOURS`; vale o primeiro válido nessa
 * ordem. Padrão 12.
 */
export function sessionIdleTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  let hours = SESSION_IDLE_TIMEOUT_DEFAULT_HOURS;
  for (const name of IDLE_HOURS_ENV) {
    const text = env[name]?.trim();
    if (!text) continue;
    const raw = Number(text);
    if (Number.isFinite(raw) && raw > 0) {
      hours = raw;
      break;
    }
  }
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
 * Semente para sessão sem registro no Redis: última atividade real do
 * usuário no banco, numa consulta. `null` = nenhuma linha em
 * `system_activity_sessions` (o chamador semeia com "agora"). O último
 * login bem-sucedido só entra como piso (login conta como atividade real);
 * sem linha de atividade, o login sozinho não arma a expiração.
 * Lança se o banco falhar.
 *
 * `prismaBase`: roda no wrapper de `auth()`, antes do RequestContext; o
 * filtro de org (quando há) vem da própria sessão.
 */
export async function lastRealActivityFromDb(
  ref: SessionActivityRef,
): Promise<number | null> {
  const orgFilter = ref.organizationId
    ? Prisma.sql`AND "organizationId" = ${ref.organizationId}`
    : Prisma.empty;
  const rows = await prismaBase.$queryRaw<
    Array<{ lastActivityAt: Date | string | null; lastLoginAt: Date | string | null }>
  >`
    SELECT
      (SELECT MAX("lastActivityAt") FROM "system_activity_sessions"
        WHERE "userId" = ${ref.userId} ${orgFilter}) AS "lastActivityAt",
      (SELECT MAX("createdAt") FROM "login_attempts"
        WHERE "userId" = ${ref.userId} AND "outcome" = 'success') AS "lastLoginAt"
  `;
  const toMs = (v: Date | string | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  const activity = toMs(rows[0]?.lastActivityAt);
  if (activity === null) return null;
  const login = toMs(rows[0]?.lastLoginAt);
  return login === null ? activity : Math.max(activity, login);
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
 * `true` quando a última atividade real da sessão passou do limite
 * (`sessionIdleTimeoutMs`). Sem registro → semeia com a última atividade do
 * banco (`lastRealActivityFromDb`; sem nenhuma, "agora"). Redis
 * indisponível → `false` (fail-open). Nunca mexe em `sessionVersion`: só
 * esta sessão expira, os outros dispositivos do usuário seguem.
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
      // Sem registro (Redis novo/limpo): semeia com a última atividade real
      // do banco; sem nenhuma, "agora". Banco fora: passa sem semear (tenta
      // de novo quando o cache de 30 s vencer).
      let seed: number;
      try {
        seed = Math.min(now, (await lastRealActivityFromDb(ref)) ?? now);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          "semente da inatividade: consulta falhou; sessão passa",
        );
        noteSuccess();
        remember(key, { lastActivityAt: now, readAt: now, expired: false });
        return false;
      }
      const seeded = await client.set(key, String(seed), "PX", SESSION_ACTIVITY_TTL_MS, "NX");
      last = seeded === "OK" ? seed : (parseMs(await client.get(key)) ?? seed);
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

/**
 * `lastInteractionAt` do corpo (ISO 8601 ou epoch em ms) → ms. Ausente,
 * ilegível ou no futuro → `null` (o campo é ignorado; vale a checagem por
 * Redis de sempre).
 */
export function parseLastInteractionAt(raw: unknown, now = Date.now()): number | null {
  let ms: number;
  if (typeof raw === "number") {
    ms = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    const text = raw.trim();
    ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  } else {
    return null;
  }
  if (!Number.isFinite(ms) || ms <= 0 || ms > now) return null;
  return ms;
}

/** Só testes. */
export function clearSessionActivityCacheForTests(): void {
  memory.clear();
}
