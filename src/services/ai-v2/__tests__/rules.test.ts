import { describe, expect, it } from "vitest";
import { evaluateV2Rules, isWithinV2BusinessHours } from "../rules";
import type { V2AgentConfig, V2Rule, V2CRMContext } from "@/lib/ai-v2/types";

function baseRulesConfig(rules: V2Rule[], businessHours?: V2AgentConfig["businessHours"]): V2AgentConfig {
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
    businessHours,
  } as unknown as V2AgentConfig;
}

const emptyContext: V2CRMContext = { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } };

describe("isWithinV2BusinessHours", () => {
  it("retorna true quando desabilitado", () => {
    const config = baseRulesConfig([], { enabled: false, timezone: "America/Sao_Paulo", weekdays: [] });
    expect(isWithinV2BusinessHours(config, new Date("2026-09-20T02:00:00-03:00"))).toBe(true);
  });

  it("detecta fora do horário fora do slot", () => {
    const config = baseRulesConfig([], {
      enabled: true,
      timezone: "America/Sao_Paulo",
      weekdays: [{ day: 1, start: "08:00", end: "18:00" }],
    });
    // Domingo 20/09/2026
    expect(isWithinV2BusinessHours(config, new Date("2026-09-20T10:00:00-03:00"))).toBe(false);
  });

  it("detecta dentro do horário no slot correto", () => {
    const config = baseRulesConfig([], {
      enabled: true,
      timezone: "America/Sao_Paulo",
      weekdays: [{ day: 1, start: "08:00", end: "18:00" }],
    });
    // Segunda 21/09/2026 10:00 BRT
    expect(isWithinV2BusinessHours(config, new Date("2026-09-21T10:00:00-03:00"))).toBe(true);
  });
});

describe("evaluateV2Rules conditions", () => {
  it("contact_tag casa com tag presente", () => {
    const rules: V2Rule[] = [{
      id: "r1",
      name: "Tag",
      order: 1,
      conditions: [{ type: "contact_tag", values: ["VIP"] }],
      actions: [{ type: "no_reply" }],
    }];
    const config = baseRulesConfig(rules);
    const context = { ...emptyContext, contact: { tags: ["VIP"] } as any };
    const matched = evaluateV2Rules(config, {
      userMessage: "Oi",
      isFirstMessage: true,
      withinBusinessHours: true,
      contactTags: ["VIP"],
    }, context);
    expect(matched?.id).toBe("r1");
  });

  it("survey_received usa flag do input", () => {
    const rules: V2Rule[] = [{
      id: "r1",
      name: "Survey",
      order: 1,
      conditions: [{ type: "survey_received" }],
      actions: [{ type: "no_reply" }],
    }];
    const config = baseRulesConfig(rules);
    const matched = evaluateV2Rules(config, {
      userMessage: "5",
      isFirstMessage: false,
      withinBusinessHours: true,
      surveyReceived: true,
    }, emptyContext);
    expect(matched?.id).toBe("r1");
  });

  it("out_of_hours casa quando withinBusinessHours é false", () => {
    const rules: V2Rule[] = [{
      id: "r1",
      name: "Fora",
      order: 1,
      conditions: [{ type: "out_of_hours" }],
      actions: [{ type: "send_message", message: "Fora do expediente." }],
    }];
    const config = baseRulesConfig(rules);
    const matched = evaluateV2Rules(config, {
      userMessage: "Oi",
      isFirstMessage: true,
      withinBusinessHours: false,
    }, emptyContext);
    expect(matched?.id).toBe("r1");
  });
});
