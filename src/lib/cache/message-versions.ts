/**
 * Versão e diário de mudanças das mensagens de cada conversa (gate de carga
 * de produção, meta 6/7 — `GET /api/conversations/:id/messages`).
 *
 * ## O que guarda (Redis, por conversa)
 *
 * - `cache:v:msgs:<org>:<conversa>` — número da versão. Começa em
 *   `Date.now()` (como `versions.ts`: chave perdida nunca repete um número
 *   antigo) e sobe 1 a cada mudança.
 * - `cache:msgs:log:<org>:<conversa>` — ZSET com uma entrada por mudança,
 *   `score` = versão, membro `<versão>:<tipo>:<ts36>:<ids>`. Guarda as
 *   últimas `LOG_MAX` entradas. É o que permite responder "o que mudou
 *   desde a versão N" (`?after=<cursor>`) sem coluna `updatedAt` em
 *   `messages`.
 *
 * Bump e entrada no diário saem no MESMO script Lua: quem lê a versão N
 * sempre acha no diário as entradas até N. Org na chave: o mesmo id de
 * conversa em outra org nunca colide.
 *
 * ## Quem chama
 *
 * Todo escritor de `Message` (ver `noteMessageChange`) DEPOIS de gravar
 * (fora da transação): a versão nova só pode aparecer quando o banco já
 * mostra a mudança. Se o bump saísse antes do commit, um leitor guardaria
 * a versão nova com o dado velho.
 *
 * ## Leitura
 *
 * `readMessageTimelineState` lê, num script só (uma ida ao Redis), as
 * versões das conversas da linha do tempo e as famílias da org de que a
 * resposta depende (permissões, usuários, canais, settings). Sem memória
 * local: a outra réplica enxerga o bump na leitura seguinte.
 *
 * ## Redis fora
 *
 * Sem Redis não há versão: a rota responde 200 sem ETag e sem cursor, como
 * antes. Bump que falhou fica pendente no processo e sai como entrada `*`
 * (o cliente refaz a página inteira) no próximo bump/leitura da conversa.
 */
import { createHash } from "node:crypto";

import { getLogger } from "@/lib/logger";

import {
  getCacheClient,
  isCacheRedisDisabled,
  noteFailure,
  noteSuccess,
} from "./redis-client";
import { cacheVersionName, cacheVersionRedisKey } from "./versions";

const log = getLogger("cache/message-versions");

/** `new` mensagem nova · `upd` status/edição/reação/favorito · `del` exclusão · `meta` fixadas/nota fixada. */
export type MessageChangeKind = "new" | "upd" | "del" | "meta";

export const MESSAGES_VERSION_FAMILY = "msgs";
const LOG_KEY_PREFIX = "cache:msgs:log:";
/** Renovado a cada bump. Expirar = cliente refaz a página inteira. */
const TTL_SEC = 7 * 24 * 60 * 60;
/** Entradas guardadas por conversa. Cursor mais velho que isso → página inteira. */
export const MESSAGE_LOG_MAX = 300;
/** Teto de entradas lidas por delta (passou disso, página inteira). */
export const MESSAGE_DELTA_MAX_ENTRIES = 200;
const MAX_IDS_PER_ENTRY = 50;
const MAX_PENDING = 10_000;
/** Id que não cabe no membro (vírgula, espaço, dois-pontos) → entrada `*`. */
const SAFE_ID = /^[^\s,:]{1,200}$/;

export function messageVersionName(orgId: string, conversationId: string): string {
  return cacheVersionName(MESSAGES_VERSION_FAMILY, orgId, conversationId);
}

export function messageVersionKey(orgId: string, conversationId: string): string {
  return cacheVersionRedisKey(messageVersionName(orgId, conversationId));
}

export function messageLogKey(orgId: string, conversationId: string): string {
  return `${LOG_KEY_PREFIX}${orgId}:${conversationId}`;
}

// ── Scripts ────────────────────────────────────────────────────────

/**
 * KEYS: versão, diário. ARGV: semente, ttl, sufixo do membro
 * (`<tipo>:<ts36>:<ids>`), teto do diário, incremento.
 */
export const MSGS_BUMP_SCRIPT = `-- crm:msgs-bump
local seed = ARGV[1]
local ttl = tonumber(ARGV[2])
if redis.call('SET', KEYS[1], seed, 'EX', ttl, 'NX') then
  redis.call('ZADD', KEYS[2], seed, seed .. ':seed')
end
local v = redis.call('INCRBY', KEYS[1], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('ZADD', KEYS[2], v, v .. ':' .. ARGV[3])
redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -(tonumber(ARGV[4]) + 1))
redis.call('EXPIRE', KEYS[2], ttl)
return v`;

/**
 * KEYS: famílias da org (n = ARGV[1]) e depois pares versão/diário por
 * conversa. ARGV: n, semente, ttl, teto de entradas, cursor por conversa
 * (`""` = só a versão). Versão ausente é semeada (como `versions.ts`).
 * Resposta: `{ famílias, {versão, 1ª entrada, entradas > cursor}, … }`.
 */
export const MSGS_STATE_SCRIPT = `-- crm:msgs-state
local nfam = tonumber(ARGV[1])
local seed = ARGV[2]
local ttl = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local fams = {}
for i = 1, nfam do
  fams[i] = redis.call('GET', KEYS[i]) or ''
end
local out = {fams}
local c = 0
for i = nfam + 1, #KEYS, 2 do
  c = c + 1
  local ver = KEYS[i]
  local lg = KEYS[i + 1]
  local cur = redis.call('GET', ver)
  if not cur then
    if redis.call('SET', ver, seed, 'EX', ttl, 'NX') then
      redis.call('ZADD', lg, seed, seed .. ':seed')
      redis.call('EXPIRE', lg, ttl)
    end
    cur = redis.call('GET', ver) or seed
  end
  local cursor = ARGV[4 + c]
  local first = ''
  local items = {}
  if cursor ~= '' and tonumber(cur) > tonumber(cursor) then
    local f = redis.call('ZRANGE', lg, 0, 0)
    first = f[1] or ''
    items = redis.call('ZRANGEBYSCORE', lg, '(' .. cursor, '+inf', 'LIMIT', 0, limit + 1)
  end
  out[#out + 1] = {cur, first, items}
end
return out`;

// ── Bump ───────────────────────────────────────────────────────────

/** Bumps que falharam (Redis fora): saem como `*` no próximo contato. */
const pending = new Set<string>();

function pendingKey(orgId: string, conversationId: string): string {
  return `${orgId}\n${conversationId}`;
}

function memberSuffix(kind: MessageChangeKind | "*", ids: string[]): string {
  const ts = Date.now().toString(36);
  if (kind === "*") return `*:${ts}:`;
  const clean = [...new Set(ids)];
  if (clean.length > MAX_IDS_PER_ENTRY || clean.some((id) => !SAFE_ID.test(id))) {
    return `*:${ts}:`;
  }
  return `${kind}:${ts}:${clean.join(",")}`;
}

async function runBump(
  orgId: string,
  conversationId: string,
  suffix: string,
): Promise<boolean> {
  const client = getCacheClient();
  if (!client) return false;
  const key = messageVersionKey(orgId, conversationId);
  try {
    await client.eval(
      MSGS_BUMP_SCRIPT,
      2,
      key,
      messageLogKey(orgId, conversationId),
      String(Date.now()),
      String(TTL_SEC),
      suffix,
      String(MESSAGE_LOG_MAX),
      "1",
    );
    noteSuccess();
    return true;
  } catch (err) {
    noteFailure(err, key, "msgs-bump");
    return false;
  }
}

/** Aplica o bump `*` pendente desta conversa (Redis voltou). */
async function flushPending(orgId: string, conversationId: string): Promise<void> {
  const k = pendingKey(orgId, conversationId);
  if (!pending.has(k)) return;
  if (await runBump(orgId, conversationId, memberSuffix("*", []))) pending.delete(k);
}

/**
 * Registra uma mudança nas mensagens da conversa: sobe a versão e anota o
 * que mudou. Chame DEPOIS de gravar (fora de `$transaction`), com o id
 * interno e, quando houver, o `externalId` (o id da bolha). Nunca lança.
 *
 * Sem `ids` em `new`/`upd`/`del`, a entrada vira `*` e o cliente refaz a
 * página inteira — correto, só mais caro.
 */
export async function noteMessageChange(
  orgId: string | null | undefined,
  conversationId: string | null | undefined,
  kind: MessageChangeKind,
  ...ids: (string | null | undefined)[]
): Promise<void> {
  if (!orgId || !conversationId) return;
  try {
    const clean = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    const k = pendingKey(orgId, conversationId);
    const hadPending = pending.has(k);
    const suffix =
      hadPending || (kind !== "meta" && clean.length === 0)
        ? memberSuffix("*", [])
        : memberSuffix(kind, clean);
    if (await runBump(orgId, conversationId, suffix)) {
      if (hadPending) pending.delete(k);
      return;
    }
    if (isCacheRedisDisabled()) return; // sem Redis configurado não há versão
    if (!pending.has(k) && pending.size >= MAX_PENDING) {
      const oldest = pending.values().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
    pending.add(k);
  } catch (err) {
    log.warn({ err, orgId, conversationId, kind }, "[msgs] bump falhou");
  }
}

/**
 * Atalho para quem tem a linha gravada em mãos (retorno do `create` /
 * `update` sem `select`, ou `null` quando o `.catch` engoliu o erro).
 */
export function noteMessageRowChange(
  row:
    | {
        organizationId?: string | null;
        conversationId?: string | null;
        id?: string | null;
        externalId?: string | null;
      }
    | null
    | undefined
    | void,
  kind: MessageChangeKind,
): Promise<void> {
  if (!row) return Promise.resolve();
  return noteMessageChange(row.organizationId, row.conversationId, kind, row.id, row.externalId);
}

/** Várias conversas (ex.: flush do buffer de status). */
export async function noteMessageChanges(
  changes: {
    organizationId: string | null | undefined;
    conversationId: string | null | undefined;
    kind: MessageChangeKind;
    ids: (string | null | undefined)[];
  }[],
): Promise<void> {
  const grouped = new Map<string, { org: string; conv: string; kind: MessageChangeKind; ids: string[] }>();
  for (const c of changes) {
    if (!c.organizationId || !c.conversationId) continue;
    const key = `${c.organizationId}\n${c.conversationId}\n${c.kind}`;
    const entry =
      grouped.get(key) ??
      { org: c.organizationId, conv: c.conversationId, kind: c.kind, ids: [] };
    for (const id of c.ids) if (id) entry.ids.push(id);
    grouped.set(key, entry);
  }
  await Promise.all(
    [...grouped.values()].map((g) => noteMessageChange(g.org, g.conv, g.kind, ...g.ids)),
  );
}

// ── Leitura ────────────────────────────────────────────────────────

/**
 * Famílias da org de que a resposta do GET depende além das mensagens:
 * `authz` (papéis → `canReply`), `rc_users` (papel/avatar dos agentes),
 * `rc_channels` (nome/config do canal, reset da janela de 24 h),
 * `org_settings` (grants de canal por papel).
 */
export const MESSAGE_RESPONSE_FAMILIES = ["authz", "rc_users", "rc_channels", "org_settings"] as const;

export type MessageLogEntry = {
  version: number;
  kind: MessageChangeKind | "*" | "seed";
  /** `Date.now()` do bump. */
  at: number;
  ids: string[];
};

export type ConversationVersionState = {
  conversationId: string;
  version: number;
  /** 1ª entrada guardada no diário (só quando houve mudança desde o cursor). */
  first: MessageLogEntry | null;
  /** Entradas depois do cursor, em ordem de versão. */
  entries: MessageLogEntry[];
};

export type MessageTimelineState = {
  /** Valores crus das famílias da org (`""` = ainda sem versão). */
  families: string[];
  conversations: ConversationVersionState[];
};

export function parseLogMember(member: string): MessageLogEntry | null {
  const parts = member.split(":");
  const version = Number(parts[0]);
  if (!Number.isSafeInteger(version)) return null;
  const kind = parts[1];
  if (kind === "seed") return { version, kind, at: 0, ids: [] };
  if (kind !== "new" && kind !== "upd" && kind !== "del" && kind !== "meta" && kind !== "*") {
    return null;
  }
  const at = parseInt(parts[2] ?? "", 36);
  const ids = (parts.slice(3).join(":") || "").split(",").filter(Boolean);
  return { version, kind, at: Number.isFinite(at) ? at : 0, ids };
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return "";
}

/**
 * Versões das conversas + famílias da org, numa ida ao Redis. `cursors`
 * (mesma ordem de `conversationIds`) pede também as entradas do diário
 * depois de cada versão. `null` = sem Redis (a rota não usa ETag/cursor).
 */
export async function readMessageTimelineState(
  orgId: string,
  conversationIds: string[],
  cursors?: (number | null)[],
): Promise<MessageTimelineState | null> {
  const client = getCacheClient();
  if (!client || conversationIds.length === 0) return null;
  await Promise.all(conversationIds.map((id) => flushPending(orgId, id)));
  const famKeys = MESSAGE_RESPONSE_FAMILIES.map((f) =>
    cacheVersionRedisKey(cacheVersionName(f, orgId)),
  );
  const convKeys = conversationIds.flatMap((id) => [
    messageVersionKey(orgId, id),
    messageLogKey(orgId, id),
  ]);
  const keys = [...famKeys, ...convKeys];
  try {
    const raw = (await client.eval(
      MSGS_STATE_SCRIPT,
      keys.length,
      ...keys,
      String(famKeys.length),
      String(Date.now()),
      String(TTL_SEC),
      String(MESSAGE_DELTA_MAX_ENTRIES),
      ...conversationIds.map((_, i) => {
        const c = cursors?.[i];
        return c === null || c === undefined ? "" : String(c);
      }),
    )) as unknown;
    if (!Array.isArray(raw) || raw.length !== conversationIds.length + 1) return null;
    const [fams, ...convs] = raw as unknown[];
    if (!Array.isArray(fams)) return null;
    const conversations: ConversationVersionState[] = [];
    for (let i = 0; i < convs.length; i++) {
      const row = convs[i];
      if (!Array.isArray(row)) return null;
      const version = Number(asText(row[0]));
      if (!Number.isSafeInteger(version)) return null;
      const firstText = asText(row[1]);
      const items = Array.isArray(row[2]) ? (row[2] as unknown[]) : [];
      conversations.push({
        conversationId: conversationIds[i]!,
        version,
        first: firstText ? parseLogMember(firstText) : null,
        entries: items
          .map((m) => parseLogMember(asText(m)))
          .filter((e): e is MessageLogEntry => e !== null),
      });
    }
    noteSuccess();
    return { families: (fams as unknown[]).map(asText), conversations };
  } catch (err) {
    noteFailure(err, famKeys[0] ?? "msgs", "msgs-state");
    return null;
  }
}

// ── Cursor e ETag ──────────────────────────────────────────────────

const CURSOR_PREFIX = "m1";

function shortHash(...parts: string[]): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(p).update("\n");
  return h.digest("hex").slice(0, 12);
}

/**
 * Cursor opaco da linha do tempo (também é o ETag do delta):
 * `m1.<conversas>.<famílias>.<usuário>.<expira36>.<v1>.<v2>…`
 * (versões em base 36, conversas em ordem de id). `expira` = quando a
 * resposta envelhece sozinha (fim da janela de 24 h, fixada que expira);
 * `0` = não envelhece.
 */
export type TimelineCursor = {
  setHash: string;
  familiesHash: string;
  userHash: string;
  notAfter: number;
  /** Versões por conversa, na ordem de `conversationIds` ordenados. */
  versions: number[];
};

export function sortedTimelineIds(conversationIds: string[]): string[] {
  return [...new Set(conversationIds)].sort();
}

export function timelineCursorFromState(
  orgId: string,
  userId: string,
  state: MessageTimelineState,
  notAfter: number,
): TimelineCursor {
  const ids = state.conversations.map((c) => c.conversationId);
  return {
    setHash: shortHash(orgId, ...ids),
    familiesHash: shortHash(...state.families),
    userHash: shortHash(orgId, userId),
    notAfter: Number.isFinite(notAfter) && notAfter > 0 ? Math.floor(notAfter) : 0,
    versions: state.conversations.map((c) => c.version),
  };
}

export function encodeTimelineCursor(c: TimelineCursor): string {
  return [
    CURSOR_PREFIX,
    c.setHash,
    c.familiesHash,
    c.userHash,
    c.notAfter.toString(36),
    ...c.versions.map((v) => v.toString(36)),
  ].join(".");
}

export function isTimelineCursor(raw: string | null | undefined): raw is string {
  return typeof raw === "string" && raw.startsWith(`${CURSOR_PREFIX}.`);
}

export function decodeTimelineCursor(raw: string | null | undefined): TimelineCursor | null {
  if (!isTimelineCursor(raw) || raw.length > 2_000) return null;
  const parts = raw.split(".");
  if (parts.length < 6) return null;
  const [, setHash, familiesHash, userHash, na, ...vs] = parts;
  const hex = /^[0-9a-f]{12}$/;
  if (!hex.test(setHash!) || !hex.test(familiesHash!) || !hex.test(userHash!)) return null;
  const notAfter = parseInt(na!, 36);
  const versions = vs.map((v) => parseInt(v, 36));
  if (!Number.isFinite(notAfter) || versions.some((v) => !Number.isSafeInteger(v) || v < 0)) {
    return null;
  }
  return { setHash: setHash!, familiesHash: familiesHash!, userHash: userHash!, notAfter, versions };
}

/** Mesmas conversas, famílias, usuário e versões (ignora `notAfter`). */
export function sameTimelineState(a: TimelineCursor, b: TimelineCursor): boolean {
  return (
    a.setHash === b.setHash &&
    a.familiesHash === b.familiesHash &&
    a.userHash === b.userHash &&
    a.versions.length === b.versions.length &&
    a.versions.every((v, i) => v === b.versions[i])
  );
}

/** A resposta guardada ainda vale no relógio (`notAfter` não passou). */
export function cursorStillFresh(c: TimelineCursor, now = Date.now()): boolean {
  return c.notAfter === 0 || now < c.notAfter;
}

/** ETag fraco de uma resposta — o cursor (delta) ou o hash da página (`f.`). */
export function timelineEtag(tag: string): string {
  return `W/"${tag}"`;
}

/**
 * ETag da página inteira: estado + parâmetros da consulta. Formato
 * `f.<hash>.<expira36>` — o `expira` fica legível para o 304 não precisar
 * do banco para saber se a janela de 24 h acabou.
 */
export function pageEtagTag(orgId: string, cursor: TimelineCursor, variant: string): string {
  const h = createHash("sha1")
    .update(orgId)
    .update("\n")
    .update(encodeTimelineCursor({ ...cursor, notAfter: 0 }))
    .update("\n")
    .update(variant)
    .digest("hex")
    .slice(0, 24);
  return `f.${h}.${cursor.notAfter.toString(36)}`;
}

/** Tags do `If-None-Match` (sem `W/` e aspas). */
export function ifNoneMatchTags(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((v) => v.trim().replace(/^W\//i, "").replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * Tag do `If-None-Match` que é a página `f.` com o mesmo hash e ainda no
 * prazo (o 304 a devolve como `ETag`), ou `null`.
 */
export function pageEtagMatches(
  header: string | null | undefined,
  currentTag: string,
  now = Date.now(),
): string | null {
  const [, hash] = currentTag.split(".");
  for (const tag of ifNoneMatchTags(header)) {
    const parts = tag.split(".");
    if (parts.length !== 3 || parts[0] !== "f" || parts[1] !== hash) continue;
    const na = parseInt(parts[2]!, 36);
    if (Number.isFinite(na) && (na === 0 || now < na)) return tag;
  }
  return null;
}

/** `If-None-Match` traz um cursor com o mesmo estado e ainda no prazo. */
export function cursorEtagMatches(
  header: string | null | undefined,
  current: TimelineCursor,
  now = Date.now(),
): TimelineCursor | null {
  for (const tag of ifNoneMatchTags(header)) {
    const c = decodeTimelineCursor(tag);
    if (c && sameTimelineState(c, current) && cursorStillFresh(c, now)) return c;
  }
  return null;
}

// ── Delta ──────────────────────────────────────────────────────────

export type TimelineDeltaPlan =
  | { kind: "unchanged" }
  | { kind: "reset"; reason: string }
  | {
      kind: "delta";
      /** Ids (internos ou da bolha) com mensagem nova. */
      created: Set<string>;
      /** Ids com status/edição/reação/favorito. */
      updated: Set<string>;
      deleted: Set<string>;
      /** Mudou fixada/nota fixada (ou nada além de versão). */
      meta: boolean;
      /** Entradas por conversa — para segurar o cursor antes de linha que ainda não apareceu. */
      byEntry: { conversationIndex: number; entry: MessageLogEntry }[];
    };

/**
 * O que mudou entre o cursor e o estado atual. `reset` quando não dá para
 * garantir o delta: outro conjunto de conversas, outra família/usuário,
 * diário truncado ou expirado, entrada `*`, mudanças demais.
 */
export function planTimelineDelta(
  base: TimelineCursor,
  current: TimelineCursor,
  state: MessageTimelineState,
): TimelineDeltaPlan {
  if (
    base.setHash !== current.setHash ||
    base.userHash !== current.userHash ||
    base.versions.length !== state.conversations.length
  ) {
    return { kind: "reset", reason: "conversas" };
  }
  if (base.familiesHash !== current.familiesHash) return { kind: "reset", reason: "familias" };
  const created = new Set<string>();
  const updated = new Set<string>();
  const deleted = new Set<string>();
  const byEntry: { conversationIndex: number; entry: MessageLogEntry }[] = [];
  let meta = false;
  let changed = false;
  let total = 0;
  for (let i = 0; i < state.conversations.length; i++) {
    const conv = state.conversations[i]!;
    const from = base.versions[i]!;
    if (conv.version === from) continue;
    if (conv.version < from) return { kind: "reset", reason: "versao" };
    changed = true;
    const first = conv.first;
    const complete =
      first !== null &&
      (first.version <= from + 1 || (first.kind === "seed" && first.version >= from));
    if (!complete) return { kind: "reset", reason: "diario" };
    const entries = conv.entries.filter((e) => e.kind !== "seed");
    total += entries.length;
    if (total > MESSAGE_DELTA_MAX_ENTRIES) return { kind: "reset", reason: "volume" };
    const last = entries[entries.length - 1];
    if (!last || last.version !== conv.version) return { kind: "reset", reason: "diario" };
    for (const entry of entries) {
      if (entry.kind === "*") return { kind: "reset", reason: "desconhecido" };
      byEntry.push({ conversationIndex: i, entry });
      if (entry.kind === "meta") {
        meta = true;
        continue;
      }
      for (const id of entry.ids) {
        if (entry.kind === "new") {
          created.add(id);
          deleted.delete(id);
        } else if (entry.kind === "upd") {
          updated.add(id);
        } else {
          deleted.add(id);
          created.delete(id);
          updated.delete(id);
        }
      }
    }
  }
  if (!changed) return { kind: "unchanged" };
  return { kind: "delta", created, updated, deleted, meta, byEntry };
}
