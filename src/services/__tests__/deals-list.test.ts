/**
 * Lista de negócios (`getDeals`, GET /api/deals).
 *
 * K1 — `lastInteractionAt` sai de `contacts.lastMessageAt` (já no include da
 * lista); `conversations` só é consultada para os contatos com a coluna NULL.
 * K5 — `hasMore` por uma linha a mais; `COUNT(*)` só quando o cliente não
 * abriu mão dele (`withTotal: false`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  return {
    queryRaw: vi.fn(),
    dealFindMany: vi.fn(),
    dealCount: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    deal: { findMany: h.dealFindMany, count: h.dealCount },
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
vi.mock("@/services/analytics", () => ({ getStageMetrics: vi.fn(async () => []) }));
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
import { getDeals } from "@/services/deals";

const ORG = "org-list";
const at = (min: number) => new Date(Date.UTC(2026, 9, 1) + min * 60_000);

type Row = {
  id: string;
  contactId: string | null;
  updatedAt: Date;
  contact: { id: string; lastMessageAt: Date | null } | null;
};

const row = (id: string, updatedMin: number, contactId: string | null, lastMin: number | null): Row => ({
  id,
  contactId,
  updatedAt: at(updatedMin),
  contact: contactId ? { id: contactId, lastMessageAt: lastMin === null ? null : at(lastMin) } : null,
});

function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    { organizationId: ORG } as Parameters<typeof runWithContext>[0],
    fn,
  ) as Promise<T>;
}

function sqlOf(call: unknown[]): { text: string; values: unknown[] } {
  const [first, ...rest] = call as [TemplateStringsArray | Prisma.Sql, ...unknown[]];
  if (Array.isArray(first)) return { text: first.join("?"), values: rest };
  const sql = first as Prisma.Sql;
  return { text: sql.strings.join("?"), values: [...sql.values] };
}

let rows: Row[] = [];

beforeEach(() => {
  rows = [];
  h.queryRaw.mockReset().mockResolvedValue([]);
  h.dealFindMany.mockReset().mockImplementation(async (args: { skip?: number; take?: number }) =>
    rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length)),
  );
  h.dealCount.mockReset().mockImplementation(async () => rows.length);
});

describe("lista de negócios — lastInteractionAt em coluna pronta (K1)", () => {
  it("pede `contact.lastMessageAt` no include da lista", async () => {
    rows = [row("d1", 10, "c1", 50)];
    await withOrg(() => getDeals({}));
    const args = h.dealFindMany.mock.calls[0]![0] as {
      include: { contact: { select: Record<string, unknown> } };
    };
    expect(args.include.contact.select.lastMessageAt).toBe(true);
  });

  it("contatos preenchidos: nenhuma consulta a `conversations`", async () => {
    rows = [
      row("d1", 10, "c1", 50), // mensagem depois do deal → vale a mensagem
      row("d2", 90, "c2", 20), // deal mexido depois → vale o deal
      row("d3", 30, null, null), // sem contato → o deal
    ];
    const res = await withOrg(() => getDeals({}));
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(res.items.map((d) => d.lastInteractionAt)).toEqual([
      at(50).toISOString(),
      at(90).toISOString(),
      at(30).toISOString(),
    ]);
  });

  it("contato com a coluna NULL: fallback só para ele (COALESCE(lastMessageAt, updatedAt) das conversas)", async () => {
    rows = [
      row("d1", 10, "c1", 50),
      row("d2", 10, "c2", null), // backfill pendente → fallback devolve 70
      row("d3", 10, "c3", null), // sem conversa → fica o deal
      row("d4", 10, "c2", null), // mesmo contato: um id só na consulta
    ];
    h.queryRaw.mockResolvedValueOnce([{ contactId: "c2", last_at: at(70) }]);
    const res = await withOrg(() => getDeals({}));
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    const { text, values } = sqlOf(h.queryRaw.mock.calls[0]!);
    expect(text).toContain('MAX(COALESCE("lastMessageAt", "updatedAt")) AS last_at');
    expect(text).toContain('"organizationId" = ?');
    expect(values).toEqual([ORG, ["c2", "c3"]]);
    expect(res.items.map((d) => d.lastInteractionAt)).toEqual([
      at(50).toISOString(),
      at(70).toISOString(),
      at(10).toISOString(),
      at(70).toISOString(),
    ]);
  });
});

describe("lista de negócios — paginação sem COUNT obrigatório (K5)", () => {
  const seed = (n: number) => {
    rows = Array.from({ length: n }, (_, i) => row(`d${i}`, 1000 - i, `c${i}`, 5));
  };
  const takeOf = () => (h.dealFindMany.mock.calls.at(-1)![0] as { take: number; skip: number });

  it("padrão (contrato antigo): conta em paralelo, `total` numérico, e ainda devolve `hasMore`", async () => {
    seed(45);
    const res = await withOrg(() => getDeals({ page: 1, perPage: 20 }));
    expect(h.dealCount).toHaveBeenCalledTimes(1);
    // Mesmo where na página e na contagem.
    expect((h.dealCount.mock.calls[0]![0] as { where: unknown }).where).toEqual(
      (h.dealFindMany.mock.calls[0]![0] as { where: unknown }).where,
    );
    expect(takeOf()).toMatchObject({ take: 21, skip: 0 });
    expect(res).toMatchObject({ total: 45, page: 1, perPage: 20, hasMore: true });
    // A linha extra não vaza para a resposta.
    expect(res.items).toHaveLength(20);
    expect(res.items.map((d) => d.id)).toEqual(rows.slice(0, 20).map((d) => d.id));
  });

  it("`withTotal: true` é o mesmo que o padrão", async () => {
    seed(3);
    const res = await withOrg(() => getDeals({ withTotal: true }));
    expect(h.dealCount).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ total: 3, hasMore: false });
  });

  it("`withTotal: false`: nenhuma contagem; página do meio devolve hasMore=true e total=null", async () => {
    seed(45);
    const res = await withOrg(() => getDeals({ page: 2, perPage: 20, withTotal: false }));
    expect(h.dealCount).not.toHaveBeenCalled();
    expect(takeOf()).toMatchObject({ take: 21, skip: 20 });
    expect(res.items).toHaveLength(20);
    expect(res).toMatchObject({ total: null, hasMore: true, page: 2, perPage: 20 });
  });

  it("`withTotal: false`: na última página o total é exato sem consultar", async () => {
    seed(45);
    const res = await withOrg(() => getDeals({ page: 3, perPage: 20, withTotal: false }));
    expect(h.dealCount).not.toHaveBeenCalled();
    expect(res.items).toHaveLength(5);
    expect(res).toMatchObject({ total: 45, hasMore: false });
  });

  it("`withTotal: false`: lista que cabe numa página (busca) já sai com o total; vazia = 0", async () => {
    seed(7);
    const one = await withOrg(() => getDeals({ page: 1, perPage: 20, withTotal: false }));
    expect(one).toMatchObject({ total: 7, hasMore: false });
    seed(0);
    const none = await withOrg(() => getDeals({ page: 1, perPage: 20, withTotal: false }));
    expect(none).toMatchObject({ total: 0, hasMore: false });
    expect(none.items).toEqual([]);
    expect(h.dealCount).not.toHaveBeenCalled();
  });

  it("`withTotal: false`: página exatamente cheia sem próxima → hasMore=false e total exato", async () => {
    seed(40);
    const res = await withOrg(() => getDeals({ page: 2, perPage: 20, withTotal: false }));
    expect(res.items).toHaveLength(20);
    expect(res).toMatchObject({ total: 40, hasMore: false });
  });

  it("`withTotal: false`: página além do fim não inventa total", async () => {
    seed(10);
    const res = await withOrg(() => getDeals({ page: 5, perPage: 20, withTotal: false }));
    expect(res.items).toEqual([]);
    expect(res).toMatchObject({ total: null, hasMore: false });
  });

  it("visibilidade, funil arquivado e escopo de funis continuam no where (página e contagem)", async () => {
    seed(2);
    await withOrg(() =>
      getDeals({
        visibilityWhere: { ownerId: "u1" },
        allowedPipelineIds: ["p1"],
        pipelineId: "p1",
      }),
    );
    const where = (h.dealFindMany.mock.calls[0]![0] as { where: { AND: unknown[] } }).where;
    expect(where.AND).toEqual([
      { ownerId: "u1" },
      { stage: { is: { pipeline: { is: { archivedAt: null } } } } },
      { stage: { pipelineId: "p1" } },
      { stage: { pipelineId: { in: ["p1"] } } },
    ]);
    expect((h.dealCount.mock.calls[0]![0] as { where: unknown }).where).toEqual(where);
  });
});
