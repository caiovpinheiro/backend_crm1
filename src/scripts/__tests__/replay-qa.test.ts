import { describe, expect, it } from "vitest";

import { DEFAULT_NONSENSE_ASK_ONCE } from "@/services/ai/transfer-gate";
import { scoreReplay } from "@/scripts/replay-qa";

describe("scoreReplay", () => {
  it("FAIL quando fixture declara expect.guard false e o texto é ASK", () => {
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
          text: DEFAULT_NONSENSE_ASK_ONCE,
          status: "COMPLETED",
          skipped: null,
          switchedTo: null,
          tools: [],
        },
      ],
      [
        {
          id: "403971",
          turns: [
            "Falar com equipe",
            { inbound: "Financeiro", expect: { guard: false } },
          ],
        },
      ],
    );
    expect(fail).toBeGreaterThan(0);
    expect(findings.some((f) => f.code === "GUARD_FIRED" && f.severity === "fail")).toBe(
      true,
    );
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

  it("GUARD_FIRED é WARN quando a fixture não declara expectativa", () => {
    const { fail, findings } = scoreReplay(
      [
        {
          caseId: "x",
          turnIndex: 0,
          inbound: "👍",
          agentName: "Joseph",
          text: DEFAULT_NONSENSE_ASK_ONCE,
          status: "COMPLETED",
          skipped: null,
          switchedTo: null,
          tools: [],
        },
      ],
      [{ id: "x", turns: ["👍"] }],
    );
    expect(fail).toBe(0);
    expect(findings.some((f) => f.code === "GUARD_FIRED" && f.severity === "warn")).toBe(
      true,
    );
  });

  it("Joseph→especialista via routing estruturado não é SELF_TRANSFER", () => {
    const { findings } = scoreReplay(
      [
        {
          caseId: "h",
          turnIndex: 0,
          inbound: "boleto",
          agentName: "Joseph",
          text: "",
          status: "COMPLETED",
          skipped: null,
          switchedTo: "Agente Atendimento",
          handoff: { fromAgentId: "joseph", toAgentId: "atend", by: "orchestrator_code" },
          tools: [],
        },
      ],
      [{ id: "h", turns: ["boleto"] }],
    );
    expect(findings.some((f) => f.code === "SELF_TRANSFER")).toBe(false);
  });

  it("auto-chamada from===to gera SELF_TRANSFER", () => {
    const { findings } = scoreReplay(
      [
        {
          caseId: "h",
          turnIndex: 0,
          inbound: "boleto",
          agentName: "Agente Atendimento",
          text: "",
          status: "COMPLETED",
          skipped: null,
          switchedTo: "Agente Atendimento",
          handoff: { fromAgentId: "atend", toAgentId: "atend", by: "tool" },
          tools: [{ name: "transfer_to_ai_agent", args: { agentName: "Agente Atendimento" } }],
        },
      ],
      [{ id: "h", turns: ["boleto"] }],
    );
    expect(findings.some((f) => f.code === "SELF_TRANSFER")).toBe(true);
  });

  it("HUMAN_REQUEST_IGNORED quando fixture pede humano e o turno não distribui", () => {
    const { fail, findings } = scoreReplay(
      [
        {
          caseId: "403971",
          turnIndex: 0,
          inbound: "Quero falar com a equipe",
          agentName: "Joseph",
          text: "Vou te passar para o especialista.",
          status: "COMPLETED",
          skipped: null,
          switchedTo: null,
          tools: [{ name: "transfer_to_ai_agent" }],
        },
      ],
      [
        {
          id: "403971",
          turns: [{ inbound: "Quero falar com a equipe", expect: { human: true } }],
        },
      ],
    );
    expect(fail).toBeGreaterThan(0);
    expect(findings.some((f) => f.code === "HUMAN_REQUEST_IGNORED")).toBe(true);
  });
});
