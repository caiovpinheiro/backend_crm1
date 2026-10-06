/**
 * Board (Kanban) em uma consulta — equivalência com o caminho antigo.
 *
 * Banco falso em memória (sem Postgres/Redis):
 *   - `prisma.deal.findMany` / `groupBy` / `stage.findMany` avaliam o
 *     `where` Prisma sobre a fixture (o caminho antigo, por etapa).
 *   - `prisma.$queryRaw` emula, sobre a MESMA fixture, as janelas
 *     `ROW_NUMBER() OVER (PARTITION BY …)` das consultas novas.
 *
 * O que é provado:
 *   1) caminho novo (1 janela + 1 hidratação) == caminho antigo (N findMany)
 *      para os mesmos deals/ordem, com e sem "Carregar mais";
 *   2) `lastInteraction` em SQL == fallback em memória;
 *   3) o SQL gerado é parametrizado (valores em `values`, nunca no texto);
 *   4) a passagem única em `messages` reproduz `last_msg`/`last_in`/`awaiting`;
 *   5) o fallback limita a concorrência a 4;
 *   6) com filtro de etapa, só as etapas escolhidas viram coluna (nos dois
 *      caminhos) e o `stageId` da etapa não sobrescreve o do filtro.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    queryRaw: vi.fn(),
    stageFindMany: vi.fn(),
    dealFindMany: vi.fn(),
    dealGroupBy: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    stage: { findMany: h.stageFindMany },
    deal: { findMany: h.dealFindMany, groupBy: h.dealGroupBy },
  },
  allocateOrgNumber: vi.fn(),
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/activity-log", () => ({
  logEvent: vi.fn(),
  userIdForFk: vi.fn(),
  withAutomationOriginMeta: vi.fn((m: unknown) => m),
}));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingBool: vi.fn(async () => true),
  getOrgSettingFor: vi.fn(async () => null),
  getOrgSetting: vi.fn(async () => null),
}));
vi.mock("@/services/analytics", () => ({
  getStageMetrics: vi.fn(async () => []),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async () => undefined),
}));
vi.mock("@/services/ai/replay-sandbox", () => ({
  isReplaySandboxActive: () => false,
  recordBlockedEffect: vi.fn(),
}));
vi.mock("@/services/kanban-filters", () => ({
  buildDealSearchOr: vi.fn(async () => []),
  createDealSearch: vi.fn(() => null),
  buildDealWhereFromFilters: vi.fn(async () => []),
}));

import { runWithContext } from "@/lib/request-context";
import { buildDealWhereFromFilters } from "@/services/kanban-filters";
import {
  __boardInternal,
  buildBoardCardPreviewSql,
  buildBoardStageTotalsSql,
  buildLastInteractionRankedSql,
  buildRankedBoardDealsSql,
  getBoardData,
  translateDealWhereToSql,
} from "@/services/deals";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ORG = "org-board";
const PIPELINE = "pipe-1";
const T0 = Date.UTC(2026, 0, 1);
const at = (min: number) => new Date(T0 + min * 60_000);

type StageRow = {
  id: string;
  organizationId: string;
  pipelineId: string;
  name: string;
  slug: string;
  number: number;
  position: number;
  color: string;
  winProbability: number;
  rottingDays: number;
  isIncoming: boolean;
  isWon: boolean;
  isLost: boolean;
  requiredDealFieldIds: string[];
};

const stage = (id: string, position: number, extra: Partial<StageRow> = {}): StageRow => ({
  id,
  organizationId: ORG,
  pipelineId: PIPELINE,
  name: id,
  slug: id,
  number: position,
  position,
  color: "#000",
  winProbability: 0,
  rottingDays: 30,
  isIncoming: false,
  isWon: false,
  isLost: false,
  requiredDealFieldIds: [],
  ...extra,
});

const STAGES: StageRow[] = [
  stage("s1", 1, { isIncoming: true }),
  stage("s2", 2),
  stage("s3", 3, { isWon: true }),
];

type DealRow = {
  id: string;
  organizationId: string;
  stageId: string;
  position: number;
  status: "OPEN" | "WON" | "LOST";
  ownerId: string | null;
  contactId: string | null;
  title: string;
  value: number;
  createdAt: Date;
  updatedAt: Date;
};

const deal = (
  id: string,
  stageId: string,
  position: number,
  status: DealRow["status"],
  ownerId: string | null,
  contactId: string | null,
  createdMin: number,
  updatedMin: number,
): DealRow => ({
  id,
  organizationId: ORG,
  stageId,
  position,
  status,
  ownerId,
  contactId,
  title: `Deal ${id}`,
  value: 10,
  createdAt: at(createdMin),
  updatedAt: at(updatedMin),
});

const DEALS: DealRow[] = [
  deal("d01", "s1", 1, "OPEN", "u1", "c1", 1, 11),
  deal("d02", "s1", 2, "OPEN", null, "c2", 5, 15),
  deal("d03", "s1", 3, "OPEN", "u2", "c3", 3, 13),
  deal("d04", "s1", 4, "OPEN", "u1", null, 2, 12),
  deal("d05", "s1", 5, "LOST", "u1", "c1", 4, 14),
  deal("d06", "s1", 6, "OPEN", "u1", "c5", 6, 10),
  deal("d07", "s2", 1, "OPEN", "u1", "c4", 7, 21),
  deal("d08", "s2", 2, "OPEN", null, "c5", 8, 22),
  deal("d09", "s2", 3, "OPEN", "u2", "c2", 9, 20),
  deal("d10", "s2", 4, "OPEN", "u1", "c1", 10, 23),
  deal("d11", "s3", 1, "WON", "u1", "c6", 11, 30),
  deal("d12", "s3", 2, "WON", null, "c3", 12, 31),
  deal("d13", "s3", 3, "OPEN", "u1", "c6", 13, 32),
];

const CONTACTS: Record<string, { id: string; name: string; email: string | null; phone: string | null; avatarUrl: string | null }> = {};
for (const c of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
  CONTACTS[c] = { id: c, name: `Contato ${c}`, email: null, phone: null, avatarUrl: null };
}
const USERS: Record<string, { id: string; name: string; avatarUrl: string | null; type: string }> = {
  u1: { id: "u1", name: "Ana", avatarUrl: null, type: "HUMAN" },
  u2: { id: "u2", name: "Bia", avatarUrl: null, type: "HUMAN" },
};

type ConvRow = {
  id: string;
  contactId: string;
  channel: string;
  unreadCount: number;
  updatedAt: Date;
  /** `conversations.lastMessageAt` (NULL = backfill pendente / sem chat). */
  lastMessageAt: Date | null;
};
const CONVS: ConvRow[] = [
  { id: "v1", contactId: "c1", channel: "whatsapp", unreadCount: 1, updatedAt: at(50), lastMessageAt: at(45) },
  { id: "v2", contactId: "c1", channel: "instagram", unreadCount: 1, updatedAt: at(60), lastMessageAt: at(55) },
  { id: "v3", contactId: "c2", channel: "whatsapp", unreadCount: 0, updatedAt: at(40), lastMessageAt: at(35) },
  { id: "v4", contactId: "c3", channel: "whatsapp", unreadCount: 3, updatedAt: at(70), lastMessageAt: at(20) },
  { id: "v5", contactId: "c5", channel: "whatsapp", unreadCount: 0, updatedAt: at(30), lastMessageAt: null },
  { id: "v6", contactId: "c6", channel: "whatsapp", unreadCount: 2, updatedAt: at(80), lastMessageAt: at(75) },
];

/**
 * `contacts.lastMessageAt` (K1). c1/c3/c6 já preenchidos — valem a coluna,
 * mesmo com `conversations.updatedAt` mais novo (c3: conversa mexida em 70,
 * última mensagem em 20). c2/c5 ainda NULL → fallback
 * `MAX(COALESCE(conversations.lastMessageAt, conversations.updatedAt))`
 * (c2 = 35, c5 = 30). c4 não tem conversa → sem última interação.
 */
const CONTACT_LAST_MESSAGE_AT: Record<string, Date | null> = {
  c1: at(55),
  c2: null,
  c3: at(20),
  c4: null,
  c5: null,
  c6: at(75),
};

type MsgRow = {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  content: string | null;
  createdAt: Date;
  messageType: string;
  isPrivate: boolean;
  externalId: string | null;
  sendStatus: string | null;
  sendError: string | null;
};
const msg = (
  id: string,
  conversationId: string,
  direction: MsgRow["direction"],
  content: string | null,
  min: number,
  messageType = "text",
  isPrivate = false,
): MsgRow => ({
  id,
  conversationId,
  direction,
  content,
  createdAt: at(min),
  messageType,
  isPrivate,
  externalId: null,
  sendStatus: direction === "out" ? "sent" : null,
  sendError: null,
});
const MESSAGES: MsgRow[] = [
  // c1: última é OUT → lastMessage out; lastInbound "?"; unread 2 → 2 aguardando.
  msg("m01", "v1", "in", "oi", 1),
  msg("m02", "v1", "out", "olá", 2),
  msg("m03", "v2", "in", "quero info", 3),
  msg("m04", "v2", "in", "?", 4),
  msg("m05", "v2", "out", "segue", 5),
  // c2: última é IN sem content (mídia) → sem lastMessage/lastInbound (regra antiga).
  msg("m06", "v3", "in", "texto", 1),
  msg("m07", "v3", "in", null, 2),
  // c3: nota e evento excluídos; última real é OUT; 1 inbound disponível.
  msg("m08", "v4", "in", "a", 1),
  msg("m09", "v4", "out", "b", 2),
  msg("m10", "v4", "in", "nota interna", 3, "note"),
  msg("m11", "v4", "out", "Conversa distribuída", 4, "event:assigned"),
  msg("m12", "v4", "in", "privada", 5, "text", true),
  // c5: só uma IN, unread 0 → 1 aguardando (última é inbound).
  msg("m13", "v5", "in", "x", 1),
  // c6 (etapa Ganho): inbound com unread, mas etapa não mostra "aguardando".
  msg("m14", "v6", "in", "w1", 1),
  msg("m15", "v6", "in", "w2", 2),
];

const CARD_EXCLUDED_TYPES = new Set(["note", "ai_draft", "whatsapp_call", "whatsapp_call_recording"]);

// ---------------------------------------------------------------------------
// Emulação do Prisma (where → JS) e das consultas cruas (janelas)
// ---------------------------------------------------------------------------

type AnyWhere = Record<string, unknown>;
const list = (v: unknown): AnyWhere[] => (Array.isArray(v) ? v : [v]) as AnyWhere[];

function evalScalar(actual: unknown, filter: unknown): boolean {
  if (filter === null) return actual === null;
  if (filter instanceof Date) return actual instanceof Date && actual.getTime() === filter.getTime();
  if (typeof filter !== "object") return actual === filter;
  for (const [op, v] of Object.entries(filter as AnyWhere)) {
    if (v === undefined) continue;
    switch (op) {
      case "equals":
        if (!evalScalar(actual, v)) return false;
        break;
      case "in":
        if (!(v as unknown[]).includes(actual)) return false;
        break;
      case "notIn":
        if (actual === null || (v as unknown[]).includes(actual)) return false;
        break;
      case "not":
        if (v === null ? actual === null : actual === v) return false;
        break;
      case "gte":
        if (!((actual as Date).getTime() >= (v as Date).getTime())) return false;
        break;
      case "lte":
        if (!((actual as Date).getTime() <= (v as Date).getTime())) return false;
        break;
      case "contains":
        if (typeof actual !== "string" || !actual.includes(v as string)) return false;
        break;
      default:
        throw new Error(`operador não emulado: ${op}`);
    }
  }
  return true;
}

function evalDealWhere(d: DealRow, where: AnyWhere | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === "AND") {
      if (!list(v).every((w) => evalDealWhere(d, w))) return false;
    } else if (k === "OR") {
      if (!list(v).some((w) => evalDealWhere(d, w))) return false;
    } else if (k === "stage") {
      const st = STAGES.find((s) => s.id === d.stageId);
      const inner = ((v as AnyWhere).is ?? v) as AnyWhere;
      if (!st || !evalScalar(st.pipelineId, inner.pipelineId)) return false;
    } else if (k === "tags") {
      // `{ tags: { none: {} } }` → deal sem tag (fixture: nenhum deal tem tag).
      continue;
    } else if (k in d) {
      if (!evalScalar(d[k as keyof DealRow], v)) return false;
    } else {
      throw new Error(`campo não emulado no where: ${k}`);
    }
  }
  return true;
}

type OrderBy = Record<string, "asc" | "desc">;
function compareBy(orderBy: OrderBy | OrderBy[]) {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
  return (a: DealRow, b: DealRow) => {
    for (const [field, dir] of keys) {
      const av = a[field as keyof DealRow] as number | Date;
      const bv = b[field as keyof DealRow] as number | Date;
      const an = av instanceof Date ? av.getTime() : av;
      const bn = bv instanceof Date ? bv.getTime() : bv;
      if (an !== bn) return dir === "asc" ? an - bn : bn - an;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

function cardOf(d: DealRow) {
  return {
    ...d,
    contact: d.contactId ? { ...CONTACTS[d.contactId] } : null,
    owner: d.ownerId ? { ...USERS[d.ownerId] } : null,
    tags: [],
    activities: [],
  };
}

function emulateDealFindMany(args: {
  where: AnyWhere;
  orderBy?: OrderBy | OrderBy[];
  take?: number;
  select?: Record<string, boolean>;
  include?: unknown;
}) {
  let rows = DEALS.filter((d) => evalDealWhere(d, args.where));
  if (args.orderBy) rows = [...rows].sort(compareBy(args.orderBy));
  if (args.take != null) rows = rows.slice(0, args.take);
  if (args.select) {
    const keys = Object.keys(args.select);
    return rows.map((d) => Object.fromEntries(keys.map((k) => [k, d[k as keyof DealRow]])));
  }
  return rows.map(cardOf);
}

function emulateDealGroupBy(args: { where: AnyWhere }) {
  const counts = new Map<string, number>();
  for (const d of DEALS.filter((d) => evalDealWhere(d, args.where))) {
    counts.set(d.stageId, (counts.get(d.stageId) ?? 0) + 1);
  }
  return [...counts].map(([stageId, n]) => ({ stageId, _count: { _all: n } }));
}

/** `$queryRaw` aceita template (strings, ...values) ou um `Prisma.Sql`. */
function parseRawCall(call: unknown[]): { text: string; values: unknown[] } {
  const [first, ...rest] = call;
  if (!Array.isArray(first)) {
    const sql = first as Prisma.Sql;
    return { text: sql.strings.join("?"), values: sql.values };
  }
  return { text: (first as readonly string[]).join("?"), values: rest };
}

/** `where` Prisma corrente — o SQL cru emulado filtra a fixture por ele. */
let currentWhere: AnyWhere = {};

/** Última interação por contato: coluna do contato; NULL → fallback nas conversas. */
function lastConvAtByContact(): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of CONVS) {
    if (CONTACT_LAST_MESSAGE_AT[c.contactId]) continue;
    const convAt = (c.lastMessageAt ?? c.updatedAt).getTime();
    m.set(c.contactId, Math.max(m.get(c.contactId) ?? -Infinity, convAt));
  }
  for (const [contactId, at] of Object.entries(CONTACT_LAST_MESSAGE_AT)) {
    if (at) m.set(contactId, at.getTime());
  }
  return m;
}

function rankRows(
  rows: DealRow[],
  cmp: (a: DealRow, b: DealRow) => number,
  maxPerStage: number,
) {
  const byStage = new Map<string, DealRow[]>();
  for (const d of rows) byStage.set(d.stageId, [...(byStage.get(d.stageId) ?? []), d]);
  // `total` = COUNT(*) OVER (PARTITION BY "stageId"): a etapa inteira, não o corte.
  const out: { id: string; stageId: string; rn: number; total: number }[] = [];
  for (const [stageId, ds] of byStage) {
    ds.sort(cmp).forEach((d, i) => {
      if (i + 1 <= maxPerStage) out.push({ id: d.id, stageId, rn: i + 1, total: ds.length });
    });
  }
  // Embaralha de propósito: o código não pode depender da ordem física.
  return out.reverse();
}

function emulateRaw(call: unknown[]): unknown[] {
  const { text, values } = parseRawCall(call);

  if (text.includes("WITH candidates AS")) {
    // lastInteraction: values = [org, stageIds, ...where, org(contato), org(lateral), scanCap, maxPerStage]
    const stageIds = values[1] as string[];
    const scanCap = values[values.length - 2] as number;
    const maxPerStage = values[values.length - 1] as number;
    const dir = /last_at DESC NULLS LAST/.test(text) ? "desc" : "asc";
    const matched = DEALS.filter((d) => stageIds.includes(d.stageId) && evalDealWhere(d, currentWhere));
    const candidates = rankRows(matched, compareBy([{ updatedAt: "desc" }]), scanCap).map(
      (r) => DEALS.find((d) => d.id === r.id) as DealRow,
    );
    const last = lastConvAtByContact();
    const mul = dir === "desc" ? -1 : 1;
    // O total vem da janela dos CANDIDATOS (todos os que casam, antes do teto).
    const totalByStage = new Map<string, number>();
    for (const d of matched) totalByStage.set(d.stageId, (totalByStage.get(d.stageId) ?? 0) + 1);
    return rankRows(
      candidates,
      (a, b) => {
        const la = a.contactId ? last.get(a.contactId) : undefined;
        const lb = b.contactId ? last.get(b.contactId) : undefined;
        if (la != null && lb != null && la !== lb) return (la - lb) * mul;
        if (la != null && lb == null) return -1;
        if (la == null && lb != null) return 1;
        if (a.position !== b.position) return a.position - b.position;
        return a.id < b.id ? -1 : 1;
      },
      maxPerStage,
    ).map((r) => ({ ...r, total: totalByStage.get(r.stageId) ?? 0 }));
  }

  if (text.includes('PARTITION BY d."stageId"')) {
    // ranking padrão: values = [org, stageIds, ...where, maxPerStage]
    const stageIds = values[1] as string[];
    const maxPerStage = values[values.length - 1] as number;
    const orderBy: OrderBy[] = /d\."createdAt" DESC/.test(text)
      ? [{ createdAt: "desc" }, { position: "asc" }]
      : /d\."createdAt" ASC/.test(text)
        ? [{ createdAt: "asc" }, { position: "asc" }]
        : [{ position: "asc" }];
    const matched = DEALS.filter((d) => stageIds.includes(d.stageId) && evalDealWhere(d, currentWhere));
    return rankRows(matched, compareBy(orderBy), maxPerStage);
  }

  if (text.includes("FROM contacts ct") && text.includes("ct.id = ANY(")) {
    // fallback em memória: values = [org(lateral), org, contactIds]
    const contactIds = values.find((v) => Array.isArray(v)) as string[];
    const last = lastConvAtByContact();
    return contactIds
      .filter((c) => last.has(c))
      .map((c) => ({ contactId: c, last_at: new Date(last.get(c) as number) }));
  }

  if (text.includes("FROM deal_products")) return [];

  if (text.includes("per_contact AS")) {
    // Prévia do card numa consulta (K2): values[0] = contatos; último = teto
    // do "aguardando". Por CONVERSA: últimas do cliente (teto quando o
    // contato tem não lidas; 1 quando não tem) + a última nossa; depois a
    // janela por (contato, direção) só sobre essas linhas.
    const contactIds = values[0] as string[];
    const cap = values[values.length - 1] as number;
    const eligible = (m: MsgRow) =>
      !m.isPrivate && !CARD_EXCLUDED_TYPES.has(m.messageType) && !m.messageType.startsWith("event");
    const newestFirst = (x: MsgRow, y: MsgRow) =>
      y.createdAt.getTime() - x.createdAt.getTime() || (y.id < x.id ? -1 : 1);
    const out: unknown[] = [];
    for (const contactId of contactIds) {
      const convs = CONVS.filter((v) => v.contactId === contactId);
      if (convs.length === 0) continue;
      const latest = [...convs].sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime())[0];
      const unread = convs.reduce((sum, v) => sum + v.unreadCount, 0);
      const base = { contactId, channel: latest?.channel ?? null, unreadCount: unread };
      const inLimit = unread > 0 ? cap : 1;
      const picked: MsgRow[] = [];
      for (const conv of convs) {
        for (const [dir, limit] of [["in", inLimit], ["out", 1]] as const) {
          picked.push(
            ...MESSAGES.filter((m) => m.conversationId === conv.id && m.direction === dir && eligible(m))
              .sort(newestFirst)
              .slice(0, limit),
          );
        }
      }
      let emitted = 0;
      for (const dir of ["in", "out"] as const) {
        picked
          .filter((m) => m.direction === dir)
          .sort(newestFirst)
          .forEach((m, i) => {
            const rn = i + 1;
            if (rn > (dir === "in" && unread > 0 ? cap : 1)) return;
            emitted++;
            out.push({
              ...base,
              msgId: m.id,
              msgExternalId: m.externalId,
              msgContent: m.content,
              msgCreatedAt: m.createdAt,
              msgDirection: m.direction,
              msgSendStatus: m.sendStatus,
              msgSendError: m.sendError,
              rn,
            });
          });
      }
      if (emitted === 0) {
        out.push({
          ...base,
          msgId: null,
          msgExternalId: null,
          msgContent: null,
          msgCreatedAt: null,
          msgDirection: null,
          msgSendStatus: null,
          msgSendError: null,
          rn: null,
        });
      }
    }
    return out;
  }

  throw new Error(`SQL cru não emulado: ${text.slice(0, 120)}`);
}

function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: ORG } as Parameters<typeof runWithContext>[0],
    fn,
  ) as Promise<T>;
}

beforeEach(() => {
  h.queryRaw.mockReset().mockImplementation(async (...call: unknown[]) => emulateRaw(call));
  h.stageFindMany.mockReset().mockImplementation(async (args: { where: { pipelineId: string } }) =>
    STAGES.filter((s) => s.pipelineId === args.where.pipelineId).map((s) => ({ ...s })),
  );
  h.dealFindMany.mockReset().mockImplementation(async (args: Parameters<typeof emulateDealFindMany>[0]) =>
    emulateDealFindMany(args),
  );
  h.dealGroupBy.mockReset().mockImplementation(async (args: { where: AnyWhere }) => emulateDealGroupBy(args));
  currentWhere = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

const rawCalls = () => h.queryRaw.mock.calls.length;
const findManyCalls = () => h.dealFindMany.mock.calls.length;

const stagesRaw = () => STAGES.map((s) => ({ ...s }));

// ---------------------------------------------------------------------------
// 1) Caminho novo == caminho antigo (sort position / createdAt, com offset)
// ---------------------------------------------------------------------------

const SCENARIOS: {
  name: string;
  where: Prisma.DealWhereInput;
  sortField: "position" | "createdAt" | undefined;
  sortDirection: "asc" | "desc";
  perStage: number;
  offsetByStage: Record<string, number>;
}[] = [
  {
    name: "status OPEN, position asc, 2 por coluna",
    where: { status: "OPEN" },
    sortField: undefined,
    sortDirection: "asc",
    perStage: 2,
    offsetByStage: {},
  },
  {
    name: "OPEN + visibilidade (dono ou sem dono), createdAt desc, carregar mais em s1",
    where: { AND: [{ status: "OPEN" }, { OR: [{ ownerId: "u1" }, { ownerId: null }] }] },
    sortField: "createdAt",
    sortDirection: "desc",
    perStage: 1,
    offsetByStage: { s1: 2 },
  },
  {
    name: "ALL (sem status) + escopo de funil notIn + createdAt asc",
    where: { AND: [{ ownerId: { not: null } }, { stageId: { notIn: ["s3"] } }] },
    sortField: "createdAt",
    sortDirection: "asc",
    perStage: 3,
    offsetByStage: {},
  },
  {
    name: "status in + stage.pipelineId (filtro avançado escalar)",
    where: {
      AND: [
        { status: { in: ["OPEN", "WON"] } },
        { stage: { pipelineId: PIPELINE } },
        { createdAt: { gte: at(3), lte: at(12) } },
      ],
    },
    sortField: undefined,
    sortDirection: "asc",
    perStage: 10,
    offsetByStage: {},
  },
];

describe("board: consulta única (ROW_NUMBER) == findMany por etapa", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      currentWhere = sc.where as AnyWhere;
      const whereSql = translateDealWhereToSql(sc.where);
      expect(whereSql).not.toBeNull();
      const orderBy: Prisma.DealOrderByWithRelationInput[] =
        sc.sortField === "createdAt"
          ? [{ createdAt: sc.sortDirection }, { position: "asc" }]
          : [{ position: "asc" }];

      const oldResult = await withOrg(() =>
        __boardInternal.loadBoardStagesPerStage(
          stagesRaw(),
          sc.where,
          orderBy,
          sc.perStage,
          sc.offsetByStage,
        ),
      );
      const oldFindMany = findManyCalls();
      expect(oldFindMany).toBe(STAGES.length);
      expect(rawCalls()).toBe(0);

      h.dealFindMany.mockClear();
      const newResult = await withOrg(() =>
        __boardInternal.loadBoardStagesRanked(
          stagesRaw(),
          whereSql as Prisma.Sql,
          sc.sortField,
          sc.sortDirection,
          sc.perStage,
          sc.offsetByStage,
        ),
      );
      expect(rawCalls()).toBe(1);
      expect(findManyCalls()).toBe(1);

      expect(JSON.parse(JSON.stringify(newResult))).toEqual(
        JSON.parse(JSON.stringify(oldResult)),
      );
      // Sanidade: o cenário realmente devolve cards e respeita o limite.
      const total = newResult.reduce((n, s) => n + s.deals.length, 0);
      expect(total).toBeGreaterThan(0);
      for (const s of newResult) {
        expect(s.deals.length).toBeLessThanOrEqual(sc.perStage + (sc.offsetByStage[s.id] ?? 0));
      }
    });
  }

  it("hidratação não roda findMany quando nenhuma etapa tem deal", async () => {
    currentWhere = { status: "LOST", stageId: "s2" };
    const res = await withOrg(() =>
      __boardInternal.loadBoardStagesRanked(
        stagesRaw(),
        translateDealWhereToSql(currentWhere as Prisma.DealWhereInput) as Prisma.Sql,
        undefined,
        "asc",
        5,
        {},
      ),
    );
    expect(res.map((s) => s.deals.length)).toEqual([0, 0, 0]);
    expect(findManyCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2) lastInteraction: SQL único == fallback em memória
// ---------------------------------------------------------------------------

describe("board: lastInteraction em uma consulta == fallback por etapa", () => {
  for (const direction of ["asc", "desc"] as const) {
    it(`direção ${direction}, com carregar mais`, async () => {
      const where: Prisma.DealWhereInput = { status: "OPEN" };
      currentWhere = where as AnyWhere;
      const perStage = 2;
      const offsetByStage = { s2: 1 };
      const limitByStage = new Map(
        STAGES.map((s) => [s.id, perStage + (offsetByStage[s.id as keyof typeof offsetByStage] ?? 0)]),
      );

      const oldIds = await withOrg(() =>
        __boardInternal.loadLastInteractionIdsPerStage(stagesRaw(), where, limitByStage, direction),
      );
      const oldResult = await withOrg(() => __boardInternal.hydrateBoardStages(stagesRaw(), oldIds));
      expect(findManyCalls()).toBe(STAGES.length + 1);
      expect(rawCalls()).toBe(1); // última mensagem por contato

      h.dealFindMany.mockClear();
      h.queryRaw.mockClear();
      const newResult = await withOrg(() =>
        __boardInternal.loadBoardStagesByLastInteraction(PIPELINE, where, perStage, offsetByStage, direction),
      );
      expect(rawCalls()).toBe(1);
      expect(findManyCalls()).toBe(1);

      expect(JSON.parse(JSON.stringify(newResult))).toEqual(JSON.parse(JSON.stringify(oldResult)));
      expect(newResult.reduce((n, s) => n + s.deals.length, 0)).toBeGreaterThan(0);
    });
  }

  it("where não traduzível: ids pré-resolvidos numa consulta + janela SQL == fallback por etapa", async () => {
    const where: Prisma.DealWhereInput = {
      AND: [{ status: "OPEN" }, { title: { contains: "Deal d0" } }],
    };
    currentWhere = where as AnyWhere;
    expect(translateDealWhereToSql(where)).toBeNull();
    const limitByStage = new Map(STAGES.map((s) => [s.id, 2]));
    const oldIds = await withOrg(() =>
      __boardInternal.loadLastInteractionIdsPerStage(stagesRaw(), where, limitByStage, "desc"),
    );
    const oldResult = await withOrg(() => __boardInternal.hydrateBoardStages(stagesRaw(), oldIds));

    h.dealFindMany.mockClear();
    h.queryRaw.mockClear();
    const lastAt = new Map<string, Date | null>();
    const res = await withOrg(() =>
      __boardInternal.loadBoardStagesByLastInteraction(PIPELINE, where, 2, {}, "desc", lastAt),
    );
    // 1 findMany (ids) + 1 janela + 1 hidratação — nada por etapa.
    expect(findManyCalls()).toBe(2);
    expect(rawCalls()).toBe(1);
    const pre = h.dealFindMany.mock.calls[0]![0] as { where: unknown; select: unknown };
    expect(pre.select).toEqual({ id: true, stageId: true });
    expect(pre.where).toEqual({ AND: [where, { stageId: { in: ["s1", "s2", "s3"] } }] });
    const ranked = parseRawCall(h.queryRaw.mock.calls[0]!);
    expect(ranked.text).toContain("d.id = ANY(?)");
    expect(JSON.parse(JSON.stringify(res))).toEqual(JSON.parse(JSON.stringify(oldResult)));
    expect(res.reduce((n, s) => n + s.deals.length, 0)).toBeGreaterThan(0);
    // Sem `last_at` para cursor: a página por cursor só aceita where traduzível.
    expect(lastAt.size).toBe(0);
  });

  it("pré-resolução acima do teto → null (caminho por etapa)", async () => {
    const where: Prisma.DealWhereInput = { title: { contains: "Deal" } };
    currentWhere = where as AnyWhere;
    const capped = await withOrg(() =>
      __boardInternal.preResolveBoardWhere(where, ["s1", "s2", "s3"], 2),
    );
    expect(capped).toBeNull();
    expect((h.dealFindMany.mock.calls.at(-1)![0] as { take: number }).take).toBe(3);
    const none = await withOrg(() =>
      __boardInternal.preResolveBoardWhere({ title: { contains: "zzz" } }, ["s1"]),
    );
    expect(none?.sql.strings.join("?")).toBe("FALSE");
    expect(none?.countsByStage.size).toBe(0);
    expect(__boardInternal.BOARD_PRERESOLVE_CAP).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// 3) SQL gerado: parametrizado, sem interpolação
// ---------------------------------------------------------------------------

describe("board: SQL gerado", () => {
  it("traduz o where do board (status + visibilidade + escopo) só com parâmetros", () => {
    const sql = translateDealWhereToSql({
      AND: [
        { status: "OPEN" },
        { OR: [{ ownerId: "u1'; DROP TABLE deals; --" }, { ownerId: null }] },
        { stageId: { notIn: ["s3", "s9"] } },
        { ownerId: { not: null } },
      ],
    });
    expect(sql).not.toBeNull();
    const text = (sql as Prisma.Sql).strings.join("?");
    expect(text).toBe(
      '(d."status" = ?::"DealStatus" AND (d."ownerId" = ? OR d."ownerId" IS NULL) AND NOT (d."stageId" = ANY(?)) AND d."ownerId" IS NOT NULL)',
    );
    expect((sql as Prisma.Sql).values).toEqual(["OPEN", "u1'; DROP TABLE deals; --", ["s3", "s9"]]);
    expect(text).not.toContain("DROP");
  });

  it("status in → cast de array de enum; in vazio → FALSE; stage.pipelineId → subconsulta", () => {
    const sql = translateDealWhereToSql({
      status: { in: ["OPEN", "WON"] },
      contactId: { in: [] },
      stage: { is: { pipelineId: { notIn: ["p9"] } } },
    }) as Prisma.Sql;
    expect(sql.strings.join("?")).toBe(
      '(d."status" = ANY(?::"DealStatus"[]) AND FALSE AND d."stageId" IN (SELECT st.id FROM stages st WHERE NOT (st."pipelineId" = ANY(?))))',
    );
    expect(sql.values).toEqual([["OPEN", "WON"], ["p9"]]);
  });

  it("where vazio → TRUE; relações, NOT e `not: valor` → null (fallback)", () => {
    expect((translateDealWhereToSql({}) as Prisma.Sql).strings.join("?")).toBe("TRUE");
    expect((translateDealWhereToSql(undefined) as Prisma.Sql).strings.join("?")).toBe("TRUE");
    expect(translateDealWhereToSql({ tags: { every: { tagId: "t1" } } })).toBeNull();
    expect(translateDealWhereToSql({ tags: { some: { tag: { name: "x" } } } })).toBeNull();
    expect(
      translateDealWhereToSql({ contact: { is: { name: { contains: "x", mode: "insensitive" } } } }),
    ).toBeNull();
    expect(
      translateDealWhereToSql({ contact: { is: { conversations: { some: { status: "OPEN" } } } } }),
    ).toBeNull();
    expect(translateDealWhereToSql({ contact: { isNot: null } })).toBeNull();
    expect(translateDealWhereToSql({ ownerId: { not: "u1" } })).toBeNull();
    expect(translateDealWhereToSql({ NOT: { status: "OPEN" } })).toBeNull();
    expect(translateDealWhereToSql({ AND: [{ status: "OPEN" }, { title: { contains: "x" } }] })).toBeNull();
    expect(translateDealWhereToSql({ stage: { name: "x" } })).toBeNull();
  });

  it("tags (qualquer / nenhuma / sem tag) → EXISTS em tags_on_deals, ids como parâmetro", () => {
    const sql = translateDealWhereToSql({
      AND: [
        { tags: { some: { tagId: { in: ["t1", "t2"] } } } },
        { tags: { some: { tagId: "t3" } } },
        { tags: { none: { tagId: { in: ["t9"] } } } },
      ],
    }) as Prisma.Sql;
    expect(sql.strings.join("?")).toBe(
      '(EXISTS (SELECT 1 FROM tags_on_deals tg WHERE tg."dealId" = d.id AND tg."tagId" = ANY(?))' +
        ' AND EXISTS (SELECT 1 FROM tags_on_deals tg WHERE tg."dealId" = d.id AND tg."tagId" = ?)' +
        ' AND NOT EXISTS (SELECT 1 FROM tags_on_deals tg WHERE tg."dealId" = d.id AND tg."tagId" = ANY(?)))',
    );
    expect(sql.values).toEqual([["t1", "t2"], "t3", ["t9"]]);
    const noTags = translateDealWhereToSql({ tags: { none: {} } }) as Prisma.Sql;
    expect(noTags.strings.join("?")).toBe(
      'NOT EXISTS (SELECT 1 FROM tags_on_deals tg WHERE tg."dealId" = d.id AND TRUE)',
    );
  });

  it("contato (origem, UTM, telefone/e-mail) → EXISTS em contacts da mesma org", () => {
    const sql = translateDealWhereToSql({
      AND: [
        {
          OR: [
            { contact: { is: { source: { in: ["facebook"] } } } },
            {
              OR: [
                { contactId: null },
                { contact: { is: { source: null } } },
                { contact: { is: { source: "" } } },
              ],
            },
          ],
        },
        { contact: { is: { adUtmSource: { in: ["google"] } } } },
        { contact: { is: { phone: { not: null } } } },
        { contact: { is: { email: null } } },
      ],
    }) as Prisma.Sql;
    const text = sql.strings.join("?");
    const exists =
      'EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = d."contactId" AND ct."organizationId" = d."organizationId" AND ';
    expect(text).toContain(`${exists}ct."source" = ANY(?))`);
    expect(text).toContain(`d."contactId" IS NULL OR ${exists}ct."source" IS NULL)`);
    expect(text).toContain(`${exists}ct."source" = ?)`);
    expect(text).toContain(`${exists}ct."ad_utm_source" = ANY(?))`);
    expect(text).toContain(`${exists}ct."phone" IS NOT NULL)`);
    expect(text).toContain(`${exists}ct."email" IS NULL)`);
    expect(sql.values).toEqual([["facebook"], "", ["google"]]);
  });

  it("filtro de direção em coluna pronta: EXISTS no contato pela PK, sem lista de ids (K1)", () => {
    const sql = translateDealWhereToSql({
      AND: [{ status: "OPEN" }, { contact: { is: { lastMessageDirection: "in" } } }],
    }) as Prisma.Sql;
    expect(sql).not.toBeNull();
    expect(sql.strings.join("?")).toContain(
      'EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = d."contactId" AND ct."organizationId" = d."organizationId" AND ct."lastMessageDirection" = ?)',
    );
    expect(sql.values).toEqual(["OPEN", "in"]);
  });

  it("consulta ranqueada: ROW_NUMBER por etapa, org/etapas/limite como parâmetros", () => {
    const sql = buildRankedBoardDealsSql({
      orgId: "org-x",
      stageIds: ["s1", "s2"],
      whereSql: translateDealWhereToSql({ status: "OPEN" }) as Prisma.Sql,
      orderBy: __boardInternal.boardRankOrderBySql("createdAt", "desc"),
      maxPerStage: 7,
    });
    const text = sql.strings.join("?");
    expect(text).toContain('ROW_NUMBER() OVER (\n          PARTITION BY d."stageId"');
    expect(text).toContain('ORDER BY d."createdAt" DESC, d."position" ASC, d.id ASC');
    expect(text).toContain('d."organizationId" = ?');
    expect(text).toContain('d."stageId" = ANY(?)');
    expect(text).toContain("WHERE r.rn <= ?");
    expect(text).not.toContain("org-x");
    expect(sql.values).toEqual(["org-x", ["s1", "s2"], "OPEN", 7]);
    // Total da etapa na mesma janela (K3).
    expect(text).toContain('COUNT(*) OVER (PARTITION BY d."stageId")::int AS total');
    expect(text).toContain('SELECT r.id, r."stageId", r.rn, r.total');
    // Placeholders numerados na forma final do Postgres.
    expect(sql.text).toContain("$1");
    expect(sql.text).toContain("$4");
  });

  it("consulta lastInteraction: LATERAL só sobre candidatos, direção como constante", () => {
    const sql = buildLastInteractionRankedSql({
      orgId: "org-x",
      stageIds: ["s1"],
      whereSql: translateDealWhereToSql({ status: "OPEN" }) as Prisma.Sql,
      direction: "desc",
      scanCap: 2500,
      maxPerStage: 100,
    });
    const text = sql.strings.join("?");
    expect(text).toContain("LEFT JOIN LATERAL");
    expect(text).toContain("WHERE c.scan_rn <= ?");
    expect(text).toContain("ORDER BY s.last_at DESC NULLS LAST");
    // Total da etapa contado nos candidatos, antes do teto de varredura (K3).
    expect(text).toMatch(/AS scan_rn,\s+COUNT\(\*\) OVER \(PARTITION BY d\."stageId"\)::int AS total/);
    expect(text).toContain('SELECT r.id, r."stageId", r.rn, r.last_at, r.total');
    // Coluna pronta do contato; `conversations` só para quem está NULL.
    expect(text).toContain('LEFT JOIN contacts ct');
    expect(text).toContain('COALESCE(ct."lastMessageAt", fb.last_at) AS last_at');
    expect(text).toMatch(/FROM conversations cv\s+WHERE ct\.id IS NOT NULL\s+AND ct\."lastMessageAt" IS NULL/);
    expect(text).toContain('MAX(COALESCE(cv."lastMessageAt", cv."updatedAt"))');
    expect(text).not.toContain('MAX(cv."updatedAt")');
    expect(text).not.toContain("org-x");
    expect(sql.values).toEqual(["org-x", ["s1"], "OPEN", "org-x", "org-x", 2500, 100]);
    const asc = buildLastInteractionRankedSql({
      orgId: "o",
      stageIds: ["s1"],
      whereSql: Prisma.sql`TRUE`,
      direction: "asc",
      scanCap: 1,
      maxPerStage: 1,
    });
    expect(asc.strings.join("?")).toContain("ORDER BY s.last_at ASC NULLS LAST");
  });
});

describe("board: contagem por etapa sem consulta à parte (K3)", () => {
  it("getBoardData: totais vêm da janela — etapa cheia, etapa cortada e etapa vazia", async () => {
    currentWhere = { status: "OPEN" };
    const board = await withOrg(() =>
      getBoardData(PIPELINE, null, undefined, undefined, { perStage: 2 }),
    );
    expect(h.dealGroupBy).not.toHaveBeenCalled();
    const byId = new Map(board.map((s) => [s.id, s]));
    // s1: 5 abertos (d05 é LOST), 2 carregados.
    expect(byId.get("s1")).toMatchObject({ totalCount: 5, loadedCount: 2, hasMore: true });
    expect(byId.get("s2")).toMatchObject({ totalCount: 4, loadedCount: 2, hasMore: true });
    // s3: só d13 aberto.
    expect(byId.get("s3")).toMatchObject({ totalCount: 1, loadedCount: 1, hasMore: false });
  });

  it("etapa sem nenhum negócio casando: total 0 (sem linha na janela), não o tamanho da página", async () => {
    currentWhere = { status: "WON" };
    const board = await withOrg(() =>
      getBoardData(PIPELINE, null, "WON", undefined, { perStage: 10 }),
    );
    expect(h.dealGroupBy).not.toHaveBeenCalled();
    expect(board.map((s) => [s.id, s.totalCount, s.hasMore])).toEqual([
      ["s1", 0, false],
      ["s2", 0, false],
      ["s3", 2, false],
    ]);
  });

  it("lastInteraction: total da etapa mesmo com a janela cortada", async () => {
    currentWhere = { status: "OPEN" };
    const board = await withOrg(() =>
      getBoardData(PIPELINE, null, undefined, undefined, {
        perStage: 1,
        sortField: "lastInteraction",
        sortDirection: "desc",
      }),
    );
    expect(h.dealGroupBy).not.toHaveBeenCalled();
    expect(board.map((s) => [s.id, s.totalCount, s.loadedCount])).toEqual([
      ["s1", 5, 1],
      ["s2", 4, 1],
      ["s3", 1, 1],
    ]);
  });

  it("caminho por etapa (where que não traduz e passa do teto) continua contando com groupBy", async () => {
    const where: Prisma.DealWhereInput = { title: { contains: "Deal" } };
    vi.mocked(buildDealWhereFromFilters).mockResolvedValueOnce([where]);
    currentWhere = where as AnyWhere;
    const cap = __boardInternal.BOARD_PRERESOLVE_CAP;
    // Força "acima do teto": a pré-resolução devolve cap + 1 linhas.
    h.dealFindMany.mockImplementationOnce(async () =>
      Array.from({ length: cap + 1 }, (_, i) => ({ id: `x${i}`, stageId: "s1" })),
    );
    const board = await withOrg(() =>
      // Qualquer filtro avançado aciona o where simulado acima (a busca livre
      // agora é tratada à parte, ver deal-search-sql.test.ts).
      getBoardData(PIPELINE, null, "ALL", { withoutTags: true }, { perStage: 2 }),
    );
    expect(h.dealGroupBy).toHaveBeenCalledTimes(1);
    expect(board.find((s) => s.id === "s1")?.totalCount).toBe(6);
  });

  it("contagem do \"carregar mais\": SQL sem JOIN, etapas e organização como parâmetros", () => {
    const sql = buildBoardStageTotalsSql({
      orgId: "org-x",
      stageIds: ["s1", "s2"],
      whereSql: translateDealWhereToSql({ status: "OPEN" }) as Prisma.Sql,
    });
    const text = sql.strings.join("?");
    expect(text).toContain('SELECT d."stageId", COUNT(*)::int AS total');
    expect(text).toContain('d."stageId" = ANY(?)');
    expect(text).toContain('GROUP BY d."stageId"');
    expect(text).not.toMatch(/JOIN/);
    expect(sql.values).toEqual(["org-x", ["s1", "s2"], "OPEN"]);
  });
});

describe("board: prévia do card numa consulta, sem varrer messages (K2)", () => {
  const sql = buildBoardCardPreviewSql({ orgId: "org-x", contactIds: ["c1", "c2"], awaitingCap: 5 });
  const text = sql.strings.join("?");

  it("por conversa, LATERAL limitado pelo índice (conversationId, createdAt)", () => {
    expect(text).toContain("CROSS JOIN LATERAL");
    // Duas buscas por conversa (cliente e nossa), cada uma com LIMIT.
    expect(text.match(/FROM messages m\s+WHERE m\."conversationId" = conv\.id/g)).toHaveLength(2);
    expect(text.match(/ORDER BY m\."createdAt" DESC, m\.id DESC\s+LIMIT /g)).toHaveLength(2);
    // Cliente: teto do "aguardando" só quando o contato tem não lidas.
    expect(text).toMatch(/LIMIT CASE WHEN pc\.unread > 0 THEN \?::int ELSE 1 END\)/);
    // Nossa: só a última.
    expect(text).toMatch(/LIMIT 1\)/);
    // A janela final ranqueia só as linhas já escolhidas.
    expect(text).toMatch(/PARTITION BY p\."contactId", p\.direction/);
    expect(text).toMatch(/FROM picked p/);
  });

  it("mesmo recorte de mensagem de chat da prévia (nota, rascunho, ligação e evento fora)", () => {
    expect(text.match(/m\."isPrivate" = false/g)).toHaveLength(2);
    expect(text.match(/m\."messageType" NOT LIKE 'event%'/g)).toHaveLength(2);
    const types = ["note", "ai_draft", "whatsapp_call", "whatsapp_call_recording"];
    expect(sql.values).toEqual([
      ["c1", "c2"],
      "org-x",
      "org-x",
      "in",
      ...types,
      5,
      "org-x",
      "out",
      ...types,
      5,
    ]);
  });

  it("não lidas = soma; canal = conversa de updatedAt mais recente; tudo escopado à organização", () => {
    expect(text).toContain('COALESCE(SUM("unreadCount"), 0)::int AS unread');
    expect(text).toContain('(ARRAY_AGG(channel ORDER BY "updatedAt" DESC))[1] AS channel');
    expect(text).toContain('c."organizationId" = ?');
    expect(text.match(/m\."organizationId" = \?/g)).toHaveLength(2);
    expect(text).not.toContain("org-x");
    expect(text).not.toContain("c1");
  });
});

// ---------------------------------------------------------------------------
// 4) Board completo: passagem única em messages reproduz o contrato antigo
// ---------------------------------------------------------------------------

describe("board completo (getBoardData) com passagem única em messages", () => {
  it("lastMessage / lastInboundMessage / awaitingMessages / unread / channel por card", async () => {
    const where: Prisma.DealWhereInput = {};
    // `getBoardData` monta `{ status: OPEN }` por default; com ALL e
    // visibilidade vazia o where fica `{}` (→ `TRUE` no SQL) e cobre também
    // a etapa Ganho (sem "aguardando").
    currentWhere = {};
    const board = await withOrg(() =>
      getBoardData(PIPELINE, where, "ALL", undefined, { perStage: 10 }),
    );
    // Consultas do miss: 1 stages + 1 ranking (com o total por etapa, K3) +
    // 1 hidratação + 2 raws (produtos e prévia — conversas e mensagens numa
    // só, K2). Nenhum groupBy.
    expect(h.stageFindMany).toHaveBeenCalledTimes(1);
    expect(findManyCalls()).toBe(1);
    expect(h.dealGroupBy).not.toHaveBeenCalled();
    expect(rawCalls()).toBe(3);
    const previewCalls = h.queryRaw.mock.calls.filter((c) =>
      parseRawCall(c).text.includes("FROM messages"),
    );
    // Uma única consulta toca `messages`, e sem varrer o histórico: nada de
    // JOIN de todas as mensagens dos contatos antes da janela.
    expect(previewCalls).toHaveLength(1);
    const previewText = parseRawCall(previewCalls[0]!).text;
    expect(previewText).toContain("per_contact AS");
    expect(previewText).not.toContain("JOIN messages m");
    expect(
      h.queryRaw.mock.calls.filter((c) => parseRawCall(c).text.includes("contact_unread")).length,
    ).toBe(0);

    const cards = new Map(board.flatMap((s) => s.deals.map((d) => [d.id, d] as const)));

    // c1 (d01, etapa aberta): última é OUT "segue"; última do cliente "?";
    // unread 2 → 2 aguardando, das mais antigas para as mais novas.
    const d01 = cards.get("d01")!;
    expect(d01.lastMessage?.content).toBe("segue");
    expect(d01.lastMessage?.direction).toBe("out");
    expect(d01.lastMessage?.sendStatus).toBe("sent");
    expect(d01.lastInboundMessage?.content).toBe("?");
    expect(d01.unreadCount).toBe(2);
    expect(d01.channel).toBe("instagram");
    expect(d01.awaitingMessages.map((m) => m.content)).toEqual(["quero info", "?"]);

    // c2 (d02): última é IN sem content (mídia) → sem lastMessage nem
    // lastInbound; unread 0 → sem aguardando.
    const d02 = cards.get("d02")!;
    expect(d02.lastMessage).toBeNull();
    expect(d02.lastInboundMessage).toBeNull();
    expect(d02.awaitingMessages).toEqual([]);
    expect(d02.unreadCount).toBe(0);

    // c3 (d03): nota/evento/privada ignorados → última real é OUT "b";
    // unread 3 mas só 1 inbound elegível.
    const d03 = cards.get("d03")!;
    expect(d03.lastMessage?.content).toBe("b");
    expect(d03.lastInboundMessage?.content).toBe("a");
    expect(d03.unreadCount).toBe(3);
    expect(d03.awaitingMessages.map((m) => m.content)).toEqual(["a"]);

    // d04 sem contato: tudo vazio.
    const d04 = cards.get("d04")!;
    expect(d04.lastMessage).toBeNull();
    expect(d04.unreadCount).toBe(0);
    expect(d04.channel).toBeNull();
    expect(d04.awaitingMessages).toEqual([]);

    // c5 (d06): só uma IN e unread 0 → mantém a última no preview.
    const d06 = cards.get("d06")!;
    expect(d06.lastMessage?.direction).toBe("in");
    expect(d06.awaitingMessages.map((m) => m.content)).toEqual(["x"]);

    // c6 (d11, etapa Ganho): tem inbound e unread, mas etapa Ganho não
    // mostra "aguardando"; lastMessage continua preenchida.
    const d11 = cards.get("d11")!;
    expect(d11.lastMessage?.content).toBe("w2");
    expect(d11.lastInboundMessage?.content).toBe("w2");
    expect(d11.unreadCount).toBe(2);
    expect(d11.awaitingMessages).toEqual([]);

    // Contrato da etapa preservado.
    const s1 = board.find((s) => s.id === "s1")!;
    expect(s1.totalCount).toBe(6);
    expect(s1.loadedCount).toBe(6);
    expect(s1.hasMore).toBe(false);
    expect(s1.deals.map((d) => d.id)).toEqual(["d01", "d02", "d03", "d04", "d05", "d06"]);
    for (const d of s1.deals) {
      expect(d).toHaveProperty("isRotting");
      expect(d).toHaveProperty("productName");
      expect(d).toHaveProperty("pendingActivities");
      expect(d).toHaveProperty("hasOverdueActivity");
      expect(d.tags).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 6) Filtro de etapa: etapa filtrada fica sozinha
// ---------------------------------------------------------------------------

describe("board: filtro de etapa (stageIds)", () => {
  const stageWhere = { stageId: { in: ["s2"] } };
  const S2_BY_POSITION = ["d07", "d08", "d09", "d10"];

  it("getBoardData devolve só a coluna filtrada (consulta ranqueada)", async () => {
    vi.mocked(buildDealWhereFromFilters).mockResolvedValueOnce([stageWhere]);
    currentWhere = stageWhere;
    const board = await withOrg(() =>
      getBoardData(PIPELINE, null, "ALL", { stageIds: ["s2"] }, { perStage: 10 }),
    );
    expect(board.map((s) => s.id)).toEqual(["s2"]);
    expect(board[0]?.deals.map((d) => d.id)).toEqual(S2_BY_POSITION);
    expect(board[0]?.totalCount).toBe(4);

    // A janela recebe só a etapa escolhida; nada de findMany por etapa.
    const ranking = h.queryRaw.mock.calls
      .map((c) => parseRawCall(c))
      .find((c) => c.text.includes('PARTITION BY d."stageId"'));
    expect(ranking?.values[1]).toEqual(["s2"]);
    expect(findManyCalls()).toBe(1);
  });

  it("getBoardData com lastInteraction devolve só a coluna filtrada", async () => {
    vi.mocked(buildDealWhereFromFilters).mockResolvedValueOnce([stageWhere]);
    currentWhere = stageWhere;
    const board = await withOrg(() =>
      getBoardData(PIPELINE, null, "ALL", { stageIds: ["s2"] }, {
        perStage: 10,
        sortField: "lastInteraction",
        sortDirection: "desc",
      }),
    );
    expect(board.map((s) => s.id)).toEqual(["s2"]);
    expect(board[0]?.deals.map((d) => d.id).sort()).toEqual(S2_BY_POSITION);

    const ranking = h.queryRaw.mock.calls
      .map((c) => parseRawCall(c))
      .find((c) => c.text.includes("WITH candidates AS"));
    expect(ranking?.values[1]).toEqual(["s2"]);
  });

  it("fallback por etapa: o stageId da etapa não sobrescreve o do filtro", async () => {
    // Where de uma condição só (status ALL, sem visibilidade): com spread, o
    // `stageId` de cada etapa apagava o filtro e toda coluna vinha cheia.
    const res = await withOrg(() =>
      __boardInternal.loadBoardStagesPerStage(
        stagesRaw(),
        stageWhere,
        [{ position: "asc" }],
        10,
        {},
      ),
    );
    expect(res.map((s) => [s.id, s.deals.map((d) => d.id)])).toEqual([
      ["s1", []],
      ["s2", S2_BY_POSITION],
      ["s3", []],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5) Fila de concorrência do fallback
// ---------------------------------------------------------------------------

describe("mapWithConcurrency", () => {
  it("nunca passa do limite e preserva a ordem", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 11 }, (_, i) => i);
    const out = await __boardInternal.mapWithConcurrency(items, 4, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1 + ((i * 7) % 5)));
      inFlight -= 1;
      return i * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(peak).toBe(4);
    expect(__boardInternal.BOARD_STAGE_FALLBACK_CONCURRENCY).toBe(4);
  });

  it("lista vazia resolve sem chamar fn", async () => {
    const fn = vi.fn(async () => 1);
    expect(await __boardInternal.mapWithConcurrency([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
