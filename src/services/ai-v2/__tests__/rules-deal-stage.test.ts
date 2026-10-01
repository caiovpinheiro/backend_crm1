import { describe, expect, it } from "vitest";
import { dealStageMatches, evaluateV2Rules } from "../rules";
import type { V2AgentConfig, V2CRMContext, V2Rule } from "@/lib/ai-v2/types";

function configWith(rules: V2Rule[]): V2AgentConfig {
  return {
    name: "Test",
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Neutro",
    globalRules: [],
    allowedDomains: [],
    contextFields: { contact: [], deal: [] },
    variables: [],
    entry: { confirmContact: false, onDealNotFound: "ask_identification" },
    handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: [] },
    closure: {},
    limits: {},
    media: {},
    rules,
  } as unknown as V2AgentConfig;
}

const context: V2CRMContext = { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } };

const stageRule = (values: string[]): V2Rule => ({
  id: "r1",
  name: "Etapa",
  order: 0,
  conditions: [{ type: "deal_stage", values }],
  actions: [{ type: "handoff" }],
});

const run = (values: string[], deal: { dealStageName?: string; dealStageId?: string; dealPipelineName?: string }) =>
  evaluateV2Rules(configWith([stageRule(values)]), { userMessage: "oi", isFirstMessage: false, withinBusinessHours: true, ...deal }, context);

describe("condição 'etapa do negócio'", () => {
  const inSales = { dealStageName: "Perdido", dealStageId: "st-sales-lost", dealPipelineName: "Vendas" };
  const inSupport = { dealStageName: "Perdido", dealStageId: "st-support-lost", dealPipelineName: "Suporte" };

  it("só o nome: casa com a etapa de mesmo nome em qualquer funil", () => {
    expect(run(["perdido"], inSales)?.id).toBe("r1");
    expect(run(["perdido"], inSupport)?.id).toBe("r1");
  });

  it("'Funil > Etapa': casa só no funil indicado", () => {
    expect(run(["Vendas > Perdido"], inSales)?.id).toBe("r1");
    expect(run(["Vendas > Perdido"], inSupport)).toBeNull();
    expect(run(["vendas>perdido"], inSales)?.id).toBe("r1");
  });

  it("id da etapa: casa só naquela etapa", () => {
    expect(run(["st-sales-lost"], inSales)?.id).toBe("r1");
    expect(run(["st-sales-lost"], inSupport)).toBeNull();
  });

  it("etapa com '>' no próprio nome continua casando pelo nome inteiro", () => {
    expect(dealStageMatches("Fase 1 > Fase 2", { dealStageName: "Fase 1 > Fase 2", dealPipelineName: "Vendas" })).toBe(true);
  });

  it("sem negócio, ou com valor vazio, não casa", () => {
    expect(run(["Perdido"], {})).toBeNull();
    expect(dealStageMatches("  ", inSales)).toBe(false);
  });
});
