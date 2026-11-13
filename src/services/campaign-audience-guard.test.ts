/**
 * A trava consulta o próprio `buildContactWhere`: filtro que ele reduz a
 * `{}` (todos os contatos) é recusado; qualquer restrição real passa.
 */
import { describe, expect, it } from "vitest";

import {
  AUDIENCE_FILTER_KEYS,
  checkAudienceFilters,
} from "@/services/campaign-audience-guard";
import { buildContactWhere, type SegmentFilters } from "@/services/segments";

describe("checkAudienceFilters", () => {
  it("cada chave de SegmentFilters que restringe o público é aceita sozinha", () => {
    const restrictive: SegmentFilters[] = [
      { search: "ana" },
      { lifecycleStage: "LEAD" },
      { tagIds: ["t1"] },
      { companyId: "c1" },
      { assignedToId: "u1" },
      { dealOwnerId: "u1" },
      { pipelineId: "p1" },
      { stageIds: ["s1"] },
      { dealStatus: "OPEN" },
      { createdAfter: "2026-01-01T00:00:00Z" },
    ];
    // hasPhone e excludeTagIds não restringem sozinhos (testados abaixo).
    const covered = new Set<string>(["hasPhone", "excludeTagIds"]);
    for (const filters of restrictive) {
      expect(checkAudienceFilters(filters, { rejectUnknownKeys: true })).toEqual({ ok: true, filters });
      expect(Object.keys(buildContactWhere(filters)).length).toBeGreaterThan(0);
      Object.keys(filters).forEach((k) => covered.add(k));
    }
    // Chave nova em SegmentFilters precisa entrar na lista da trava.
    expect([...covered].sort()).toEqual([...AUDIENCE_FILTER_KEYS].sort());
  });

  it("recusa o que o dispatch resolveria para todos os contatos com telefone", () => {
    for (const raw of [undefined, null, {}, { hasPhone: true }, { tagIds: [], stageIds: [] }, { search: " " }, { naoExiste: 1 }]) {
      const result = checkAudienceFilters(raw);
      expect(result).toMatchObject({ ok: false, code: "AUDIENCE_FILTERS_REQUIRED" });
      if (raw && typeof raw === "object") {
        expect(buildContactWhere({ ...(raw as SegmentFilters), hasPhone: undefined })).toEqual({});
      }
    }
  });

  it("excludeTagIds sozinho não restringe: recusa (mandaria para todos menos os excluídos)", () => {
    expect(checkAudienceFilters({ excludeTagIds: ["optout"] }, { rejectUnknownKeys: true })).toMatchObject({
      ok: false,
      code: "AUDIENCE_FILTERS_REQUIRED",
    });
    expect(checkAudienceFilters({ hasPhone: true, excludeTagIds: ["optout"] })).toMatchObject({
      ok: false,
      code: "AUDIENCE_FILTERS_REQUIRED",
    });
  });

  it("excludeTagIds junto de um filtro que restringe: aceita e exclui no contato e nos negócios", () => {
    const filters: SegmentFilters = { tagIds: ["em-aberto"], excludeTagIds: ["optout", "controle"] };
    expect(checkAudienceFilters(filters, { rejectUnknownKeys: true })).toEqual({ ok: true, filters });
    expect(buildContactWhere(filters)).toEqual({
      AND: [
        {
          OR: [
            { tags: { some: { tagId: { in: ["em-aberto"] } } } },
            { deals: { some: { tags: { some: { tagId: { in: ["em-aberto"] } } } } } },
          ],
        },
        {
          NOT: {
            OR: [
              { tags: { some: { tagId: { in: ["optout", "controle"] } } } },
              { deals: { some: { tags: { some: { tagId: { in: ["optout", "controle"] } } } } } },
            ],
          },
        },
      ],
    });
  });

  it("excludeTagIds vazio é ignorado", () => {
    expect(buildContactWhere({ tagIds: ["t1"], excludeTagIds: [] })).toEqual(buildContactWhere({ tagIds: ["t1"] }));
  });

  it("excludeTagIds com formato errado é recusado", () => {
    expect(checkAudienceFilters({ tagIds: ["t1"], excludeTagIds: "optout" })).toMatchObject({
      ok: false,
      code: "AUDIENCE_FILTERS_INVALID",
    });
  });

  it("recusa formato e tipo errados", () => {
    const invalid: unknown[] = [
      "tag-1",
      ["tag-1"],
      { tagIds: "tag-1" },
      { tagIds: [1] },
      { stageIds: [""] },
      { search: 5 },
      { lifecycleStage: "toString" },
      { dealStatus: "ABERTO" },
      { hasPhone: "sim", tagIds: ["t1"] },
      { createdAfter: "ontem" },
    ];
    for (const raw of invalid) {
      expect(checkAudienceFilters(raw), JSON.stringify(raw)).toMatchObject({
        ok: false,
        code: "AUDIENCE_FILTERS_INVALID",
      });
    }
  });

  it("chave desconhecida: recusada só com rejectUnknownKeys", () => {
    const raw = { tagIds: ["t1"], stageId: "s1" };
    expect(checkAudienceFilters(raw)).toMatchObject({ ok: true });
    expect(checkAudienceFilters(raw, { rejectUnknownKeys: true })).toMatchObject({
      ok: false,
      code: "AUDIENCE_FILTERS_INVALID",
      message: expect.stringContaining("stageId"),
    });
  });
});
