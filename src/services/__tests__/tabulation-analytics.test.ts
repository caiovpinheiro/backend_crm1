import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queries: [] as { sql: string; values: unknown[] }[],
  count: vi.fn(async () => 7),
}));

vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org-1" }));
vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({
    $queryRaw: async (q: { sql: string; values: unknown[] }) => {
      h.queries.push({ sql: q.sql, values: q.values });
      if (q.sql.includes("distinct_tabulations")) {
        return [{ total: BigInt(3), distinct_tabulations: BigInt(2), distinct_users: BigInt(1) }];
      }
      return [];
    },
    activityEvent: { count: h.count, findMany: async () => [] },
    tabulation: { findMany: async () => [] },
    user: { findMany: async () => [] },
    department: { findMany: async () => [] },
  }),
}));

import { getTabulationAnalytics } from "@/services/tabulation-analytics";

const range = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-06T00:00:00Z") };

describe("getTabulationAnalytics — conversa retabulada conta uma vez", () => {
  beforeEach(() => {
    h.queries.length = 0;
  });

  it("totais e rankings leem só a tabulação mais recente de cada conversa", async () => {
    const out = await getTabulationAnalytics({ ...range, tabulationIds: ["t1"] });
    expect(h.queries).toHaveLength(3);
    for (const q of h.queries) {
      expect(q.sql).toContain('DISTINCT ON (e."conversationId")');
      expect(q.sql).toContain('ORDER BY e."conversationId", e."occurredAt" DESC, e.id DESC');
      // Evento sem conversa entra como está.
      expect(q.sql).toContain('e."conversationId" IS NULL');
      // O período recorta antes; o filtro de tabulação vale sobre o vigente (FROM latest).
      expect(q.sql).toMatch(/FROM latest\s+WHERE meta->>'tabulationId' = /);
    }
    expect(out.total).toBe(3);
    expect(out.eventsTotal).toBe(7);
    expect(out.distinctTabulations).toBe(2);
  });

  it("o log paginado e eventsTotal continuam contando todos os eventos", async () => {
    await getTabulationAnalytics({ ...range, page: 2, perPage: 10 });
    expect(h.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: "org-1", type: "CONVERSATION_TABULATED" }),
    });
  });
});
