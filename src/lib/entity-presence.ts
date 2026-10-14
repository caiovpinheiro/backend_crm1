import type { Redis as IORedisClient } from "ioredis";

import {
  getCacheClient,
  noteFailure,
  noteSuccess,
} from "@/lib/cache/redis-client";
import { presenceViewerTtlMs } from "@/lib/presence-beat-config";
import { publishEntityViewers } from "@/lib/realtime-events";

/**
 * Presença efêmera "quem está vendo" (estilo Kommo): quais usuários têm uma
 * entidade aberta (ex.: um deal). O front manda heartbeats; quando um viewer
 * entra/sai/expira, fazemos broadcast do evento SSE `entity_viewers` para a
 * org — os demais que estiverem na mesma entidade atualizam a pilha de
 * avatares.
 *
 * ## Onde mora (E3 / 1.5 — pré-requisito de 2 réplicas da API)
 *
 * No Redis do cache, um hash por entidade:
 *
 *   presence:viewers:<org>:<tipo>:<id>   campo = userId, valor = JSON do viewer
 *
 * - entrar/renovar = `HSET` + `PEXPIRE` (TTL do viewer) na mesma transação,
 *   que também lê o valor anterior (para saber se é ENTRADA) e o hash todo;
 * - sair = `HDEL`;
 * - leitura = `HGETALL` filtrando por `lastSeen` (campo vencido que ainda não
 *   foi varrido não aparece).
 * O hash inteiro some sozinho TTL depois do último heartbeat da sala.
 *
 * Com 2 réplicas o heartbeat cai em qualquer uma e as duas enxergam a mesma
 * sala. O broadcast continua pelo `sseBus` (que já atravessa réplicas via
 * Redis): só quem efetivamente mudou a sala publica — `HSET` que criou o
 * campo, `HDEL` que apagou, varredura que apagou (compare-and-delete).
 *
 * A varredura de expiração roda em cada processo, mas só sobre as salas em
 * que ESTE processo recebeu heartbeat (sem SCAN). Se o único processo que
 * conhecia uma sala cair, ninguém publica a expiração; os outros viewers
 * corrigem a pilha na resposta da própria batida (≤ 60 s), que já vem
 * filtrada por `lastSeen`.
 *
 * ## Sem Redis
 *
 * Sem `REDIS_URL`, circuit aberto ou comando que falhou: cai no `Map` do
 * processo (comportamento anterior — correto com 1 réplica).
 */

export type EntityViewer = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** epoch ms do último heartbeat — usado para expirar por TTL. */
  lastSeen: number;
};

/**
 * Viewer expira depois de `TTL_MS` sem batida. O cliente novo manda UMA
 * batida por navegador (`POST /api/presence/beat`, aba líder, a cada
 * `PRESENCE_BEAT_INTERVAL_MS` = 60 s) com as entidades abertas em todas as
 * abas; o servidor aceita no máximo 1 por usuário a cada 30 s. TTL = 2,5 ×
 * intervalo (150 s com 60 s): uma batida perdida ou atrasada (aba líder em
 * segundo plano, timers estrangulados) não derruba o avatar.
 *
 * Consequência aceita: quem fecha o navegador sem a batida seguinte some da
 * pilha em até ~150 s (fechar só uma aba remove na batida seguinte, ≤ 60 s,
 * porque a entidade sai da lista).
 */
export const ENTITY_PRESENCE_TTL_MS = presenceViewerTtlMs();
const TTL_MS = ENTITY_PRESENCE_TTL_MS;
const REAP_MS = 10_000; // varredura de expiração

const REDIS_KEY_PREFIX = "presence:viewers:";

/** Apaga o campo só se o valor ainda é o que a varredura leu. */
const HDEL_IF_EQUAL_SCRIPT = `-- crm:presence-hdel-if-equal
if redis.call("hget", KEYS[1], ARGV[1]) == ARGV[2] then
  return redis.call("hdel", KEYS[1], ARGV[1])
else
  return 0
end`;

type RoomMeta = { orgId: string; entityType: string; entityId: string };
type PresenceArgs = RoomMeta & { userId: string };

export function entityPresenceRedisKey(
  orgId: string,
  entityType: string,
  entityId: string,
): string {
  return `${REDIS_KEY_PREFIX}${orgId}:${entityType}:${entityId}`;
}

function roomKey(orgId: string, entityType: string, entityId: string): string {
  return `${orgId}::${entityType}::${entityId}`;
}

function sortViewers(list: EntityViewer[]): EntityViewer[] {
  return list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function isLive(v: EntityViewer, now: number): boolean {
  return now - v.lastSeen <= TTL_MS;
}

function parseViewer(raw: unknown): EntityViewer | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<EntityViewer>;
    if (typeof v.userId !== "string" || typeof v.lastSeen !== "number") return null;
    return {
      userId: v.userId,
      name: typeof v.name === "string" ? v.name : "Usuário",
      avatarUrl: typeof v.avatarUrl === "string" ? v.avatarUrl : null,
      lastSeen: v.lastSeen,
    };
  } catch {
    return null;
  }
}

/** Resposta do `HGETALL` (objeto no ioredis; lista plana por garantia). */
function hashEntries(reply: unknown): Array<[string, string]> {
  if (Array.isArray(reply)) {
    const out: Array<[string, string]> = [];
    for (let i = 0; i + 1 < reply.length; i += 2) {
      out.push([String(reply[i]), String(reply[i + 1])]);
    }
    return out;
  }
  if (reply && typeof reply === "object") {
    return Object.entries(reply as Record<string, string>);
  }
  return [];
}

function liveFromHash(reply: unknown, now: number): EntityViewer[] {
  const out: EntityViewer[] = [];
  for (const [, raw] of hashEntries(reply)) {
    const v = parseViewer(raw);
    if (v && isLive(v, now)) out.push(v);
  }
  return sortViewers(out);
}

function broadcastList(meta: RoomMeta, viewers: EntityViewer[]): void {
  publishEntityViewers({
    organizationId: meta.orgId,
    entityType: meta.entityType,
    entityId: meta.entityId,
    viewers,
  });
}

function execReplies(replies: Array<[Error | null, unknown]> | null): unknown[] {
  if (!replies) throw new Error("[presence] MULTI sem resposta");
  return replies.map(([err, value]) => {
    if (err) throw err;
    return value;
  });
}

// ── Salas conhecidas por este processo (varredura de expiração) ──────────

/** Salas no Redis em que este processo recebeu heartbeat. */
const redisRooms = new Map<string, RoomMeta>();

// ── Fallback em memória (sem Redis) ──────────────────────────────────────

// key -> Map<userId, EntityViewer>
const rooms = new Map<string, Map<string, EntityViewer>>();
// key -> metadados p/ o reaper conseguir fazer broadcast
const keyMeta = new Map<string, RoomMeta>();

function publicList(room: Map<string, EntityViewer> | undefined): EntityViewer[] {
  if (!room) return [];
  return sortViewers([...room.values()]);
}

function broadcastMemory(key: string): void {
  const meta = keyMeta.get(key);
  if (!meta) return;
  broadcastList(meta, publicList(rooms.get(key)));
}

function touchMemory(p: PresenceArgs & { name: string; avatarUrl: string | null }): EntityViewer[] {
  const key = roomKey(p.orgId, p.entityType, p.entityId);
  let room = rooms.get(key);
  if (!room) {
    room = new Map();
    rooms.set(key, room);
    keyMeta.set(key, { orgId: p.orgId, entityType: p.entityType, entityId: p.entityId });
  }
  const isNew = !room.has(p.userId);
  room.set(p.userId, {
    userId: p.userId,
    name: p.name,
    avatarUrl: p.avatarUrl,
    lastSeen: Date.now(),
  });
  // Só rebroadcast quando alguém ENTRA (heartbeat de quem já está só renova
  // o lastSeen — não precisa espalhar de novo a cada 25s).
  if (isNew) broadcastMemory(key);
  return publicList(room);
}

function removeMemory(p: PresenceArgs): EntityViewer[] {
  const key = roomKey(p.orgId, p.entityType, p.entityId);
  const room = rooms.get(key);
  if (!room || !room.has(p.userId)) return publicList(room);
  room.delete(p.userId);
  broadcastMemory(key);
  if (room.size === 0) {
    rooms.delete(key);
    keyMeta.delete(key);
  }
  return publicList(room);
}

function reapMemory(now: number): void {
  for (const [key, room] of rooms) {
    let changed = false;
    for (const [uid, v] of room) {
      if (!isLive(v, now)) {
        room.delete(uid);
        changed = true;
      }
    }
    if (changed) broadcastMemory(key); // room pode ter ficado vazia → viewers: []
    if (room.size === 0) {
      rooms.delete(key);
      keyMeta.delete(key);
    }
  }
}

// ── Redis ────────────────────────────────────────────────────────────────

async function touchRedis(
  client: IORedisClient,
  p: PresenceArgs & { name: string; avatarUrl: string | null },
): Promise<EntityViewer[]> {
  const now = Date.now();
  const key = entityPresenceRedisKey(p.orgId, p.entityType, p.entityId);
  const viewer: EntityViewer = {
    userId: p.userId,
    name: p.name,
    avatarUrl: p.avatarUrl,
    lastSeen: now,
  };
  const [previous, , , all] = execReplies(
    await client
      .multi()
      .hget(key, p.userId)
      .hset(key, p.userId, JSON.stringify(viewer))
      .pexpire(key, TTL_MS)
      .hgetall(key)
      .exec(),
  );
  const meta = { orgId: p.orgId, entityType: p.entityType, entityId: p.entityId };
  redisRooms.set(key, meta);
  const prev = parseViewer(previous);
  const viewers = liveFromHash(all, now);
  // ENTRADA = campo não existia ou estava vencido (a outra réplica pode já
  // ter publicado a saída por expiração).
  if (!prev || !isLive(prev, now)) broadcastList(meta, viewers);
  return viewers;
}

async function removeRedis(
  client: IORedisClient,
  p: PresenceArgs,
): Promise<EntityViewer[]> {
  const now = Date.now();
  const key = entityPresenceRedisKey(p.orgId, p.entityType, p.entityId);
  const [removed, all] = execReplies(
    await client.multi().hdel(key, p.userId).hgetall(key).exec(),
  );
  const viewers = liveFromHash(all, now);
  const meta = { orgId: p.orgId, entityType: p.entityType, entityId: p.entityId };
  if (Number(removed) > 0) broadcastList(meta, viewers);
  if (hashEntries(all).length === 0) redisRooms.delete(key);
  return viewers;
}

async function reapRedisRoom(
  client: IORedisClient,
  key: string,
  meta: RoomMeta,
  now: number,
): Promise<void> {
  const entries = hashEntries(await client.hgetall(key));
  if (entries.length === 0) {
    redisRooms.delete(key);
    return;
  }
  let removed = 0;
  for (const [field, raw] of entries) {
    const v = parseViewer(raw);
    if (v && isLive(v, now)) continue;
    // Compare-and-delete: um heartbeat que chegou depois da leitura (em
    // qualquer réplica) troca o valor e o campo fica.
    removed += Number(await client.eval(HDEL_IF_EQUAL_SCRIPT, 1, key, field, raw));
  }
  if (removed === 0) return;
  // Só quem apagou publica — a outra réplica que varrer a mesma sala acha
  // o campo já removido e fica quieta.
  const after = await client.hgetall(key);
  if (hashEntries(after).length === 0) redisRooms.delete(key);
  broadcastList(meta, liveFromHash(after, now));
}

/** Uma passada da varredura de expiração (exportada para testes). */
export async function reapEntityViewers(now = Date.now()): Promise<void> {
  reapMemory(now);
  if (redisRooms.size === 0) return;
  const client = getCacheClient();
  if (!client) return;
  try {
    for (const [key, meta] of [...redisRooms]) {
      await reapRedisRoom(client, key, meta, now);
    }
    noteSuccess();
  } catch (err) {
    noteFailure(err, "presence:reap", "presence");
  }
}

// ── API ──────────────────────────────────────────────────────────────────

/** Registra/renova um viewer (broadcast só na entrada). Retorna a lista atual. */
export async function touchViewer(p: {
  orgId: string;
  entityType: string;
  entityId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
}): Promise<EntityViewer[]> {
  const client = getCacheClient();
  if (client) {
    try {
      const viewers = await touchRedis(client, p);
      noteSuccess();
      return viewers;
    } catch (err) {
      noteFailure(err, "presence:touch", "presence");
    }
  }
  return touchMemory(p);
}

/** Remove um viewer (saída explícita: unmount / aba fechada) e faz broadcast. */
export async function removeViewer(p: {
  orgId: string;
  entityType: string;
  entityId: string;
  userId: string;
}): Promise<EntityViewer[]> {
  const client = getCacheClient();
  if (client) {
    try {
      const viewers = await removeRedis(client, p);
      noteSuccess();
      // Pode ter entrado pelo fallback enquanto o Redis estava fora.
      removeMemory(p);
      return viewers;
    } catch (err) {
      noteFailure(err, "presence:remove", "presence");
    }
  }
  return removeMemory(p);
}

/** Lista atual de viewers da entidade, sem escrever nada. */
export async function listViewers(p: RoomMeta): Promise<EntityViewer[]> {
  const now = Date.now();
  const client = getCacheClient();
  if (client) {
    try {
      const all = await client.hgetall(entityPresenceRedisKey(p.orgId, p.entityType, p.entityId));
      noteSuccess();
      return liveFromHash(all, now);
    } catch (err) {
      noteFailure(err, "presence:list", "presence");
    }
  }
  const room = rooms.get(roomKey(p.orgId, p.entityType, p.entityId));
  return publicList(room).filter((v) => isLive(v, now));
}

// ── Batida: várias entidades numa ida ao Redis ───────────────────────────
//
// `POST /api/presence/beat` renova o usuário em TODAS as entidades abertas
// no navegador e o tira das que saíram da lista — num único MULTI (1 ida),
// em vez de 1 heartbeat por entidade. A leitura da batida descartada pelo
// limite usa um pipeline de HGETALL (1 ida, sem escrita).

export type EntityRef = { entityType: string; entityId: string };

/** Chave da entidade na resposta da batida: `"<tipo>:<id>"`. */
export function entityRefKey(ref: EntityRef): string {
  return `${ref.entityType}:${ref.entityId}`;
}

export type ViewerBeatInput = {
  orgId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** Entidades abertas agora (renova o viewer). */
  touch: EntityRef[];
  /** Entidades que saíram da lista desde a última batida (remove o viewer). */
  remove: EntityRef[];
  /** `SET key value PX ttlMs` no mesmo MULTI (lista da batida). */
  alsoSet?: { key: string; value: string; ttlMs: number };
};

async function beatRedis(
  client: IORedisClient,
  p: ViewerBeatInput,
): Promise<Record<string, EntityViewer[]>> {
  const now = Date.now();
  const raw: EntityViewer = {
    userId: p.userId,
    name: p.name,
    avatarUrl: p.avatarUrl,
    lastSeen: now,
  };
  const json = JSON.stringify(raw);
  const multi = client.multi();
  for (const ref of p.touch) {
    const key = entityPresenceRedisKey(p.orgId, ref.entityType, ref.entityId);
    multi.hget(key, p.userId).hset(key, p.userId, json).pexpire(key, TTL_MS).hgetall(key);
  }
  for (const ref of p.remove) {
    const key = entityPresenceRedisKey(p.orgId, ref.entityType, ref.entityId);
    multi.hdel(key, p.userId).hgetall(key);
  }
  if (p.alsoSet) multi.set(p.alsoSet.key, p.alsoSet.value, "PX", p.alsoSet.ttlMs);
  const replies = execReplies(await multi.exec());

  const out: Record<string, EntityViewer[]> = {};
  let i = 0;
  for (const ref of p.touch) {
    const previous = replies[i];
    const all = replies[i + 3];
    i += 4;
    const key = entityPresenceRedisKey(p.orgId, ref.entityType, ref.entityId);
    const meta = { orgId: p.orgId, entityType: ref.entityType, entityId: ref.entityId };
    redisRooms.set(key, meta);
    const viewers = liveFromHash(all, now);
    const prev = parseViewer(previous);
    if (!prev || !isLive(prev, now)) broadcastList(meta, viewers);
    out[entityRefKey(ref)] = viewers;
  }
  for (const ref of p.remove) {
    const removed = replies[i];
    const all = replies[i + 1];
    i += 2;
    const key = entityPresenceRedisKey(p.orgId, ref.entityType, ref.entityId);
    const meta = { orgId: p.orgId, entityType: ref.entityType, entityId: ref.entityId };
    if (Number(removed) > 0) broadcastList(meta, liveFromHash(all, now));
    if (hashEntries(all).length === 0) redisRooms.delete(key);
  }
  return out;
}

function beatMemory(p: ViewerBeatInput): Record<string, EntityViewer[]> {
  const out: Record<string, EntityViewer[]> = {};
  for (const ref of p.touch) {
    out[entityRefKey(ref)] = touchMemory({ ...p, ...ref });
  }
  for (const ref of p.remove) removeMemory({ orgId: p.orgId, userId: p.userId, ...ref });
  return out;
}

/**
 * Batida do usuário: renova o viewer em `touch`, remove de `remove` (com
 * broadcast só de quem entrou/saiu) e grava `alsoSet` — tudo num MULTI.
 * Devolve os viewers vivos de cada entidade de `touch` (`"<tipo>:<id>"`).
 * Redis fora: `Map` do processo.
 */
export async function beatViewers(p: ViewerBeatInput): Promise<Record<string, EntityViewer[]>> {
  if (p.touch.length === 0 && p.remove.length === 0 && !p.alsoSet) return {};
  const client = getCacheClient();
  if (client) {
    try {
      const out = await beatRedis(client, p);
      noteSuccess();
      // Pode ter entrado pelo fallback enquanto o Redis estava fora.
      for (const ref of p.remove) removeMemory({ orgId: p.orgId, userId: p.userId, ...ref });
      return out;
    } catch (err) {
      noteFailure(err, "presence:beat", "presence");
    }
  }
  return beatMemory(p);
}

/** Viewers vivos de várias entidades, sem escrever (1 pipeline de HGETALL). */
export async function listViewersMany(
  orgId: string,
  refs: EntityRef[],
): Promise<Record<string, EntityViewer[]>> {
  const out: Record<string, EntityViewer[]> = {};
  if (refs.length === 0) return out;
  const now = Date.now();
  const client = getCacheClient();
  if (client) {
    try {
      const pipe = client.pipeline();
      for (const ref of refs) pipe.hgetall(entityPresenceRedisKey(orgId, ref.entityType, ref.entityId));
      const replies = execReplies(await pipe.exec());
      noteSuccess();
      refs.forEach((ref, idx) => {
        out[entityRefKey(ref)] = liveFromHash(replies[idx], now);
      });
      return out;
    } catch (err) {
      noteFailure(err, "presence:list-many", "presence");
    }
  }
  for (const ref of refs) {
    const room = rooms.get(roomKey(orgId, ref.entityType, ref.entityId));
    out[entityRefKey(ref)] = publicList(room).filter((v) => isLive(v, now));
  }
  return out;
}

/** Só para testes: esquece salas locais (memória e conhecidas no Redis). */
export function resetEntityPresenceForTests(): void {
  rooms.clear();
  keyMeta.clear();
  redisRooms.clear();
}

// ── Reaper: expira viewers inativos e faz broadcast das salas que mudaram ──
let reaper: ReturnType<typeof setInterval> | null = null;
let reaping = false;
function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    if (reaping) return;
    reaping = true;
    void reapEntityViewers().finally(() => {
      reaping = false;
    });
  }, REAP_MS);
  // Não segura o event loop no shutdown.
  if (typeof reaper.unref === "function") reaper.unref();
}
ensureReaper();
