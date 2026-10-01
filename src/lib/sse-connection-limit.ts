/**
 * Teto de conexões SSE (SSE-2) — por usuário e por organização, contado
 * no Redis para valer entre réplicas.
 *
 * Por que: cada EventSource prende um worker/socket pelo tempo que a aba
 * viver. Sem teto, um usuário com dezenas de abas (ou um cliente com bug
 * de reconexão) e uma org grande esgotam a instância para todo mundo.
 *
 * Contagem
 * ────────
 * Um ZSET por usuário (`sse:conn:u:<userId>`) e um por organização
 * (`sse:conn:o:<orgId>`); membro = `<startedAt>:<connId>`, score = último
 * heartbeat. Entrada "viva" = score dentro de `SSE_CONNECTION_TTL_MS`
 * (heartbeat + folga para jitter do timer e latência do Redis — com TTL
 * igual ao heartbeat uma renovação atrasada em ms já daria a conexão como
 * morta). A cada heartbeat a rota renova o score; no teardown remove. Uma
 * conexão que morreu sem teardown (processo caiu) some sozinha: a
 * contagem descarta scores velhos e a chave inteira expira sem toques.
 *
 * Ao exceder
 * ──────────
 * - Por organização (`SSE_MAX_PER_ORG`, default 200): a nova conexão é
 *   recusada com 429 + `Retry-After`. Ninguém da org é derrubado por isso.
 * - Por usuário (`SSE_MAX_PER_USER`, default 6): a conexão MAIS ANTIGA do
 *   usuário é encerrada (evento `sse_connection_evicted` + `retry:`) e a
 *   nova entra. Escolha: a aba nova é a que o usuário está olhando; recusar
 *   a nova deixaria a tela ativa sem eventos enquanto abas esquecidas
 *   seguem recebendo. O encerramento cruza réplicas por pub/sub
 *   (`crm:sse:evict`). Risco conhecido: cliente que reconecta na hora após
 *   `sse_connection_evicted` entra em rodízio (cada reconexão derruba a
 *   seguinte); o frame leva `retry:` para o EventSource nativo esperar, e a
 *   conexão única por navegador (frontend, MA-1) elimina o caso na raiz.
 * - `0` em qualquer das envs desliga aquele teto.
 *
 * Falhas
 * ──────
 * Sem `REDIS_URL`, ou com o Redis fora do ar / lento, NÃO limita: loga
 * (no máximo uma vez por minuto) e deixa passar — o teto é rede de
 * proteção, não pode virar indisponibilidade. O contador em memória por
 * processo seria mentira com N réplicas, então não há fallback local.
 *
 * Métricas: `crm_sse_connections_rejected_total{reason}` (org_limit →
 * 429; user_limit_evicted → mais antiga encerrada). Conexões abertas:
 * gauge já existente `crm_sse_subscribers`.
 */
import { randomUUID } from "node:crypto";

import IORedis from "ioredis";

import { getLogger } from "@/lib/logger";
import { metrics } from "@/lib/metrics";
import { waitForRedisWritable } from "@/lib/redis-ready";

const log = getLogger("sse");

/** Intervalo do `: heartbeat` da rota (e da renovação da entrada). */
export const SSE_HEARTBEAT_MS = 25_000;
/** Validade de uma entrada sem renovação. */
export const SSE_CONNECTION_TTL_MS = SSE_HEARTBEAT_MS + 10_000;
export const DEFAULT_SSE_MAX_PER_USER = 6;
export const DEFAULT_SSE_MAX_PER_ORG = 200;
/** Evento enviado à conexão encerrada para dar lugar a outra do mesmo usuário. */
export const SSE_EVICTED_EVENT = "sse_connection_evicted";

const EVICT_CHANNEL = "crm:sse:evict";
const USER_KEY_PREFIX = "sse:conn:u:";
const ORG_KEY_PREFIX = "sse:conn:o:";
const REDIS_READY_TIMEOUT_MS = 500;
const REDIS_FAIL_LOG_INTERVAL_MS = 60_000;

function readLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** `SSE_MAX_PER_USER` (default 6; 0 desliga; inválido cai no default). */
export function getSseMaxPerUser(): number {
  return readLimit("SSE_MAX_PER_USER", DEFAULT_SSE_MAX_PER_USER);
}

/** `SSE_MAX_PER_ORG` (default 200; 0 desliga; inválido cai no default). */
export function getSseMaxPerOrg(): number {
  return readLimit("SSE_MAX_PER_ORG", DEFAULT_SSE_MAX_PER_ORG);
}

export type SseConnectionSlot = {
  connId: string;
  /** Renova a validade da entrada — chame a cada heartbeat. Nunca lança. */
  heartbeat: () => Promise<void>;
  /** Remove a entrada — chame no teardown. Idempotente, nunca lança. */
  release: () => Promise<void>;
};

export type SseAcquireResult =
  | { ok: true; slot: SseConnectionSlot }
  | {
      ok: false;
      reason: "org_limit";
      retryAfterSec: number;
      count: number;
      limit: number;
    };

type State = {
  cmd: IORedis | null | undefined;
  sub: IORedis | null | undefined;
  subscribed: boolean;
  /** Conexões desta réplica: connId → encerra a conexão. */
  local: Map<string, () => void>;
  lastFailLogAt: number;
  noRedisLogged: boolean;
};

const globalForLimit = globalThis as unknown as { sseConnectionLimit?: State };

function state(): State {
  if (!globalForLimit.sseConnectionLimit) {
    globalForLimit.sseConnectionLimit = {
      cmd: undefined,
      sub: undefined,
      subscribed: false,
      local: new Map(),
      lastFailLogAt: 0,
      noRedisLogged: false,
    };
  }
  return globalForLimit.sseConnectionLimit;
}

function redisUrl(): string | null {
  const url = process.env.REDIS_URL?.trim();
  return url ? url : null;
}

function getCmd(): IORedis | null {
  const s = state();
  if (s.cmd !== undefined) return s.cmd;
  const url = redisUrl();
  if (!url) {
    s.cmd = null;
    return null;
  }
  const client = new IORedis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectTimeout: 1_000,
    commandTimeout: 2_000,
  });
  client.on("error", () => {
    /* best-effort: logado no uso, com rate limit */
  });
  void client.connect().catch(() => {});
  s.cmd = client;
  return client;
}

function dispatchEvict(connId: string): void {
  const s = state();
  const close = s.local.get(connId);
  if (!close) return;
  s.local.delete(connId);
  try {
    close();
  } catch (err) {
    log.warn({ err, connId }, "[sse] encerrar conexão evictada falhou");
  }
}

function ensureSubscriber(): void {
  const s = state();
  if (s.subscribed) return;
  const url = redisUrl();
  if (!url) return;
  s.subscribed = true;
  const client = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  client.on("error", () => {
    /* best-effort */
  });
  client.on("message", (channel: string, raw: string) => {
    if (channel !== EVICT_CHANNEL) return;
    try {
      const parsed = JSON.parse(raw) as { connId?: unknown };
      if (typeof parsed?.connId === "string") dispatchEvict(parsed.connId);
    } catch {
      /* payload inválido: ignora */
    }
  });
  s.sub = client;
  void client
    .connect()
    .then(() => client.subscribe(EVICT_CHANNEL))
    .catch((err: unknown) => {
      // Sem subscriber, eviction de outra réplica não chega aqui; a conexão
      // sobra até o cliente fechar. Tenta de novo na próxima conexão.
      s.subscribed = false;
      s.sub = undefined;
      logRedisFailure(err, "subscribe do canal de eviction falhou");
    });
}

function logRedisFailure(err: unknown, what: string): void {
  const s = state();
  const now = Date.now();
  if (now - s.lastFailLogAt < REDIS_FAIL_LOG_INTERVAL_MS) return;
  s.lastFailLogAt = now;
  log.warn({ err }, `[sse] Redis indisponível — teto de conexões desligado (${what})`);
}

const userKey = (userId: string) => `${USER_KEY_PREFIX}${userId}`;
const orgKey = (orgId: string) => `${ORG_KEY_PREFIX}${orgId}`;
const memberOf = (startedAt: number, connId: string) => `${startedAt}:${connId}`;

function parseMember(member: string): { startedAt: number; connId: string } | null {
  const idx = member.indexOf(":");
  if (idx <= 0) return null;
  const startedAt = Number(member.slice(0, idx));
  const connId = member.slice(idx + 1);
  if (!Number.isFinite(startedAt) || !connId) return null;
  return { startedAt, connId };
}

function noopSlot(connId: string): SseConnectionSlot {
  return { connId, heartbeat: async () => undefined, release: async () => undefined };
}

async function liveCount(redis: IORedis, key: string, now: number): Promise<number> {
  await redis.zremrangebyscore(key, "-inf", `(${now - SSE_CONNECTION_TTL_MS}`);
  return redis.zcard(key);
}

/**
 * Registra uma conexão nova. Aplica primeiro o teto da org (recusa), depois
 * o do usuário (encerra a mais antiga). `onEvict` roda quando esta conexão
 * for a escolhida para dar lugar a outra — nesta réplica ou em qualquer
 * outra, via pub/sub.
 */
export async function acquireSseConnection(args: {
  userId: string;
  organizationId: string | null;
  onEvict: () => void;
}): Promise<SseAcquireResult> {
  const connId = randomUUID();
  const maxPerUser = getSseMaxPerUser();
  const maxPerOrg = getSseMaxPerOrg();
  if (maxPerUser === 0 && maxPerOrg === 0) return { ok: true, slot: noopSlot(connId) };

  const redis = getCmd();
  if (!redis) {
    const s = state();
    if (!s.noRedisLogged) {
      s.noRedisLogged = true;
      log.info("[sse] REDIS_URL ausente — teto de conexões SSE desligado");
    }
    return { ok: true, slot: noopSlot(connId) };
  }

  const uKey = userKey(args.userId);
  const oKey = args.organizationId ? orgKey(args.organizationId) : null;
  const keys = oKey ? [uKey, oKey] : [uKey];

  try {
    if (!(await waitForRedisWritable(redis, REDIS_READY_TIMEOUT_MS))) {
      throw new Error("redis não está pronto");
    }
    const now = Date.now();

    if (oKey && maxPerOrg > 0) {
      const count = await liveCount(redis, oKey, now);
      if (count >= maxPerOrg) {
        metrics.sse.connectionsRejected.inc({ reason: "org_limit" });
        log.warn(
          { userId: args.userId, organizationId: args.organizationId, count, limit: maxPerOrg },
          "[sse] teto de conexões da organização atingido — 429",
        );
        return {
          ok: false,
          reason: "org_limit",
          retryAfterSec: Math.ceil(SSE_CONNECTION_TTL_MS / 1000),
          count,
          limit: maxPerOrg,
        };
      }
    }

    if (maxPerUser > 0) {
      const count = await liveCount(redis, uKey, now);
      if (count >= maxPerUser) {
        const members = (await redis.zrange(uKey, 0, -1))
          .map(parseMember)
          .filter((m): m is { startedAt: number; connId: string } => m !== null)
          .sort((a, b) => a.startedAt - b.startedAt);
        const excess = members.slice(0, count - maxPerUser + 1);
        for (const victim of excess) {
          const member = memberOf(victim.startedAt, victim.connId);
          for (const key of keys) await redis.zrem(key, member);
          metrics.sse.connectionsRejected.inc({ reason: "user_limit_evicted" });
          log.info(
            {
              userId: args.userId,
              organizationId: args.organizationId,
              evictedConnId: victim.connId,
              count,
              limit: maxPerUser,
            },
            "[sse] teto por usuário: conexão mais antiga encerrada para a nova entrar",
          );
          dispatchEvict(victim.connId);
          await redis.publish(EVICT_CHANNEL, JSON.stringify({ connId: victim.connId }));
        }
      }
    }

    const member = memberOf(now, connId);
    for (const key of keys) {
      await redis.zadd(key, now, member);
      await redis.pexpire(key, SSE_CONNECTION_TTL_MS);
    }
    state().local.set(connId, args.onEvict);
    ensureSubscriber();

    let released = false;
    return {
      ok: true,
      slot: {
        connId,
        heartbeat: async () => {
          if (released) return;
          try {
            const t = Date.now();
            for (const key of keys) {
              await redis.zadd(key, t, member);
              await redis.pexpire(key, SSE_CONNECTION_TTL_MS);
            }
          } catch (err) {
            logRedisFailure(err, "heartbeat");
          }
        },
        release: async () => {
          if (released) return;
          released = true;
          state().local.delete(connId);
          try {
            for (const key of keys) await redis.zrem(key, member);
          } catch (err) {
            logRedisFailure(err, "release");
          }
        },
      },
    };
  } catch (err) {
    logRedisFailure(err, "acquire");
    return { ok: true, slot: noopSlot(connId) };
  }
}

/** Só testes: fecha clientes e zera o estado do processo. */
export function __resetSseConnectionLimitForTests(): void {
  const s = globalForLimit.sseConnectionLimit;
  if (s) {
    s.cmd?.disconnect();
    s.sub?.disconnect();
  }
  globalForLimit.sseConnectionLimit = undefined;
}
