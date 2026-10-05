/**
 * Lista de negócios (`getDeals`, GET /api/deals).
 *
 * K1 — `lastInteractionAt` sai de `contacts.lastMessageAt` (já no include da
 * lista); `conversations` só é consultada para os contatos com a coluna NULL.
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
