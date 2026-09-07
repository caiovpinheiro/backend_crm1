import { describe, expect, it } from "vitest";

import { deriveRunOutcome, statusForOutcome } from "@/services/ai/run-outcome";

const base = {
  toolCalls: [] as Array<{ toolName: string; result?: unknown }>,
  finalAssigneeType: "AI" as string | null,
  limitReached: false,
  noRetrievalContext: false,
};

describe("deriveRunOutcome", () => {
  it("sintoma original: transfer chamada, conversa ainda na IA — não é HANDOFF", () => {
    const outcome = deriveRunOutcome({
      ...base,
      toolCalls: [
        { toolName: "transfer_to_department", result: { ok: true } },
        {
          toolName: "execute_distribution",
          result: { ok: false, error: "Não distribua: o aluno não pediu." },
        },
      ],
      finalAssigneeType: "AI",
    });
    expect(outcome).toBe("HANDOFF_BLOCKED_BY_GATE");
    expect(statusForOutcome(outcome)).toBe("COMPLETED");
  });

  it("HANDOFF_COMPLETED só quando a atribuição saiu da IA", () => {
    const outcome = deriveRunOutcome({
      ...base,
      toolCalls: [
        {
          toolName: "execute_distribution",
          result: { ok: true, assigned: true },
        },
      ],
      finalAssigneeType: "AGENT",
    });
    expect(outcome).toBe("HANDOFF_COMPLETED");
    expect(statusForOutcome(outcome)).toBe("HANDOFF");
  });

  it("transferência para fila sem atendente ainda é saída da IA", () => {
    expect(
      deriveRunOutcome({
        ...base,
        toolCalls: [
          { toolName: "transfer_to_human", result: { queuedWaiting: true } },
        ],
        finalAssigneeType: null,
      }),
    ).toBe("HANDOFF_COMPLETED");
  });

  it("tool de efeito que falhou vira TOOL_FAILED, não sucesso", () => {
    expect(
      deriveRunOutcome({
        ...base,
        toolCalls: [{ toolName: "create_deal", result: { ok: false } }],
      }),
    ).toBe("TOOL_FAILED");
  });

  it("estourar teto nunca é sucesso", () => {
    expect(deriveRunOutcome({ ...base, limitReached: true })).toBe(
      "STEP_LIMIT_REACHED",
    );
  });

  it("turno sem base recuperada é NO_CONTEXT", () => {
    expect(deriveRunOutcome({ ...base, noRetrievalContext: true })).toBe(
      "NO_CONTEXT",
    );
  });

  it("resposta normal com base é ANSWERED", () => {
    expect(
      deriveRunOutcome({
        ...base,
        toolCalls: [{ toolName: "add_tag", result: { ok: true } }],
      }),
    ).toBe("ANSWERED");
  });

  it("gate tem precedência sobre teto — não esconde o motivo real", () => {
    expect(
      deriveRunOutcome({
        ...base,
        toolCalls: [
          {
            toolName: "execute_distribution",
            result: { ok: false, error: "Não distribua: sem pedido." },
          },
        ],
        limitReached: true,
      }),
    ).toBe("HANDOFF_BLOCKED_BY_GATE");
  });
});
