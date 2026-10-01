import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InboxPolicy } from "@/lib/ai-agents/steering";

const runAgent = vi.fn();

vi.mock("@/services/ai/runner", () => ({
  runAgent: (...args: unknown[]) => runAgent(...args),
}));

const POLICY = { messageRules: [] } as unknown as InboxPolicy;

function turnInput(sendText: (text: string) => Promise<void>) {
  return {
    conversationId: "conv-1",
    contactId: "contact-1",
    userMessage: "primeiro acesso",
    agentConfigId: "agent-1",
    policy: POLICY,
    sendText,
    defaultQueueText: () => "fila",
  };
}

describe("turno em modo de teste", () => {
  beforeEach(() => {
    runAgent.mockReset();
  });

  it("não envia o marcador interno de confiança ao operador", async () => {
    runAgent.mockResolvedValue({
      status: "COMPLETED",
      text: "Opa, vou te ajudar com o primeiro acesso.\n\n[CONFIANCA:0.9]",
      toolCalls: [],
    });
    const sent: string[] = [];
    const { runAiTestTurn } = await import("@/services/ai/test-mode-turn");

    await runAiTestTurn(turnInput(async (t) => void sent.push(t)));

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("CONFIANCA");
    expect(sent[0]).toBe("Opa, vou te ajudar com o primeiro acesso.");
  });

  it("resposta sem marcador segue intacta", async () => {
    runAgent.mockResolvedValue({
      status: "COMPLETED",
      text: "Segue o passo a passo.",
      toolCalls: [],
    });
    const sent: string[] = [];
    const { runAiTestTurn } = await import("@/services/ai/test-mode-turn");

    await runAiTestTurn(turnInput(async (t) => void sent.push(t)));

    expect(sent).toEqual(["Segue o passo a passo."]);
  });
});
