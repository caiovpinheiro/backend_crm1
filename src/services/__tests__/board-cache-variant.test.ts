/**
 * Variante canônica do cache do board (B3): o que não muda o resultado não
 * muda a chave; o que muda (visibilidade, recorte de etapas, filtros,
 * paginação) continua mudando.
 */
import { describe, expect, it } from "vitest";

import {
  BOARD_DEFAULT_PER_STAGE,
  BOARD_MAX_PER_STAGE,
  BOARD_MAX_STAGE_OFFSET,
  boardStageScope,
  canonicalBoardFilters,
  canonicalBoardLimit,
  canonicalBoardVariant,
  normalizeBoardOffsets,
  normalizeBoardPerStage,
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
        limitOptions: { perStage: 50, sortField: "position", sortDirection: "desc", offsetByStage: { s1: 0 } },
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

  it("perStage é limitado como no board (1..200, padrão 50 — K4)", () => {
    expect(BOARD_DEFAULT_PER_STAGE).toBe(50);
    expect(BOARD_MAX_PER_STAGE).toBe(200);
    expect(canonicalBoardLimit({ perStage: 9_999 })).toEqual({ perStage: 200, sortField: "position" });
    expect(canonicalBoardLimit({ perStage: 200 })).toEqual({ perStage: 200, sortField: "position" });
    expect(canonicalBoardLimit(undefined)).toEqual({ perStage: 50, sortField: "position" });
    expect(canonicalBoardLimit({ perStage: 0 })).toEqual({ perStage: 1, sortField: "position" });
    expect(canonicalBoardLimit({ perStage: Number.NaN })).toEqual({ perStage: 50, sortField: "position" });
    expect(canonicalBoardLimit({ perStage: 30.9 })).toEqual({ perStage: 30, sortField: "position" });
    expect(canonicalBoardLimit({ sortField: "createdAt" })).toEqual({
      perStage: 50,
      sortField: "createdAt",
      sortDirection: "asc",
    });
    // Pedir o padrão explicitamente ou acima do teto não cria chave nova.
    expect(variant({ limitOptions: { perStage: 50 } })).toBe(variant());
    expect(variant({ limitOptions: { perStage: 500 } })).toBe(variant({ limitOptions: { perStage: 200 } }));
  });

  it("offsetByStage (modo antigo): inteiros positivos com teto; lixo não entra na chave nem na consulta", () => {
    expect(
      normalizeBoardOffsets({
        b: 30,
        a: 12.7,
        zero: 0,
        neg: -5,
        nan: Number.NaN,
        huge: 1e9,
        text: "40" as unknown as number,
      }),
    ).toEqual({ a: 12, b: 30, huge: BOARD_MAX_STAGE_OFFSET });
    expect(normalizeBoardOffsets(undefined)).toEqual({});
    expect(normalizeBoardPerStage(undefined)).toBe(50);
    expect(canonicalBoardLimit({ offsetByStage: { s1: -1, s2: 0 } })).toEqual({
      perStage: 50,
      sortField: "position",
    });
    expect(canonicalBoardLimit({ offsetByStage: { s1: 1e9 } })).toEqual({
      perStage: 50,
      sortField: "position",
      offsetByStage: { s1: BOARD_MAX_STAGE_OFFSET },
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
