import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  convFindUnique: vi.fn(),
  messageFindMany: vi.fn(),
  listLeaves: vi.fn(),
  resolveAutoClose: vi.fn(),
  generate: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique: mocks.convFindUnique },
    message: { findMany: mocks.messageFindMany },
  },
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/services/tabulations", () => ({
  listActiveTabulationLeaves: mocks.listLeaves,
  resolveAutoCloseTabulation: mocks.resolveAutoClose,
}));
vi.mock("@/services/ai/provider", () => ({ generateWithTools: mocks.generate }));
vi.mock("@/services/ai/agent-key", () => ({ getAgentApiKey: vi.fn(async () => "k") }));
vi.mock("@/services/ai/tabulation-classify", () => ({ applyConversationTabulation: mocks.apply }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { applyV2Tabulation, parseTabulationChoice, tabulationAppliesAt } from "@/services/ai-v2/tabulation";

const cfg = (tabulation: Record<string, unknown>) =>
  normalizeV2Config({ name: "A", tone: "t", themes: [{ id: "t1", name: "Assunto 1", instructions: "x" }], tabulation } as never);

const LEAVES = [
  { id: "leaf-a", number: 1, path: "Grupo › Resolvido", departmentId: "d1", departmentName: "Suporte" },
  { id: "leaf-b", number: 2, path: "Grupo › Cancelamento", departmentId: "d1", departmentName: "Suporte" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.convFindUnique.mockResolvedValue({ departmentId: "d1" });
  mocks.messageFindMany.mockResolvedValue([
    { direction: "out", authorType: "bot", content: "Pronto, cancelamento registrado.", createdAt: new Date(), aiAgentUserId: "u1" },
    { direction: "in", authorType: "human", content: "quero cancelar", createdAt: new Date(), aiAgentUserId: null },
  ]);
  mocks.listLeaves.mockResolvedValue(LEAVES);
  mocks.resolveAutoClose.mockResolvedValue(null);
  mocks.apply.mockResolvedValue({ ok: true, tabulation: { name: "Cancelamento" } });
});

const run = (tabulation: Record<string, unknown>, moment: "close" | "transfer" = "close") => {
  const config = cfg(tabulation);
  return applyV2Tabulation({ config, theme: config.themes[0], moment, organizationId: "org", conversationId: "c1", agentId: "agent-1" });
};

describe("tabulação", () => {
  it("resposta do modelo: só id da lista vale", () => {
    const ids = new Set(["leaf-a"]);
    expect(parseTabulationChoice({ id: "leaf-a", reason: "ok" }, ids)).toEqual({ id: "leaf-a", reason: "ok" });
    expect(parseTabulationChoice({ id: "inventado" }, ids).id).toBeNull();
    expect(parseTabulationChoice(null, ids).id).toBeNull();
  });

  it("momento", () => {
    expect(tabulationAppliesAt(cfg({ enabled: false }), "close")).toBe(false);
    expect(tabulationAppliesAt(cfg({ enabled: true, when: "on_transfer" }), "close")).toBe(false);
    expect(tabulationAppliesAt(cfg({ enabled: true, when: "always" }), "transfer")).toBe(true);
  });

  it("modo agente: escolhe a folha lendo o atendimento", async () => {
    mocks.generate.mockResolvedValue({ text: '{"id":"leaf-b","reason":"cliente pediu cancelamento"}' });
    await run({ enabled: true, strategy: "ai", fallbackId: "leaf-a" });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const prompt = mocks.generate.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("leaf-b: Suporte › Grupo › Cancelamento");
    expect(prompt).toContain("Cliente: quero cancelar");
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ tabulationId: "leaf-b" }));
  });

  it("modo agente sem decisão (ou id inventado): vale a regra fixa", async () => {
    mocks.generate.mockResolvedValue({ text: '{"id":null}' });
    await run({ enabled: true, strategy: "ai", fallbackId: "leaf-a" });
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ tabulationId: "leaf-a" }));

    mocks.apply.mockClear();
    mocks.generate.mockResolvedValue({ text: '{"id":"xyz"}' });
    await run({ enabled: true, strategy: "ai", byTheme: { t1: "leaf-b" } });
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ tabulationId: "leaf-b" }));
  });

  it("lista permitida restringe as opções do agente", async () => {
    mocks.generate.mockResolvedValue({ text: '{"id":"leaf-a"}' });
    await run({ enabled: true, strategy: "ai", allowedIds: ["leaf-b"] });
    const prompt = mocks.generate.mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toContain("leaf-a:");
    // leaf-a não estava entre as permitidas: ignorada, sem padrão → sem tabulação.
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("modo fixo não chama o modelo", async () => {
    await run({ enabled: true, fallbackId: "leaf-a" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ tabulationId: "leaf-a" }));
  });
});
