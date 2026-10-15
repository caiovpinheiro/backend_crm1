/**
 * Limite da BATIDA de presença: no máximo 1 batida aceita (que escreve) por
 * USUÁRIO a cada `PRESENCE_BEAT_MIN_INTERVAL_MS` (30 s), somando abas,
 * navegadores e as três rotas que gravam presença:
 *
 * - `POST /api/presence/beat` (nova: presença do sistema + viewers de todas
 *   as entidades abertas, numa chamada);
 * - `POST /api/agents/me/ping` e `POST /api/presence/heartbeat` (antigas,
 *   mantidas para o frontend da main durante a transição).
 *
 * Quem excede NÃO recebe 429: a rota responde 200 com `deduped: true` e o
 * estado atual lido do Redis, sem escrever nada (um 429 viraria erro no
 * console do cliente e retentativa). Com a cadência recomendada (60 s, aba
 * líder) a org de ~20 atendentes fica em ~20 escritas/min; o teto absoluto
 * é 2 por usuário por minuto.
 *
 * No-op (gate de carga, item 3): ANTES do limite, a batida com a MESMA
 * lista de entidades (normalizada e ordenada) da última batida GRAVADA do
 * usuário, há menos de `PRESENCE_BEAT_NOOP_WINDOW_MS` (45 s), não escreve
 * nem lê mais nada — a rota responde 204 sem corpo. Ping antigo: no-op com
 * qualquer batida gravada na janela (a presença do sistema está fresca);
 * heartbeat antigo: no-op se a entidade estava na lista gravada. A janela
 * conta da última ESCRITA (não da última chamada): duplicatas seguidas nunca
 * adiam a escrita seguinte além da cadência, e o "CRM aberto" (300 s) e os
 * viewers (150 s) não envelhecem.
 *
 * Redis: um script Lua por batida — confere o no-op
 * (`presence:beat-noop:<userId>` = assinatura da lista gravada), depois
 * `SET presence:beat-gate:<userId> 1 PX <limite> NX`; quando ganha, grava a
 * assinatura nova e devolve a lista de entidades da batida anterior
 * (`presence:beat-entities:<org>:<user>[:<clientId>]`) — uma ida só. Vale
 * entre réplicas. Sem Redis: mapas do processo (cada réplica limita por si).
 * Redis com erro: aceita (fail-open; presença é best-effort).
 */
import { getCacheClient, noteFailure, noteSuccess } from "@/lib/cache/redis-client";
import type { EntityRef } from "@/lib/entity-presence";
import {
  presenceBeatMinIntervalMs,
  presenceBeatNoopWindowMs,
} from "@/lib/presence-beat-config";

const GATE_PREFIX = "presence:beat-gate:";
const NOOP_PREFIX = "presence:beat-noop:";
const LIST_PREFIX = "presence:beat-entities:";
const MEMORY_MAX_KEYS = 10_000;

/** Entidades com "quem está vendo". Tipo fora da lista é ignorado. */
export const PRESENCE_ENTITY_TYPES: ReadonlySet<string> = new Set(["deal", "conversation"]);
/** Máximo de entidades por batida (as excedentes são ignoradas). */
export const PRESENCE_BEAT_MAX_ENTITIES = 20;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function presenceBeatGateKey(userId: string): string {
  return `${GATE_PREFIX}${userId}`;
}

/**
 * Lista de entidades da última batida aceita. Com `clientId` (id estável do
 * navegador), a remoção das entidades que saíram da lista vale só para o
 * mesmo navegador; sem ele, por usuário.
 */
export function presenceBeatListKey(orgId: string, userId: string, clientId: string | null): string {
  return `${LIST_PREFIX}${orgId}:${userId}${clientId ? `:${clientId}` : ""}`;
}

/** Assinatura da última batida GRAVADA do usuário (no-op). */
export function presenceBeatNoopKey(userId: string): string {
  return `${NOOP_PREFIX}${userId}`;
}

/**
 * Assinatura de uma lista de entidades: chaves `tipo:id` sem repetição e
 * ORDENADAS (a ordem em que o navegador manda não importa).
 */
export function entityListSignature(refs: EntityRef[]): string {
  const keys = [...new Set(refs.map((r) => `${r.entityType}:${r.entityId}`))].sort();
  return JSON.stringify(keys);
}

/**
 * Como conferir o no-op contra a assinatura gravada:
 * - `same`: a mesma lista (`/presence/beat`);
 * - `any`: qualquer batida gravada na janela (`/agents/me/ping`, que não
 *   tem entidades);
 * - `contains`: a entidade estava na lista (`/presence/heartbeat`).
 */
export type PresenceBeatNoopCheck =
  | { mode: "same"; signature: string }
  | { mode: "any" }
  | { mode: "contains"; entityKey: string };

export type PresenceBeatGate =
  | { accepted: true; previous: EntityRef[] | null }
  | { accepted: false; noop: true }
  | { accepted: false; noop?: false; retryAfterMs: number };

/**
 * KEYS: gate, no-op, lista anterior (opcional). ARGV: limite (ms), modo do
 * no-op ("" = não confere), alvo, assinatura a gravar ("" = não grava),
 * janela do no-op (ms). Retorno: {2} no-op; {1, lista anterior} aceita;
 * {0, PTTL} deduplicada.
 */
const GATE_SCRIPT = `-- crm:presence-beat-gate
local mode = ARGV[2]
if mode ~= "" then
  local cur = redis.call("GET", KEYS[2])
  if cur then
    if mode == "any" or (mode == "same" and cur == ARGV[3]) or (mode == "contains" and string.find(cur, ARGV[3], 1, true)) then
      return {2, ""}
    end
  end
end
if redis.call("SET", KEYS[1], "1", "PX", ARGV[1], "NX") then
  if ARGV[4] ~= "" and tonumber(ARGV[5]) > 0 then
    redis.call("SET", KEYS[2], ARGV[4], "PX", ARGV[5])
  end
  local l = ""
  if KEYS[3] then
    l = redis.call("GET", KEYS[3])
    if not l then l = "" end
  end
  return {1, l}
end
return {0, tostring(redis.call("PTTL", KEYS[1]))}`;

/** `contains`: a chave `tipo:id` entre aspas, como aparece no JSON da assinatura. */
function noopArgs(check: PresenceBeatNoopCheck | null): { mode: string; target: string } {
  if (!check) return { mode: "", target: "" };
  if (check.mode === "same") return { mode: "same", target: check.signature };
  if (check.mode === "contains") return { mode: "contains", target: JSON.stringify(check.entityKey) };
  return { mode: "any", target: "" };
}

function isNoop(check: PresenceBeatNoopCheck | null, current: string | null): boolean {
  if (!check || current === null) return false;
  if (check.mode === "any") return true;
  if (check.mode === "same") return current === check.signature;
  return current.includes(JSON.stringify(check.entityKey));
}

/** Sem Redis: limite, no-op e lista por processo. */
const memoryGate = new Map<string, number>();
const memoryNoop = new Map<string, { value: string; expiresAt: number }>();
const memoryLists = new Map<string, { value: string; expiresAt: number }>();

function pruneIfFull<V>(map: Map<string, V>, isExpired: (v: V) => boolean): void {
  if (map.size < MEMORY_MAX_KEYS) return;
  for (const [k, v] of map) if (isExpired(v)) map.delete(k);
  if (map.size >= MEMORY_MAX_KEYS) map.clear();
}

function parseList(raw: unknown): EntityRef[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parseEntityKeys(parsed);
  } catch {
    return null;
  }
}

/** `["deal:d1", …]` → refs válidas. */
function parseEntityKeys(list: unknown[]): EntityRef[] {
  const out: EntityRef[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const idx = item.indexOf(":");
    if (idx <= 0) continue;
    const ref = { entityType: item.slice(0, idx), entityId: item.slice(idx + 1) };
    if (PRESENCE_ENTITY_TYPES.has(ref.entityType) && ENTITY_ID_RE.test(ref.entityId)) out.push(ref);
  }
  return out;
}

type NoopParams = { check: PresenceBeatNoopCheck | null; write: string | null; windowMs: number };

function claimMemory(
  userId: string,
  listKey: string | null,
  ms: number,
  noop: NoopParams,
): PresenceBeatGate {
  const now = Date.now();
  const noopKey = presenceBeatNoopKey(userId);
  const sig = memoryNoop.get(noopKey);
  if (isNoop(noop.check, sig && sig.expiresAt > now ? sig.value : null)) {
    return { accepted: false, noop: true };
  }
  const key = presenceBeatGateKey(userId);
  const exp = memoryGate.get(key);
  if (exp !== undefined && exp > now) return { accepted: false, retryAfterMs: exp - now };
  pruneIfFull(memoryGate, (e) => e <= now);
  memoryGate.set(key, now + ms);
  if (noop.write !== null && noop.windowMs > 0) {
    pruneIfFull(memoryNoop, (v) => v.expiresAt <= now);
    memoryNoop.set(noopKey, { value: noop.write, expiresAt: now + noop.windowMs });
  }
  if (!listKey) return { accepted: true, previous: null };
  const hit = memoryLists.get(listKey);
  return { accepted: true, previous: hit && hit.expiresAt > now ? parseList(hit.value) : null };
}

/**
 * Tenta gastar a batida do usuário. `listKey` (só `/beat`) devolve junto a
 * lista da batida anterior. `noop` confere, ANTES do limite, se a batida
 * repete a última gravada (→ `noop: true`: a rota responde 204 sem
 * escrever); `writeSignature` é a assinatura gravada se a batida for aceita
 * (`null` = não grava). `accepted: false` sem `noop` → a rota responde
 * deduplicado (200).
 */
export async function claimPresenceBeat(params: {
  userId: string;
  listKey?: string | null;
  noop?: PresenceBeatNoopCheck | null;
  writeSignature?: string | null;
}): Promise<PresenceBeatGate> {
  const ms = presenceBeatMinIntervalMs();
  const windowMs = presenceBeatNoopWindowMs();
  const listKey = params.listKey ?? null;
  const check = windowMs > 0 ? (params.noop ?? null) : null;
  const write = windowMs > 0 ? (params.writeSignature ?? null) : null;
  const client = getCacheClient();
  if (!client) return claimMemory(params.userId, listKey, ms, { check, write, windowMs });
  const gateKey = presenceBeatGateKey(params.userId);
  const noopKey = presenceBeatNoopKey(params.userId);
  const { mode, target } = noopArgs(check);
  const args = [String(ms), mode, target, write ?? "", String(windowMs)];
  try {
    const reply = listKey
      ? await client.eval(GATE_SCRIPT, 3, gateKey, noopKey, listKey, ...args)
      : await client.eval(GATE_SCRIPT, 2, gateKey, noopKey, ...args);
    noteSuccess();
    const [won, payload] = Array.isArray(reply) ? reply : [1, ""];
    if (Number(won) === 2) return { accepted: false, noop: true };
    if (Number(won) === 1) return { accepted: true, previous: parseList(payload) };
    const pttl = Number(payload);
    // -2: a chave venceu entre o SET e o PTTL — a janela já passou.
    if (pttl === -2) return { accepted: true, previous: null };
    return { accepted: false, retryAfterMs: pttl > 0 ? Math.min(pttl, ms) : ms };
  } catch (err) {
    noteFailure(err, gateKey, "presence-beat");
    return { accepted: true, previous: null };
  }
}

/** Valor gravado na lista da batida (no MULTI da escrita). */
export function serializeEntityList(refs: EntityRef[]): string {
  return JSON.stringify(refs.map((r) => `${r.entityType}:${r.entityId}`));
}

/** Grava a lista no fallback em memória (Redis ausente). */
export function rememberEntityListInMemory(listKey: string, value: string, ttlMs: number): void {
  const now = Date.now();
  pruneIfFull(memoryLists, (v) => v.expiresAt <= now);
  memoryLists.set(listKey, { value, expiresAt: now + ttlMs });
}

/**
 * `entities` do corpo da batida: `[{ type, id }]` (aceita também
 * `entityType`/`entityId`). Ignora tipo fora de `PRESENCE_ENTITY_TYPES`, id
 * inválido e repetidos; corta em `PRESENCE_BEAT_MAX_ENTITIES`.
 */
export function parseBeatEntities(raw: unknown): EntityRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: EntityRef[] = [];
  for (const item of raw) {
    if (out.length >= PRESENCE_BEAT_MAX_ENTITIES) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const entityType = String(o.type ?? o.entityType ?? "");
    const entityId = String(o.id ?? o.entityId ?? "");
    if (!PRESENCE_ENTITY_TYPES.has(entityType) || !ENTITY_ID_RE.test(entityId)) continue;
    const key = `${entityType}:${entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entityType, entityId });
  }
  return out;
}

/** `clientId` do corpo (id estável do navegador); inválido = ausente. */
export function parseClientId(raw: unknown): string | null {
  return typeof raw === "string" && CLIENT_ID_RE.test(raw.trim()) ? raw.trim() : null;
}

/** Só para testes. */
export function resetPresenceBeatForTests(): void {
  memoryGate.clear();
  memoryNoop.clear();
  memoryLists.clear();
}
