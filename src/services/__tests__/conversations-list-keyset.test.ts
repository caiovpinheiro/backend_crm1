/**
 * P-14 — lista do inbox por cursor (keyset), sem Postgres.
 *
 * Três blocos:
 *   1. cursor: opaco (base64url), ida e volta, formato antigo `${ms}_${id}`
 *      ainda aceito, cursor de outra ordenação/ilegível recusado;
 *   2. SQL gerado (`prisma.$queryRaw` espião): com cursor não há OFFSET nem
 *      `DISTINCT ON` sobre o escopo inteiro; o `where` da lista (org,
 *      visibilidade) continua dentro da consulta; `page` antigo ainda
 *      funciona; a página 2 custa as mesmas consultas da página 1;
 *   3. comportamento, pelo caminho de lotes (o `where`/`orderBy` Prisma de
 *      verdade avaliado pelo banco falso de `@/test-setup/fake-db`): empate
 *      na chave, conversa que sobe entre páginas, colapso por contato+canal
 *      e visibilidade. O SQL usa o mesmo predicado (`listKeysetSql` ×
 *      `listKeysetWhere`), então a semântica vale para os dois caminhos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    queryRaw: vi.fn(),
    conversationFindMany: vi.fn(),
    orgSetting: vi.fn().mockResolvedValue(null as string | null),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    conversation: {
      findMany: h.conversationFindMany,
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    automationContext: { findMany: vi.fn().mockResolvedValue([]) },
    contact: { count: vi.fn() },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  },
  allocateOrgNumber: vi.fn(),
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/activity-log", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  userIdForFk: (v: unknown) => v ?? null,
}));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingFor: h.orgSetting,
  getOrgSetting: vi.fn().mockResolvedValue(null),
  getOrgSettingBool: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/services/channels", () => ({
  parseInboxFilterChannelIds: (ids: string[]) => ({ ids, missing: [], deleted: false }),
}));
vi.mock("@/services/kanban-filters", () => ({
  SOURCE_NONE: "__none__",
  findContactIdsByPhoneDigits: vi.fn().mockResolvedValue([]),
  resolveConversationSearchCandidates: vi.fn(async () => ({
    contactIds: [],
    assignedToIds: [],
  })),
}));
vi.mock("@/lib/contact-avatar-fallback", () => ({
  enrichContactsWithUserAvatarFallback: vi.fn(async (c: unknown[]) => c),
}));
vi.mock("@/services/ai/agent-vertical", () => ({
  resolveAgentVerticalForConversation: vi.fn(),
}));
vi.mock("@/services/distribution/pending", () => ({
  scheduleProcessPendingDistributionQueue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ai-agents/tabulation-classifier", () => ({
  isTabulationClassifier: () => false,
}));
vi.mock("@/lib/ai-agents/farewell-closer", () => ({
  isFarewellCloser: () => false,
}));
vi.mock("@/services/deals", () => ({
  clearContactOwnershipOnClose: vi.fn().mockResolvedValue(undefined),
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Prisma } from "@prisma/client";

import { decodeOpaqueCursor } from "@/lib/pagination/opaque-cursor";
import { runWithContext } from "@/lib/request-context";
import {
  InvalidListCursorError,
  encodeListCursor,
  listKeysetWhere,
  listSortColumnSql,
  parseListCursor,
} from "@/services/conversation-list-cursor";
import { getConversations } from "@/services/conversations";
import { FakeDb, INBOX_SCHEMA } from "@/test-setup/fake-db";

const ORG = "org-a";
/** Chave padrão da lista no SQL (alias `c`). */
const KEY_SQL = `COALESCE(c."lastMessageAt", c."updatedAt")`;
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const at = (sec: number) => new Date(T0 + sec * 1000);

/** Cursor no formato da versão anterior (v1), como o frontend guarda hoje. */
function v1Cursor(k: string, when: Date, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k, s: when.getTime(), i: id })).toString(
    "base64url",
  );
}

function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: ORG, userId: "user-1", isSuperAdmin: false },
    fn,
  ) as Promise<T>;
}

/** `$queryRaw` recebe um template (strings, ...values) ou um `Prisma.Sql`. */
function rawOf(call: unknown[]): { text: string; values: unknown[] } {
  const [first, ...rest] = call as [TemplateStringsArray | Prisma.Sql, ...unknown[]];
  if (Array.isArray(first)) return { text: first.join("?"), values: rest };
  const sql = first as Prisma.Sql;
  return { text: sql.strings.join("?"), values: [...sql.values] };
}

/** A consulta que pagina os IDs da lista (as demais são prévia/enriquecimento). */
function isListPageSql(text: string): boolean {
  return /SELECT (c|o|reps)\.id\s+FROM/.test(text);
}

function listPageCalls() {
  return h.queryRaw.mock.calls.map(rawOf).filter((c) => isListPageSql(c.text));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.orgSetting.mockResolvedValue(null);
  h.queryRaw.mockResolvedValue([]);
  h.conversationFindMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// 1. Cursor
// ---------------------------------------------------------------------------

describe("cursor da lista", () => {
  it("é opaco (base64url de JSON) e faz ida e volta sem perder o milissegundo", () => {
    const when = new Date("2026-09-30T12:34:56.789Z");
    const raw = encodeListCursor("updatedAt", when, "cmconv123")!;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw).not.toContain("cmconv123");
    expect(decodeOpaqueCursor(raw)).toEqual({
      v: 2,
      k: "updatedAt",
      s: when.getTime(),
      i: "cmconv123",
    });
    expect(parseListCursor(raw, "updatedAt")).toEqual({ sortVal: when, id: "cmconv123" });
  });

  it("unreadCount viaja como número", () => {
    const raw = encodeListCursor("unreadCount", 7, "c1")!;
    expect(parseListCursor(raw, "unreadCount")).toEqual({ sortVal: 7, id: "c1" });
  });

  it("aceita o formato antigo `${ms}_${id}` (cliente com cursor do backend anterior)", () => {
    const ms = at(10).getTime();
    expect(parseListCursor(`${ms}_cmabc`, "updatedAt")).toEqual({
      sortVal: new Date(ms),
      id: "cmabc",
    });
    expect(parseListCursor("3_cmabc", "unreadCount")).toEqual({ sortVal: 3, id: "cmabc" });
  });

  it("recusa cursor de outra ordenação, de outra versão e lixo", () => {
    const raw = encodeListCursor("updatedAt", at(1), "c1")!;
    expect(parseListCursor(raw, "createdAt")).toBeNull();
    // v2 de `updatedAt` não serve para a chave padrão (só o v1 da transição)
    expect(parseListCursor(raw, "lastMessageAt")).toBeNull();
    expect(parseListCursor("nao-e-cursor", "updatedAt")).toBeNull();
    expect(parseListCursor("", "updatedAt")).toBeNull();
    expect(parseListCursor(undefined, "updatedAt")).toBeNull();
    const v3 = Buffer.from(JSON.stringify({ v: 3, k: "updatedAt", s: 1, i: "x" })).toString(
      "base64url",
    );
    expect(parseListCursor(v3, "updatedAt")).toBeNull();
  });

  it("chave padrão: cursor v2 de `lastMessageAt`", () => {
    const when = at(42);
    const raw = encodeListCursor("lastMessageAt", when, "c9")!;
    expect(decodeOpaqueCursor(raw)).toEqual({
      v: 2,
      k: "lastMessageAt",
      s: when.getTime(),
      i: "c9",
    });
    expect(parseListCursor(raw, "lastMessageAt")).toEqual({ sortVal: when, id: "c9" });
    expect(parseListCursor(raw, "updatedAt")).toBeNull();
  });

  it("aceita o v1 por uma versão — inclusive o de `updatedAt` na chave padrão (cursor que o frontend tinha no deploy)", () => {
    expect(parseListCursor(v1Cursor("updatedAt", at(7), "a"), "updatedAt")).toEqual({
      sortVal: at(7),
      id: "a",
    });
    expect(parseListCursor(v1Cursor("updatedAt", at(7), "a"), "lastMessageAt")).toEqual({
      sortVal: at(7),
      id: "a",
    });
    expect(parseListCursor(v1Cursor("createdAt", at(7), "a"), "lastMessageAt")).toBeNull();
    // o texto puro anterior ao v1 também
    expect(parseListCursor(`${at(8).getTime()}_b`, "lastMessageAt")).toEqual({
      sortVal: at(8),
      id: "b",
    });
  });

  it("getConversations com cursor ilegível lança InvalidListCursorError (a rota responde 400)", async () => {
    await expect(
      withOrg(() => getConversations({ tab: "entrada", cursor: "###" })),
    ).rejects.toBeInstanceOf(InvalidListCursorError);
    expect(listPageCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. SQL gerado
// ---------------------------------------------------------------------------

describe("SQL da página (keyset)", () => {
  const cursorAt = at(100);
  const cursor = () => encodeListCursor("lastMessageAt", cursorAt, "conv-050")!;

  it("a chave padrão é a mesma expressão dos índices da migration (senão o índice não é usado)", () => {
    const expr = listSortColumnSql("lastMessageAt").strings.join("?");
    expect(expr).toBe(KEY_SQL);
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20261003150000_conversations_last_message_at/migration.sql",
      ),
      "utf8",
    );
    const sql = migration
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    const indexExpr = KEY_SQL.replaceAll("c.", "");
    expect(sql).toContain(`("organizationId", (${indexExpr}) DESC, "id" DESC)`);
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
    expect(sql).toMatch(/WHERE "status" = 'OPEN'/);
  });

  it("fila quente com cursor: comparação de linha (chave, id), sem OFFSET, LIMIT perPage+1", async () => {
    await withOrg(() => getConversations({ tab: "entrada", perPage: 50, cursor: cursor() }));
    const [call] = listPageCalls();
    expect(call).toBeDefined();
    expect(call!.text).toContain(`(${KEY_SQL}, c.id) < (?, ?)`);
    expect(call!.text).toContain(`ORDER BY ${KEY_SQL} DESC, c.id DESC`);
    expect(call!.text).not.toMatch(/OFFSET/i);
    expect(call!.text).not.toMatch(/DISTINCT ON/i);
    // Valores do cursor e do LIMIT viajam como parâmetros, nunca no texto.
    expect(call!.values).toContainEqual(cursorAt);
    expect(call!.values).toContain("conv-050");
    expect(call!.values[call!.values.length - 1]).toBe(51);
    expect(call!.text).not.toContain("conv-050");
  });

  it("ordem crescente inverte o operador", async () => {
    await withOrg(() =>
      getConversations({ tab: "entrada", sortOrder: "asc", cursor: cursor() }),
    );
    const [call] = listPageCalls();
    expect(call!.text).toContain(`(${KEY_SQL}, c.id) > (?, ?)`);
    expect(call!.text).toContain(`ORDER BY ${KEY_SQL} ASC, c.id ASC`);
  });

  it("`sortBy=updatedAt` explícito continua ordenando pela coluna (picker de encaminhar)", async () => {
    const raw = encodeListCursor("updatedAt", cursorAt, "conv-050")!;
    await withOrg(() => getConversations({ tab: "entrada", sortBy: "updatedAt", cursor: raw }));
    const [call] = listPageCalls();
    expect(call!.text).toMatch(/\(c\."updatedAt", c\.id\) < \(\?, \?\)/);
    expect(call!.text).toMatch(/ORDER BY c\."updatedAt" DESC, c\.id DESC/);
    expect(call!.text).not.toContain("lastMessageAt");
  });

  it("cursor v1 de `updatedAt` (frontend no deploy) vira limite na chave nova — sem 400", async () => {
    await withOrg(() =>
      getConversations({ tab: "entrada", cursor: v1Cursor("updatedAt", cursorAt, "conv-050") }),
    );
    const [call] = listPageCalls();
    expect(call!.text).toContain(`(${KEY_SQL}, c.id) < (?, ?)`);
    expect(call!.values).toContainEqual(cursorAt);
    expect(call!.values).toContain("conv-050");
  });

  it("Encerradas com cursor: representante por NOT EXISTS — sem OFFSET e sem DISTINCT ON no escopo inteiro", async () => {
    await withOrg(() => getConversations({ tab: "finalizados", cursor: cursor() }));
    const [call] = listPageCalls();
    expect(call).toBeDefined();
    expect(call!.text).not.toMatch(/OFFSET/i);
    expect(call!.text).not.toMatch(/DISTINCT ON/i);
    expect(call!.text).toMatch(/NOT EXISTS/);
    // o cursor limita a leitura DENTRO do select de conversas…
    expect(call!.text).toContain(`(${KEY_SQL}, c.id) < (?, ?)`);
    // …e a irmã "melhor" do mesmo contato+canal é a mais nova.
    expect(call!.text).toContain(`(${KEY_SQL}, c.id) > (o.sort_val, o.id)`);
    expect(call!.text).toMatch(/c\."contactId" = o\.contact_id/);
  });

  it("escopo preservado: org do contexto e visibilidade entram na consulta externa E na subconsulta", async () => {
    const visibilityWhere = { assignedToId: { in: ["user-1"] } };
    await withOrg(() =>
      getConversations({ tab: "finalizados", cursor: cursor(), visibilityWhere }),
    );
    const [call] = listPageCalls();
    expect(call!.values.filter((v) => v === ORG)).toHaveLength(2);
    expect(call!.values.filter((v) => v === "user-1")).toHaveLength(2);
    expect(call!.text.match(/c\."assignedToId"/g)?.length).toBe(2);

    h.queryRaw.mockClear();
    await withOrg(() => getConversations({ tab: "entrada", cursor: cursor(), visibilityWhere }));
    const [hot] = listPageCalls();
    expect(hot!.values).toContain(ORG);
    expect(hot!.values).toContain("user-1");
  });

  it("1ª página não usa OFFSET; `page` antigo (sem cursor) continua aceito e é o único caminho com OFFSET", async () => {
    await withOrg(() => getConversations({ tab: "entrada" }));
    expect(listPageCalls()[0]!.text).not.toMatch(/OFFSET/i);

    h.queryRaw.mockClear();
    await withOrg(() => getConversations({ tab: "entrada", page: 3, perPage: 20 }));
    const legacy = listPageCalls()[0]!;
    expect(legacy.text).toMatch(/OFFSET \?/);
    expect(legacy.values).toContain(40);

    h.queryRaw.mockClear();
    await withOrg(() => getConversations({ tab: "finalizados", page: 2, perPage: 20 }));
    const legacyCollapsed = listPageCalls()[0]!;
    expect(legacyCollapsed.text).toMatch(/DISTINCT ON/);
    expect(legacyCollapsed.text).toMatch(/OFFSET \?/);
  });

  it("cursor vence `page`: com os dois, nada de OFFSET", async () => {
    await withOrg(() => getConversations({ tab: "entrada", page: 4, cursor: cursor() }));
    expect(listPageCalls()[0]!.text).not.toMatch(/OFFSET/i);
  });

  it("a página 2 por cursor custa as mesmas consultas da página 1", async () => {
    const row = (id: string, sec: number) => ({
      id,
      updatedAt: at(sec),
      createdAt: at(sec),
      unreadCount: 0,
      lastInboundAt: null,
      contact: null,
    });
    const count = async (params: Parameters<typeof getConversations>[0]) => {
      h.queryRaw.mockClear();
      h.conversationFindMany.mockClear();
      h.queryRaw.mockImplementation(async (...call: unknown[]) =>
        isListPageSql(rawOf(call).text) ? [{ id: "a" }, { id: "b" }, { id: "c" }] : [],
      );
      h.conversationFindMany.mockImplementation(async (args: { where?: { id?: unknown } }) =>
        args?.where?.id ? [row("a", 3), row("b", 2)] : [],
      );
      const page = await withOrg(() => getConversations({ ...params, perPage: 2 }));
      return {
        page,
        raw: h.queryRaw.mock.calls.length,
        listPages: listPageCalls().length,
        findMany: h.conversationFindMany.mock.calls.length,
      };
    };

    const first = await count({ tab: "entrada" });
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toBeTruthy();
    expect(parseListCursor(first.page.nextCursor, "lastMessageAt")).toEqual({
      sortVal: at(2),
      id: "b",
    });

    const second = await count({ tab: "entrada", cursor: first.page.nextCursor! });
    expect(second.listPages).toBe(1);
    expect(second.raw).toBe(first.raw);
    expect(second.findMany).toBe(first.findMany);

    // A chave nova custa exatamente as consultas da ordem antiga (`updatedAt`).
    const oldKey = await count({ tab: "entrada", sortBy: "updatedAt" });
    expect(oldKey.raw).toBe(first.raw);
    expect(oldKey.findMany).toBe(first.findMany);

    // total/page em modo cursor: nunca perPage+1 nem `page: 1` inventado.
    expect(first.page.total).toBeNull();
    expect(first.page.page).toBe(1);
    expect(second.page.total).toBeNull();
    expect(second.page.page).toBeNull();

    const firstClosed = await count({ tab: "finalizados" });
    const secondClosed = await count({
      tab: "finalizados",
      cursor: firstClosed.page.nextCursor!,
    });
    expect(secondClosed.listPages).toBe(1);
    expect(secondClosed.raw).toBe(firstClosed.raw);
    expect(secondClosed.findMany).toBe(firstClosed.findMany);
  });
});

// ---------------------------------------------------------------------------
// 3. Comportamento (caminho de lotes + banco falso)
// ---------------------------------------------------------------------------

type ConvRow = {
  id: string;
  organizationId: string;
  contactId: string | null;
  channel: string | null;
  channelId: string | null;
  status: "OPEN" | "RESOLVED";
  closedAt: Date | null;
  followUpAt: Date | null;
  assignedToId: string | null;
  unreadCount: number;
  lastInboundAt: Date | null;
  lastMessageAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
};

function conv(id: string, sec: number, extra: Partial<ConvRow> = {}): ConvRow {
  return {
    id,
    organizationId: ORG,
    contactId: null,
    channel: "whatsapp",
    channelId: "ch_1",
    status: "OPEN",
    closedAt: null,
    followUpAt: null,
    assignedToId: "user-1",
    unreadCount: 0,
    lastInboundAt: null,
    lastMessageAt: null,
    updatedAt: at(sec),
    createdAt: at(sec),
    ...extra,
  };
}

function closed(id: string, sec: number, contactId: string | null, extra: Partial<ConvRow> = {}) {
  return conv(id, sec, { status: "RESOLVED", closedAt: at(sec), contactId, ...extra });
}

/**
 * Liga o `prisma.conversation.findMany` ao banco falso e faz o SQL da
 * página falhar — `getConversations` cai no caminho de lotes, que usa o
 * `where`/`orderBy`/keyset Prisma de verdade.
 */
function useFakeDb(rows: ConvRow[]) {
  const db = new FakeDb(INBOX_SCHEMA);
  db.insert("conversation", ...rows);
  const scans: { where: unknown; take?: number; skip?: number }[] = [];
  h.conversationFindMany.mockImplementation(async (args: Record<string, unknown>) => {
    if (args.orderBy) scans.push(args as (typeof scans)[number]);
    return db.run("conversation", "findMany", args);
  });
  h.queryRaw.mockImplementation(async (...call: unknown[]) => {
    if (isListPageSql(rawOf(call).text)) throw new Error("sem SQL cru neste teste");
    return [];
  });
  return { db, scans };
}

async function readAll(
  params: Parameters<typeof getConversations>[0],
  between?: (pageIndex: number) => void,
) {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i += 1) {
    const page = await withOrg(() => getConversations({ ...params, cursor }));
    pages.push(page.items.map((it) => it.id));
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
    between?.(i);
  }
  return pages;
}

describe("paginação por cursor — comportamento", () => {
  it("empate na chave: páginas seguintes não repetem nem pulam (id desempata)", async () => {
    // 7 conversas, 5 delas no MESMO milissegundo, cortando no meio do empate.
    const rows = [
      conv("c-9", 50),
      conv("c-e", 40),
      conv("c-d", 40),
      conv("c-c", 40),
      conv("c-b", 40),
      conv("c-a", 40),
      conv("c-0", 10),
    ];
    const { scans } = useFakeDb(rows);
    const pages = await readAll({ perPage: 3 });
    expect(pages).toEqual([
      ["c-9", "c-e", "c-d"],
      ["c-c", "c-b", "c-a"],
      ["c-0"],
    ]);
    // nenhuma varredura usa skip/OFFSET
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((s) => s.skip === undefined)).toBe(true);
  });

  it("ordem crescente com empate", async () => {
    useFakeDb([conv("a", 10), conv("b", 10), conv("c", 10), conv("d", 20)]);
    const pages = await readAll({ perPage: 2, sortOrder: "asc" });
    expect(pages).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("conversa que sobe para o topo entre páginas: não duplica; as paradas não são puladas", async () => {
    const rows = [
      conv("c6", 60),
      conv("c5", 50),
      conv("c4", 40),
      conv("c3", 30),
      conv("c2", 20),
      conv("c1", 10),
    ];
    const { db } = useFakeDb(rows);
    const bump = (id: string, sec: number) => {
      const row = db.table("conversation").find((r) => r.id === id)!;
      row.updatedAt = at(sec);
    };
    const pages = await readAll({ perPage: 2 }, (pageIndex) => {
      if (pageIndex !== 0) return;
      // Depois da página 1 (c6, c5): chega mensagem em c5 (já listada) e em
      // c2 (ainda não listada). As duas passam a ter chave acima do cursor.
      bump("c5", 100);
      bump("c2", 101);
    });
    const flat = pages.flat();
    // sem duplicata
    expect(new Set(flat).size).toBe(flat.length);
    // c5 não reaparece; c2 subiu para antes do cursor e fica para o SSE /
    // recarga da 1ª página (documentado em conversation-list-cursor.ts)
    expect(pages).toEqual([["c6", "c5"], ["c4", "c3"], ["c1"]]);
    // quem ficou parado (c4, c3, c1) veio inteiro e na ordem
    expect(flat.filter((id) => ["c4", "c3", "c1"].includes(id))).toEqual(["c4", "c3", "c1"]);

    // a recarga da 1ª página mostra as que subiram, na nova ordem
    const top = await withOrg(() => getConversations({ perPage: 2 }));
    expect(top.items.map((it) => it.id)).toEqual(["c2", "c5"]);
  });

  it("Encerradas: 1 card por contato+canal, sem repetir grupo já mostrado numa página anterior", async () => {
    const rows = [
      closed("a3", 90, "ct-a"),
      closed("b2", 80, "ct-b"),
      closed("a2", 70, "ct-a"), // irmã mais velha de a3 → nunca é card
      closed("c1", 60, "ct-c"),
      closed("b1", 50, "ct-b"), // irmã mais velha de b2
      closed("d1", 40, "ct-d"),
      closed("a1", 30, "ct-a"),
      closed("e1", 20, null), // sem contato: cada conversa é um grupo
      closed("f1", 10, null),
      // mesmo contato, OUTRO canal → card próprio
      closed("a-ig", 5, "ct-a", { channel: "instagram" }),
    ];
    const { scans } = useFakeDb(rows);
    const pages = await readAll({ tab: "finalizados", perPage: 2 });
    expect(pages).toEqual([
      ["a3", "b2"],
      ["c1", "d1"],
      ["e1", "f1"],
      ["a-ig"],
    ]);
    expect(scans.every((s) => s.skip === undefined)).toBe(true);
  });

  it("Encerradas com empate na chave entre representantes", async () => {
    const rows = [
      closed("r4", 40, "ct-4"),
      closed("r3", 40, "ct-3"),
      closed("r2", 40, "ct-2"),
      closed("r1", 40, "ct-1"),
      closed("x3", 39, "ct-3"),
    ];
    useFakeDb(rows);
    const pages = await readAll({ tab: "finalizados", perPage: 2 });
    expect(pages).toEqual([["r4", "r3"], ["r2", "r1"]]);
  });

  it("Encerradas: contato reaberto e encerrado de novo entre páginas não duplica o card", async () => {
    const rows = [
      closed("p3", 90, "ct-p"),
      closed("q1", 80, "ct-q"),
      closed("r1", 70, "ct-r"),
      closed("s1", 60, "ct-s"),
    ];
    const { db } = useFakeDb(rows);
    const pages = await readAll({ tab: "finalizados", perPage: 2 }, (pageIndex) => {
      if (pageIndex !== 0) return;
      // novo ticket encerrado do contato r (ainda não listado): sobe para o topo
      db.insert("conversation", closed("r2", 200, "ct-r"));
    });
    // r1 deixou de ser o representante do grupo (r2 é mais novo e está antes
    // do cursor) → o grupo não aparece na página 2; nada duplica.
    expect(pages).toEqual([["p3", "q1"], ["s1"]]);
  });

  it("visibilidade preservada em todas as páginas", async () => {
    const rows = [
      conv("mine-3", 60),
      conv("other-2", 50, { assignedToId: "user-2" }),
      conv("mine-2", 40),
      conv("other-1", 30, { assignedToId: "user-2" }),
      conv("mine-1", 20),
      conv("foreign", 10, { organizationId: "org-b" }),
    ];
    useFakeDb(rows);
    const pages = await readAll({
      perPage: 1,
      visibilityWhere: { organizationId: ORG, assignedToId: { in: ["user-1"] } },
    });
    expect(pages).toEqual([["mine-3"], ["mine-2"], ["mine-1"]]);
  });

  it("`page` antigo no caminho de lotes: mesmas páginas, sem skip", async () => {
    const rows = [conv("c4", 40), conv("c3", 30), conv("c2", 20), conv("c1", 10)];
    const { scans } = useFakeDb(rows);
    const p2 = await withOrg(() => getConversations({ perPage: 2, page: 2 }));
    expect(p2.items.map((it) => it.id)).toEqual(["c2", "c1"]);
    expect(scans.every((s) => s.skip === undefined)).toBe(true);
  });
});

describe("chave padrão (última mensagem) — comportamento", () => {
  /** Conversa com mensagem de chat em `msgSec` e `updatedAt` em `updSec`. */
  const withMsg = (id: string, msgSec: number, updSec = msgSec, extra: Partial<ConvRow> = {}) =>
    conv(id, updSec, { lastMessageAt: at(msgSec), ...extra });

  it("empate na última mensagem: o id desempata; `updatedAt` não entra na ordem", async () => {
    useFakeDb([
      withMsg("m-9", 50, 1),
      withMsg("m-e", 40, 900), // lida/atribuída depois: updatedAt alto
      withMsg("m-d", 40, 2),
      withMsg("m-c", 40, 800),
      withMsg("m-b", 40, 3),
      withMsg("m-0", 10, 999),
    ]);
    const pages = await readAll({ perPage: 2 });
    expect(pages).toEqual([["m-9", "m-e"], ["m-d", "m-c"], ["m-b", "m-0"]]);
  });

  it("conversa que recebe mensagem sobe; entre páginas não duplica nem pula as paradas", async () => {
    const { db } = useFakeDb([
      withMsg("c6", 60),
      withMsg("c5", 50),
      withMsg("c4", 40),
      withMsg("c3", 30),
      withMsg("c2", 20),
      withMsg("c1", 10),
    ]);
    const newMessage = (id: string, sec: number) => {
      const row = db.table("conversation").find((r) => r.id === id)!;
      row.lastMessageAt = at(sec);
      row.updatedAt = at(sec);
    };
    const pages = await readAll({ perPage: 2 }, (pageIndex) => {
      if (pageIndex === 0) newMessage("c2", 100);
    });
    const flat = pages.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(pages).toEqual([["c6", "c5"], ["c4", "c3"], ["c1"]]);

    const top = await withOrg(() => getConversations({ perPage: 2 }));
    expect(top.items.map((it) => it.id)).toEqual(["c2", "c6"]);
  });

  it("ler ou atribuir (só `updatedAt`/responsável mudam) NÃO muda a ordem", async () => {
    const { db } = useFakeDb([
      withMsg("a", 50),
      withMsg("b", 40),
      withMsg("c", 30),
      withMsg("d", 20),
    ]);
    const before = (await readAll({ perPage: 2 })).flat();
    expect(before).toEqual(["a", "b", "c", "d"]);
    // POST /read e atribuição: unreadCount, responsável e @updatedAt
    for (const id of ["d", "c"]) {
      const row = db.table("conversation").find((r) => r.id === id)!;
      row.updatedAt = at(10_000);
      row.unreadCount = 0;
      row.assignedToId = "user-1";
    }
    const after = (await readAll({ perPage: 2 })).flat();
    expect(after).toEqual(before);
  });

  it("coluna NULL (antes do backfill / sem mensagem de chat) cai no `updatedAt`, intercalada pela chave", async () => {
    useFakeDb([
      withMsg("a", 50),
      conv("b-null", 45),
      withMsg("c", 40, 99), // updatedAt alto não puxa para cima
      conv("d-null", 30),
      withMsg("e", 30), // empate com d-null na chave → id desempata
      conv("f-null", 5),
    ]);
    const pages = await readAll({ perPage: 2 });
    expect(pages).toEqual([["a", "b-null"], ["c", "e"], ["d-null", "f-null"]]);
  });

  it("cursor v1 de `updatedAt` (frontend no deploy) continua a paginação na chave nova", async () => {
    useFakeDb([withMsg("a", 50), conv("b-null", 45), withMsg("c", 40), conv("d-null", 30)]);
    const page = await withOrg(() =>
      getConversations({ perPage: 2, cursor: v1Cursor("updatedAt", at(45), "b-null") }),
    );
    expect(page.items.map((it) => it.id)).toEqual(["c", "d-null"]);
    expect(page.page).toBeNull();
  });

  it("Encerradas: representante do contato+canal é o de mensagem mais nova", async () => {
    useFakeDb([
      closed("x-old", 10, "ct-x", { lastMessageAt: at(90) }),
      closed("x-new", 95, "ct-x", { lastMessageAt: at(20) }), // encerrado depois, mensagem antiga
      closed("y", 50, "ct-y", { lastMessageAt: at(50) }),
    ]);
    const pages = await readAll({ tab: "finalizados", perPage: 1 });
    expect(pages).toEqual([["x-old"], ["y"]]);
  });
});

describe("listKeysetWhere", () => {
  it("chave padrão: o complemento (NOT) também é exato com NULL", () => {
    const db = new FakeDb(INBOX_SCHEMA);
    const rows = [
      conv("a", 10, { lastMessageAt: at(10) }),
      conv("b", 20),
      conv("c", 99, { lastMessageAt: at(20) }),
      conv("d", 30),
    ];
    db.insert("conversation", ...rows);
    const cursor = { sortVal: at(20), id: "c" };
    const after = db.run("conversation", "findMany", {
      where: listKeysetWhere("lastMessageAt", cursor, "desc"),
    }) as ConvRow[];
    const upTo = db.run("conversation", "findMany", {
      where: { NOT: listKeysetWhere("lastMessageAt", cursor, "desc") },
    }) as ConvRow[];
    expect(after.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(upTo.map((r) => r.id).sort()).toEqual(["c", "d"]);
  });

  it("o complemento (NOT) é exatamente 'até o cursor, inclusive'", () => {
    const db = new FakeDb(INBOX_SCHEMA);
    const rows = [conv("a", 10), conv("b", 20), conv("c", 20), conv("d", 30)];
    db.insert("conversation", ...rows);
    const cursor = { sortVal: at(20), id: "c" };
    const after = db.run("conversation", "findMany", {
      where: listKeysetWhere("updatedAt", cursor, "desc"),
    }) as ConvRow[];
    const upTo = db.run("conversation", "findMany", {
      where: { NOT: listKeysetWhere("updatedAt", cursor, "desc") },
    }) as ConvRow[];
    expect(after.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(upTo.map((r) => r.id).sort()).toEqual(["c", "d"]);
  });
});
