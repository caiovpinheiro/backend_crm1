/**
 * Filtro "Duplicata intencional": só os negócios criados por "Duplicar"
 * (`Deal.intentionalDuplicate = true`). Repetidos de outra origem ficam de fora.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org-1" }),
}));

import {
  buildDealWhereFromFilters,
  parseAdvancedDealFilters,
} from "@/services/kanban-filters";

describe("filtro intentionalDuplicate", () => {
  it("true filtra só a duplicata intencional", async () => {
    const conditions = await buildDealWhereFromFilters({ intentionalDuplicate: true });
    expect(conditions).toContainEqual({ intentionalDuplicate: true });
  });

  it("ausente não restringe por duplicata", async () => {
    const conditions = await buildDealWhereFromFilters({});
    expect(JSON.stringify(conditions)).not.toContain("intentionalDuplicate");
  });

  it("o parser aceita só true booleano", () => {
    expect(parseAdvancedDealFilters({ intentionalDuplicate: true })).toEqual({
      intentionalDuplicate: true,
    });
    expect(parseAdvancedDealFilters({ intentionalDuplicate: false })).toEqual({});
    expect(parseAdvancedDealFilters({ intentionalDuplicate: "1" })).toEqual({});
  });
});
