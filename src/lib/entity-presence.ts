import type { Redis as IORedisClient } from "ioredis";

import {
  getCacheClient,
  noteFailure,
  noteSuccess,
} from "@/lib/cache/redis-client";
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
 * corrigem a pilha na resposta do próprio heartbeat (≤ 25 s), que já vem
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
 * Viewer expira depois de `TTL_MS` sem heartbeat. O cliente bate a cada
 * 25s, mas quem envia é só a aba LÍDER do navegador (eleita por Web Locks;
 * `src/hooks/use-sse.ts` / `presence-sync.ts` no frontend), agregando as
 * entidades abertas em todas as abas. Quando o líder fecha, a aba seguinte
 * assume em < 2s — mas se o líder estava em segundo plano (timers
 * estrangulados) o intervalo entre dois heartbeats pode passar de 60s.
 * 90s cobre esse gap sem que o viewer suma e volte (30s derrubava). Sobe
 * para 90s junto com a eleição de líder (MA-1/MA-2, set/26).
 */
export const ENTITY_PRESENCE_TTL_MS = 90_000;
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
