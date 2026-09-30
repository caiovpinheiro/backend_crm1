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
 *   5) o fallback limita a concorrência a 4.
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
  buildDealWhereFromFilters: vi.fn(async () => []),
}));

import { runWithContext } from "@/lib/request-context";
import {
  __boardInternal,
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
};
const CONVS: ConvRow[] = [
  { id: "v1", contactId: "c1", channel: "whatsapp", unreadCount: 1, updatedAt: at(50) },
  { id: "v2", contactId: "c1", channel: "instagram", unreadCount: 1, updatedAt: at(60) },
  { id: "v3", contactId: "c2", channel: "whatsapp", unreadCount: 0, updatedAt: at(40) },
  { id: "v4", contactId: "c3", channel: "whatsapp", unreadCount: 3, updatedAt: at(70) },
  { id: "v5", contactId: "c5", channel: "whatsapp", unreadCount: 0, updatedAt: at(30) },
  { id: "v6", contactId: "c6", channel: "whatsapp", unreadCount: 2, updatedAt: at(80) },
];

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

function lastConvAtByContact(): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of CONVS) {
    m.set(c.contactId, Math.max(m.get(c.contactId) ?? -Infinity, c.updatedAt.getTime()));
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
  const out: { id: string; stageId: string; rn: number }[] = [];
  for (const [stageId, ds] of byStage) {
    ds.sort(cmp).forEach((d, i) => {
      if (i + 1 <= maxPerStage) out.push({ id: d.id, stageId, rn: i + 1 });
    });
  }
  // Embaralha de propósito: o código não pode depender da ordem física.
  return out.reverse();
}

function emulateRaw(call: unknown[]): unknown[] {
  const { text, values } = parseRawCall(call);

  if (text.includes("WITH candidates AS")) {
    // lastInteraction: values = [org, stageIds, ...where, org(lateral), scanCap, maxPerStage]
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
    );
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

  if (text.includes('MAX("updatedAt") AS last_at')) {
    const contactIds = values[1] as string[];
    const last = lastConvAtByContact();
    return contactIds
      .filter((c) => last.has(c))
      .map((c) => ({ contactId: c, last_at: new Date(last.get(c) as number) }));
  }

  if (text.includes("FROM deal_products")) return [];

  if (text.includes("contact_unread")) {
    const contactIds = values[0] as string[];
    const out: { contactId: string; channel: string | null; unreadCount: number }[] = [];
    for (const c of contactIds) {
      const convs = CONVS.filter((v) => v.contactId === c);
      if (convs.length === 0) continue;
      const latest = [...convs].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      out.push({
        contactId: c,
        channel: latest?.channel ?? null,
        unreadCount: convs.reduce((s, v) => s + v.unreadCount, 0),
      });
    }
    return out;
  }

  if (text.includes('PARTITION BY c."contactId", m.direction')) {
    const contactIds = values[0] as string[];
    const cap = values[values.length - 1] as number;
    const convByid = new Map(CONVS.map((v) => [v.id, v]));
    const rows = MESSAGES.filter((m) => {
      const conv = convByid.get(m.conversationId);
      return (
        conv &&
        contactIds.includes(conv.contactId) &&
        !m.isPrivate &&
        (m.direction === "in" || m.direction === "out") &&
        !CARD_EXCLUDED_TYPES.has(m.messageType) &&
        !m.messageType.startsWith("event")
      );
    });
    const groups = new Map<string, MsgRow[]>();
    for (const m of rows) {
      const key = `${convByid.get(m.conversationId)?.contactId}|${m.direction}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    const out: unknown[] = [];
    for (const [key, ms] of groups) {
      const contactId = key.split("|")[0] as string;
      ms.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id < a.id ? -1 : 1));
      ms.forEach((m, i) => {
        const rn = i + 1;
        if (rn > (m.direction === "in" ? cap : 1)) return;
        out.push({
          contactId,
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
      expect(rawCalls()).toBe(1); // GROUP BY de conversas

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

  it("where não traduzível cai no fallback (findMany por etapa, concorrência limitada)", async () => {
    const where: Prisma.DealWhereInput = { AND: [{ status: "OPEN" }, { tags: { none: {} } }] };
    currentWhere = where as AnyWhere;
    expect(translateDealWhereToSql(where)).toBeNull();
    const res = await withOrg(() =>
      __boardInternal.loadBoardStagesByLastInteraction(PIPELINE, where, 2, {}, "desc"),
    );
    expect(findManyCalls()).toBe(STAGES.length + 1);
    expect(res.reduce((n, s) => n + s.deals.length, 0)).toBeGreaterThan(0);
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
    expect(translateDealWhereToSql({ tags: { some: { tagId: "t1" } } })).toBeNull();
    expect(translateDealWhereToSql({ contact: { is: { phone: { not: null } } } })).toBeNull();
    expect(translateDealWhereToSql({ ownerId: { not: "u1" } })).toBeNull();
    expect(translateDealWhereToSql({ NOT: { status: "OPEN" } })).toBeNull();
    expect(translateDealWhereToSql({ AND: [{ status: "OPEN" }, { title: { contains: "x" } }] })).toBeNull();
    expect(translateDealWhereToSql({ stage: { name: "x" } })).toBeNull();
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
    expect(text).toContain("ORDER BY li.last_at DESC NULLS LAST");
    expect(text).not.toContain("org-x");
    expect(sql.values).toEqual(["org-x", ["s1"], "OPEN", "org-x", 2500, 100]);
    const asc = buildLastInteractionRankedSql({
      orgId: "o",
      stageIds: ["s1"],
      whereSql: Prisma.sql`TRUE`,
      direction: "asc",
      scanCap: 1,
      maxPerStage: 1,
    });
    expect(asc.strings.join("?")).toContain("ORDER BY li.last_at ASC NULLS LAST");
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
    // Consultas do miss: 1 stages + 1 ranking + 1 hidratação + 1 groupBy +
    // 3 raws (produtos, conversas, mensagens).
    expect(h.stageFindMany).toHaveBeenCalledTimes(1);
    expect(findManyCalls()).toBe(1);
    expect(h.dealGroupBy).toHaveBeenCalledTimes(1);
    expect(rawCalls()).toBe(4);
    const msgCall = h.queryRaw.mock.calls.find((c) =>
      parseRawCall(c).text.includes('PARTITION BY c."contactId", m.direction'),
    );
    expect(msgCall).toBeDefined();
    // Uma única varredura em messages (não há mais last_msg/last_in/awaiting).
    expect(
      h.queryRaw.mock.calls.filter((c) => parseRawCall(c).text.includes("FROM messages")).length,
    ).toBe(0);
    expect(
      h.queryRaw.mock.calls.filter((c) => parseRawCall(c).text.includes("JOIN messages m")).length,
    ).toBe(1);

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
