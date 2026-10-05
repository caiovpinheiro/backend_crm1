/**
 * Variante canônica do cache do board (B3): o que não muda o resultado não
 * muda a chave; o que muda (visibilidade, recorte de etapas, filtros,
 * paginação) continua mudando.
 */
import { describe, expect, it } from "vitest";

import {
  boardStageScope,
  canonicalBoardFilters,
  canonicalBoardLimit,
  canonicalBoardVariant,
} from "@/services/board-cache-variant";
import type { AdvancedDealFilters } from "@/services/kanban-filters";

const PIPE = "pipe-1";

function variant(over: Partial<Parameters<typeof canonicalBoardVariant>[0]> = {}): string {
  return canonicalBoardVariant({
    pipelineId: PIPE,
    visibilityWhere: null,
    statusFilter: undefined,
    advancedFilters: undefined,
    limitOptions: undefined,
    ...over,
  });
}

describe("canonicalBoardVariant — mesma chave", () => {
  it("GET sem filtro == POST com `filters: {}` e padrões explícitos", () => {
    expect(
      variant({
        statusFilter: "OPEN",
        advancedFilters: {},
        limitOptions: { perStage: 100, sortField: "position", sortDirection: "desc", offsetByStage: { s1: 0 } },
        visibilityWhere: {},
      }),
    ).toBe(variant());
  });

  it("ordem de chaves e de ids não importa", () => {
    const a: AdvancedDealFilters = { tagIds: ["t2", "t1"], sources: ["b", "a"], search: " joão " };
    const b: AdvancedDealFilters = { search: "joão", sources: ["a", "b", "a"], tagIds: ["t1", "t2"] };
    expect(variant({ advancedFilters: a })).toBe(variant({ advancedFilters: b }));
    expect(
      variant({ visibilityWhere: { OR: [{ ownerId: { in: ["u2", "u1"] } }, { ownerId: null }] } }),
    ).toBe(variant({ visibilityWhere: { OR: [{ ownerId: { in: ["u1", "u2"] } }, { ownerId: null }] } }));
  });

  it("filtros vazios / sem efeito somem", () => {
    expect(
      canonicalBoardFilters(
        {
          tagIds: [],
          search: "   ",
          withoutOwner: false,
          withoutTags: false,
          tagMode: "all",
          logic: "AND",
          pipelineId: PIPE,
          createdAt: { from: null, to: "" },
          stalledDays: 10,
        },
        PIPE,
      ),
    ).toBeNull();
    expect(canonicalBoardFilters({ tagIds: ["t1"], tagMode: "any" }, PIPE)).toEqual({ tagIds: ["t1"] });
  });

  it("perStage é limitado como no board (0..500, padrão 100)", () => {
    expect(canonicalBoardLimit({ perStage: 9_999 })).toEqual({ perStage: 500, sortField: "position" });
    expect(canonicalBoardLimit(undefined)).toEqual({ perStage: 100, sortField: "position" });
    expect(canonicalBoardLimit({ sortField: "createdAt" })).toEqual({
      perStage: 100,
      sortField: "createdAt",
      sortDirection: "asc",
    });
  });
});

describe("canonicalBoardVariant — chave diferente", () => {
  it("visibilidade por usuário", () => {
    expect(variant({ visibilityWhere: { ownerId: "u1" } })).not.toBe(
      variant({ visibilityWhere: { ownerId: "u2" } }),
    );
    expect(variant({ visibilityWhere: { ownerId: "u1" } })).not.toBe(variant());
  });

  it("recorte de etapas do papel", () => {
    expect(variant({ stageScope: "*" })).not.toBe(
      variant({ stageScope: boardStageScope({ stageDeny: new Set(["s1"]) }) }),
    );
  });

  it("status, filtros que filtram, paginação e direção fora de position", () => {
    expect(variant({ statusFilter: "ALL" })).not.toBe(variant());
    expect(variant({ advancedFilters: { contactHasPhone: false } })).not.toBe(variant());
    expect(variant({ advancedFilters: { withoutTags: true } })).not.toBe(variant());
    expect(variant({ advancedFilters: { tagIds: ["t1"], tagMode: "all" } })).not.toBe(
      variant({ advancedFilters: { tagIds: ["t1"] } }),
    );
    expect(variant({ advancedFilters: { pipelineId: "outro" } })).not.toBe(variant());
    expect(variant({ limitOptions: { perStage: 10 } })).not.toBe(variant());
    expect(variant({ limitOptions: { offsetByStage: { s1: 20 } } })).not.toBe(variant());
    expect(
      variant({ limitOptions: { sortField: "createdAt", sortDirection: "desc" } }),
    ).not.toBe(variant({ limitOptions: { sortField: "createdAt", sortDirection: "asc" } }));
  });
});

describe("boardStageScope", () => {
  it("quem vê tudo → '*'; recorte em ordem estável", () => {
    expect(boardStageScope({ isAdmin: true, stageDeny: new Set(["x"]) })).toBe("*");
    expect(boardStageScope({ stageDeny: new Set(), stageView: null })).toBe("*");
    expect(boardStageScope({ stageDeny: new Set(["b", "a"]), stageView: null })).toBe(
      boardStageScope({ stageDeny: new Set(["a", "b"]), stageView: null }),
    );
    expect(boardStageScope({ stageView: new Set(["s1"]) })).toBe(
      JSON.stringify({ deny: [], view: ["s1"] }),
    );
  });
});
