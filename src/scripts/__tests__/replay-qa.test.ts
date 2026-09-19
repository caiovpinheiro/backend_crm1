import { describe, expect, it } from "vitest";

import { NONSENSE_ASK_ONCE, NONSENSE_STOP } from "@/services/ai/transfer-gate";
import { scoreReplay } from "@/scripts/replay-qa";

describe("scoreReplay", () => {
  it("reprova ASK em Financeiro (falso positivo do guard)", () => {
    const { fail, findings } = scoreReplay(
      [
        {
          caseId: "403971",
          turnIndex: 0,
          inbound: "Falar com equipe",
          agentName: "Agente Atendimento",
          text: "Oi, estou no atendimento.",
          status: "COMPLETED",
          skipped: null,
          switchedTo: "Agente Atendimento",
          tools: [{ name: "transfer_to_ai_agent" }],
        },
        {
          caseId: "403971",
          turnIndex: 1,
          inbound: "Financeiro",
          agentName: "Agente Atendimento",
          text: NONSENSE_ASK_ONCE,
          status: "COMPLETED",
          skipped: null,
          switchedTo: null,
          tools: [],
        },
      ],
      [{ id: "403971", turns: ["Falar com equipe", "Financeiro"] }],
    );
    expect(fail).toBeGreaterThan(0);
    expect(findings.some((f) => f.code === "FALSE_NONSENSE")).toBe(true);
  });

  it("não reprova regra de mensalidade no Atendimento (produto, não Financeiro)", () => {
    const { fail, findings } = scoreReplay(
      [
        {
          caseId: "403984",
          turnIndex: 0,
          inbound: "Minhas mensalidades foram lançadas com valor errado.",
          agentName: "Agente Atendimento",
          text: "O valor do boleto é o bruto; o desconto da compra aparece na área do aluno.",
          status: "COMPLETED",
          skipped: null,
          switchedTo: null,
          tools: [],
        },
      ],
      [
        {
          id: "403984",
          turns: ["Minhas mensalidades foram lançadas com valor errado."],
        },
      ],
    );
    expect(fail).toBe(0);
    expect(findings.some((f) => f.code === "RULE_SKIP")).toBe(false);
  });

  it("SKIP Atendimento-SAC no harness é aviso, não falha de produto", () => {
    const { fail, findings } = scoreReplay(
      [
        {
          caseId: "403984",
          turnIndex: 0,
          inbound: "Minhas mensalidades foram lançadas com valor errado.",
          agentName: "Agente Atendimento",
          text: "",
          status: null,
          skipped: "rule_department:Atendimento - SAC",
          switchedTo: null,
          tools: [],
        },
      ],
      [
        {
          id: "403984",
          turns: ["Minhas mensalidades foram lançadas com valor errado."],
        },
      ],
    );
    expect(fail).toBe(0);
    expect(findings.some((f) => f.code === "RULE_SKIP" && f.severity === "warn")).toBe(
      true,
    );
  });

  it("passa cumprimento idle com resposta normal", () => {
    const { fail } = scoreReplay(
      [
        {
          caseId: "403980",
          turnIndex: 0,
          inbound: "Oie",
          agentName: "Joseph",
          text: "Boa noite! Como posso te ajudar hoje?",
          status: "COMPLETED",
          skipped: null,
          switchedTo: null,
          tools: [],
        },
      ],
      [{ id: "403980", turns: ["Oie"] }],
    );
    expect(fail).toBe(0);
  });

  it("não conta STOP real em teclado como FALSE_NONSENSE", () => {
    const { findings } = scoreReplay(
      [
        {
          caseId: "x",
          turnIndex: 0,
          inbound: "asdfgh",
          agentName: "Joseph",
          text: NONSENSE_ASK_ONCE,
          status: "COMPLETED",
          skipped: null,
          switchedTo: null,
          tools: [],
        },
        {
          caseId: "x",
          turnIndex: 1,
          inbound: "qwerty",
          agentName: "Joseph",
          text: NONSENSE_STOP,
          status: "COMPLETED",
          skipped: null,
          switchedTo: null,
          tools: [],
        },
      ],
      [{ id: "x", turns: ["asdfgh", "qwerty"] }],
    );
    expect(findings.some((f) => f.code === "FALSE_NONSENSE")).toBe(false);
  });
});
