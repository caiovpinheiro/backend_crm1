import { beforeEach, describe, expect, it, vi } from "vitest";

const count = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { aIAgentRun: { count: (...a: unknown[]) => count(...a) } },
}));

import {
  aiHandoffCapReached,
  MAX_AI_HANDOFFS_PER_CONVERSATION,
} from "@/services/ai/agent-handoff";

beforeEach(() => {
  count.mockReset();
});

describe("teto de transferências entre agentes IA por conversa", () => {
  it("libera enquanto está abaixo do teto", async () => {
    count.mockResolvedValue(MAX_AI_HANDOFFS_PER_CONVERSATION - 1);
    await expect(aiHandoffCapReached("conv-1")).resolves.toBe(false);
  });

  it("corta ao atingir o teto", async () => {
    count.mockResolvedValue(MAX_AI_HANDOFFS_PER_CONVERSATION);
    await expect(aiHandoffCapReached("conv-1")).resolves.toBe(true);
  });

  // Conta a conversa inteira, não o run: era por isso que cada turno novo
  // reabria o orçamento de transferências.
  it("conta os runs de handoff da conversa", async () => {
    count.mockResolvedValue(0);
    await aiHandoffCapReached("conv-1");
    expect(count).toHaveBeenCalledWith({
      where: { conversationId: "conv-1", outcome: "HANDOFF_COMPLETED" },
    });
  });

  it("sem conversa, não trava nem consulta", async () => {
    await expect(aiHandoffCapReached(null)).resolves.toBe(false);
    expect(count).not.toHaveBeenCalled();
  });
});
