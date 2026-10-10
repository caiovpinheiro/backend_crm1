/**
 * Importação de negócios (planilha) numa etapa Ganho/Perdido: o negócio nasce
 * WON/LOST pelo `createDeal`, mas a planilha não tem coluna de data de
 * fechamento — a linha manda `closedAt: null` para o card não virar
 * "fechado hoje" (pico falso no painel no mês da importação). Os demais
 * caminhos (tela, API, automação, IA) não passam `closedAt` e ganham "agora".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createDeal: vi.fn(),
  updateDeal: vi.fn(),
}));

vi.mock("@/lib/prisma-import", () => ({ prismaImportScoped: {} }));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org-1" }));
vi.mock("@/lib/import-helpers", () => ({
  attachTagToDeal: vi.fn(),
  findContactIdByEmailCI: vi.fn(),
  findUserIdByEmailCI: vi.fn(),
}));
vi.mock("@/lib/contact-import-core", () => ({ buildCustomFieldHeaderMap: vi.fn() }));
vi.mock("@/services/contacts", () => ({ createContact: vi.fn(), updateContact: vi.fn() }));
vi.mock("@/services/custom-fields", () => ({ upsertDealCustomFieldValues: vi.fn() }));
vi.mock("@/services/deals", () => ({
  createDeal: h.createDeal,
  updateDeal: h.updateDeal,
  isValidDealStatus: (s: string) => ["OPEN", "WON", "LOST"].includes(s),
  wasReusedOpenDeal: () => false,
}));

import { newDealImportCache, processDealRow } from "@/lib/deal-import-core";

function cacheWithStage(stageId: string) {
  const cache = newDealImportCache();
  cache.stageById.add(stageId);
  cache.nextPositionByStage.set(stageId, 0);
  return cache;
}

const OPTS = { updateExisting: false, importTagId: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.createDeal.mockResolvedValue({ id: "deal-1" });
});

describe("importação de negócios: data de fechamento", () => {
  it("linha criada sem data de fechamento manda closedAt nulo (não 'hoje')", async () => {
    const r = await processDealRow(
      ["title", "stage_id", "status"],
      { title: "Antigo perdido", stage_id: "stage-lost", status: "LOST" },
      OPTS,
      cacheWithStage("stage-lost"),
    );

    expect(r).toEqual({ status: "created" });
    expect(h.createDeal).toHaveBeenCalledTimes(1);
    expect(h.createDeal.mock.calls[0]![0]).toMatchObject({
      stageId: "stage-lost",
      status: "LOST",
      closedAt: null,
    });
  });

  it("linha sem status também não carimba data (a etapa decide o status no createDeal)", async () => {
    await processDealRow(
      ["title", "stage_id"],
      { title: "Antigo ganho", stage_id: "stage-won" },
      OPTS,
      cacheWithStage("stage-won"),
    );

    expect(h.createDeal.mock.calls[0]![0]).toMatchObject({ stageId: "stage-won", closedAt: null });
  });
});
