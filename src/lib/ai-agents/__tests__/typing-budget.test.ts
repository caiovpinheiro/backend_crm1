import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { MIN_TYPING_MS, computeTypingDelayMs, typingDelayWithinBudget } from "@/lib/ai-agents/piloting";

describe("digitando… dentro do orçamento", () => {
  it("respeita o teto", () => {
    const long = computeTypingDelayMs(900, 25);
    expect(long).toBe(24_000);
    expect(typingDelayWithinBudget(long, { maxTypingMs: 8000 })).toBe(8000);
  });

  it("desconta o tempo que o turno já levou, com piso", () => {
    const now = 100_000;
    expect(typingDelayWithinBudget(6000, { maxTypingMs: 8000, turnStartedAt: now - 2000 }, now)).toBe(4000);
    expect(typingDelayWithinBudget(6000, { maxTypingMs: 8000, turnStartedAt: now - 20_000 }, now)).toBe(MIN_TYPING_MS);
  });

  it("sem orçamento: igual à fórmula", () => {
    expect(typingDelayWithinBudget(3000, {})).toBe(3000);
  });
});
