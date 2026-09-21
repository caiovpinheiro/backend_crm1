import { describe, expect, it } from "vitest";

import { validateV2Config } from "@/lib/ai-v2/config";
import { defaultFormatter, renderMessage } from "@/lib/ai-v2/message-render";
import { detectV2Sentiment, shouldActOnSentiment } from "@/services/ai-v2/sentiment";
import { evaluateV2Rules } from "@/services/ai-v2/rules";
import { classifyPostCloseMessage, getPostCloseBehavior } from "@/services/ai-v2/closure";
import { guardV2Output } from "@/services/ai-v2/output-guard";
import { parseV2Counters } from "@/services/ai-v2/limits";
import { selectV2Theme } from "@/services/ai-v2/themes";
import { buildInteractiveText, decideInteractiveFormat } from "@/services/ai-v2/interactive";
import type { V2AgentConfig, V2Rule } from "@/lib/ai-v2/types";

const baseConfig = (): V2AgentConfig =>
  ({
    name: "Agente de teste",
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Objetivo",
    globalRules: ["Não prometa retornar depois."],
    allowedDomains: ["exemplo.com"],
    contextFields: { contact: [], deal: [] },
    variables: [],
    entry: { confirmContact: true, onDealNotFound: "ask_identification" },
    handoff: {
      defaultDestination: { type: "department" },
      message: "Vou transferir.",
      humanRequestKeywords: ["humano"],
    },
    closure: {},
    limits: {},
    media: {},
    sentiment: {},
    survey: {},
    themes: [],
    rules: [],
    autonomyMode: "autonomous",
  } as unknown as V2AgentConfig);

describe("config validation", () => {
  it("rejects config without tone", () => {
    const result = validateV2Config({ ...baseConfig(), tone: undefined as any });
    expect(result.ok).toBe(false);
  });

  it("accepts valid config with defaults", () => {
    const result = validateV2Config(baseConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.handoff.message).toBe("Vou transferir.");
      expect(result.data.closure.courtesyBehavior).toBe("no_reply");
    }
  });
});

describe("message render", () => {
  it("replaces variables", () => {
    const text = "Olá @Nome, seu e-mail é @Email.";
    const vars = { Nome: "Ana", Email: "ana@x.com" };
    expect(renderMessage(text, vars, defaultFormatter())).toBe(
      "Olá Ana, seu e-mail é ana@x.com.",
    );
  });

  it("strips unknown variables", () => {
    expect(renderMessage("Oi @Desconhecido", {}, defaultFormatter())).toBe("Oi");
  });

  it("renders conditional blocks when variable is truthy", () => {
    const text = "@TemPlano{ Com plano } @TemPlano{sem plano}";
    expect(renderMessage(text, { TemPlano: "sim" }, defaultFormatter())).toBe("Com plano sem plano");
  });

  it("skips conditional block when variable is falsy", () => {
    const text = "@TemPlano{ Com plano }";
    expect(renderMessage(text, {}, defaultFormatter())).toBe("");
  });
});

describe("rules engine", () => {
  it("matches keyword condition", () => {
    const config = baseConfig();
    config.rules = [
      {
        id: "r1",
        name: "humano",
        order: 0,
        conditions: [{ type: "keywords", values: ["humano", "pessoa"] }],
        actions: [{ type: "handoff" }],
      },
    ];
    const result = evaluateV2Rules(config, {
      userMessage: "Quero falar com uma pessoa",
      messageType: "text",
      isFirstMessage: false,
      withinBusinessHours: true,
    }, { contact: null, deals: [], selectedDeal: null, fields: config.contextFields });
    expect(result?.id).toBe("r1");
    expect(result?.actions[0]?.type).toBe("handoff");
  });

  it("respects negate condition", () => {
    const config = baseConfig();
    config.rules = [
      {
        id: "r1",
        name: "fora de escopo",
        order: 0,
        conditions: [{ type: "keywords", values: ["vender"], negate: true }],
        actions: [{ type: "no_reply" }],
      },
    ];
    const result = evaluateV2Rules(config, {
      userMessage: "Quero vender",
      messageType: "text",
      isFirstMessage: false,
      withinBusinessHours: true,
    }, { contact: null, deals: [], selectedDeal: null, fields: config.contextFields });
    expect(result).toBeNull();
  });
});

describe("sentiment", () => {
  it("detects angry message", () => {
    const config = baseConfig();
    config.sentiment = { enabled: true, threshold: "any", action: "handoff" };
    expect(detectV2Sentiment(config, "Isso é péssimo, estou horrível")).toBe("angry");
  });

  it("triggers handoff for angry when configured", () => {
    const config = baseConfig();
    config.sentiment = { enabled: true, threshold: "angry", action: "handoff" };
    expect(shouldActOnSentiment(config, "angry")).toBe(true);
    expect(shouldActOnSentiment(config, "dissatisfied")).toBe(false);
  });
});

describe("post-close classification", () => {
  it("classifies courtesy messages", () => {
    expect(classifyPostCloseMessage(baseConfig(), "obrigado, tchau")).toBe("courtesy");
  });

  it("classifies new demand", () => {
    expect(classifyPostCloseMessage(baseConfig(), "preciso de ajuda com a fatura")).toBe("new_demand");
  });

  it("returns configured behavior for courtesy", () => {
    const config = baseConfig();
    config.closure = { ...config.closure, courtesyBehavior: "short_reply" };
    expect(getPostCloseBehavior(config, "courtesy")).toBe("short_reply");
  });
});

describe("output guard", () => {
  it("removes links from unauthorized domains", () => {
    const result = guardV2Output("Veja em https://malicious.com e https://exemplo.com/page", [
      "exemplo.com",
    ]);
    expect(result.text).not.toContain("malicious.com");
    expect(result.text).toContain("exemplo.com/page");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("blocks promise to return later", () => {
    const result = guardV2Output("Vou verificar e retorno depois.", []);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.text).toContain("atendente");
  });
});

describe("counters", () => {
  it("parses counters with defaults", () => {
    const counters = parseV2Counters({ nonsenseMessages: 5, courtesyReplies: 2 } as any);
    expect(counters.nonsenseMessages).toBe(5);
    expect(counters.courtesyReplies).toBe(2);
    expect(counters.loopCount).toBe(0);
  });
});

describe("theme selection", () => {
  it("selects theme by keyword", () => {
    const config = baseConfig();
    config.themes = [
      { id: "t1", name: "Fatura", when: ["fatura", "boleto"], instructions: "", allowedTools: [], examples: [], allowedKnowledgeDocIds: [], allowedMessageModelIds: [], productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [], allowedProductIds: [], actions: [] } },
      { id: "t2", name: "Suporte", when: ["bug", "erro"], instructions: "", allowedTools: [], examples: [], allowedKnowledgeDocIds: [], allowedMessageModelIds: [], productPolicy: { enabled: false, maxItems: 3, showPrice: false, showConditions: false, showImage: false, showLink: false, citableFields: [], allowedProductIds: [], actions: [] } },
    ];
    const selected = selectV2Theme(config, "Quero pagar minha fatura", undefined);
    expect(selected?.id).toBe("t1");
  });
});

describe("interactive format", () => {
  it("chooses buttons for <=3 options within window", () => {
    const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }] as any;
    expect(decideInteractiveFormat(options, true)).toBe("buttons");
  });

  it("chooses numbered text outside window", () => {
    const options = [{ id: "a", label: "A" }] as any;
    expect(decideInteractiveFormat(options, false)).toBe("numbered_text");
  });

  it("builds numbered text list", () => {
    const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }] as any;
    expect(buildInteractiveText(options)).toBe("1. A\n2. B");
  });
});
