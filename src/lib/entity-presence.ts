import { sseBus } from "@/lib/sse-bus";

/**
 * Presença efêmera "quem está vendo" (estilo Kommo). Registra, EM MEMÓRIA,
 * quais usuários têm uma entidade aberta (ex.: um deal). O front manda
 * heartbeats; quando um viewer entra/sai/expira, fazemos broadcast do evento
 * SSE `entity_viewers` para a org — os demais que estiverem na mesma entidade
 * atualizam a pilha de avatares.
 *
 * Efêmero de propósito: reseta em deploy/restart (presença é transitória).
 * Single-container: `Map` em memória basta. Se um dia rodar múltiplas
 * instâncias, trocar por Redis pub/sub (o SSE bus já suporta Redis).
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

type RoomMeta = { orgId: string; entityType: string; entityId: string };

// key -> Map<userId, EntityViewer>
const rooms = new Map<string, Map<string, EntityViewer>>();
// key -> metadados p/ o reaper conseguir fazer broadcast
const keyMeta = new Map<string, RoomMeta>();

function roomKey(orgId: string, entityType: string, entityId: string): string {
  return `${orgId}::${entityType}::${entityId}`;
}

function publicList(room: Map<string, EntityViewer> | undefined): EntityViewer[] {
  if (!room) return [];
  return [...room.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function broadcast(key: string): void {
  const meta = keyMeta.get(key);
  if (!meta) return;
  sseBus.publish("entity_viewers", {
    organizationId: meta.orgId,
    entityType: meta.entityType,
    entityId: meta.entityId,
    viewers: publicList(rooms.get(key)),
  });
}

/** Registra/renova um viewer e faz broadcast. Retorna a lista atual. */
export function touchViewer(p: {
  orgId: string;
  entityType: string;
  entityId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
}): EntityViewer[] {
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
  // o lastSeen — não precisa espalhar de novo a cada 15s).
  if (isNew) broadcast(key);
  return publicList(room);
}

/** Remove um viewer (saída explícita: unmount / aba fechada) e faz broadcast. */
export function removeViewer(p: {
  orgId: string;
  entityType: string;
  entityId: string;
  userId: string;
}): EntityViewer[] {
  const key = roomKey(p.orgId, p.entityType, p.entityId);
  const room = rooms.get(key);
  if (!room || !room.has(p.userId)) return publicList(room);
  room.delete(p.userId);
  broadcast(key);
  if (room.size === 0) {
    rooms.delete(key);
    keyMeta.delete(key);
  }
  return publicList(room);
}

// ── Reaper: expira viewers inativos e faz broadcast das salas que mudaram ──
let reaper: ReturnType<typeof setInterval> | null = null;
function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [key, room] of rooms) {
      let changed = false;
      for (const [uid, v] of room) {
        if (now - v.lastSeen > TTL_MS) {
          room.delete(uid);
          changed = true;
        }
      }
      if (changed) broadcast(key); // room pode ter ficado vazia → viewers: []
      if (room.size === 0) {
        rooms.delete(key);
        keyMeta.delete(key);
      }
    }
  }, REAP_MS);
  // Não segura o event loop no shutdown.
  if (typeof reaper.unref === "function") reaper.unref();
}
ensureReaper();
