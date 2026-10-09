import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  convFindFirst: vi.fn(),
  msgFindFirst: vi.fn(),
  msgFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findFirst: mocks.convFindFirst },
    message: { findFirst: mocks.msgFindFirst, findMany: mocks.msgFindMany },
  },
}));
vi.mock("@/services/ai/agent-key", () => ({ getAgentChatKey: vi.fn(), tryGetAgentApiKey: vi.fn() }));
vi.mock("@/services/ai/provider", () => ({ generateWithTools: vi.fn() }));

import { loadPriorV2Summary } from "../summary";

describe("contexto da conversa anterior sem resumo gravado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.msgFindFirst.mockResolvedValue(null);
  });

  it("atendimento anterior de uma pessoa, encerrado há pouco: as últimas mensagens viram contexto", async () => {
    mocks.convFindFirst.mockResolvedValue({ id: "c-old", closedAt: new Date("2026-10-09T17:11:00Z") });
    mocks.msgFindMany.mockResolvedValue([
      { direction: "out", content: "Essa conversa está sendo encerrada por falta de interação.", authorType: "bot", senderName: "Fluxo" },
      { direction: "out", content: "Para cancelar: acesse a área do cliente, Solicitações, Cancelamento. Você receberá uma ligação em até 14 dias.", authorType: "human", senderName: "Equipe A" },
      { direction: "in", content: "Quero cancelar o plano", authorType: "human", senderName: null },
    ]);

    const out = await loadPriorV2Summary({ contactId: "ct-1", conversationId: "c-new" });

    expect(out?.current).toBe(false);
    expect(out?.text).toContain("Cliente: Quero cancelar o plano");
    expect(out?.text).toContain("Equipe (Equipe A): Para cancelar");
    expect(out?.text).toContain("Agente: Essa conversa está sendo encerrada");
    expect(out?.text.indexOf("Cliente:")).toBeLessThan(out!.text.indexOf("Equipe (Equipe A)"));
  });

  it("sem conversa anterior recente: nada", async () => {
    mocks.convFindFirst.mockResolvedValue(null);
    expect(await loadPriorV2Summary({ contactId: "ct-1", conversationId: "c-new" })).toBeNull();
  });

  it("resumo gravado tem prioridade sobre o trecho", async () => {
    mocks.msgFindFirst.mockResolvedValue({ content: "Motivo: X\nResultado: Y", createdAt: new Date(), senderName: "Agente" });
    const out = await loadPriorV2Summary({ contactId: "ct-1", conversationId: "c-new" });
    expect(out?.text).toBe("Motivo: X\nResultado: Y");
    expect(mocks.convFindFirst).not.toHaveBeenCalled();
  });
});
