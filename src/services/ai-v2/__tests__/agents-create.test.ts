import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  agentCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findFirst: mocks.userFindFirst },
    $transaction: async (cb: (tx: unknown) => unknown) =>
      cb({
        user: { create: mocks.userCreate },
        aIAgentConfig: { create: mocks.agentCreate },
      }),
  },
}));

vi.mock("@/lib/public-id", () => ({ nextUserNumber: vi.fn().mockResolvedValue(7) }));

import { createV2Agent } from "../agents";

describe("createV2Agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: "u-ai" });
    mocks.agentCreate.mockResolvedValue({ id: "ag-1" });
  });

  it("nasce desligado: quem liga é a primeira publicação", async () => {
    await createV2Agent("org", { name: "Agente", preset: "blank" });
    expect(mocks.agentCreate.mock.calls[0][0].data.active).toBe(false);
  });

  it("respeita o estado pedido na criação", async () => {
    await createV2Agent("org", { name: "Agente", preset: "blank", active: true });
    expect(mocks.agentCreate.mock.calls[0][0].data.active).toBe(true);
  });
});
