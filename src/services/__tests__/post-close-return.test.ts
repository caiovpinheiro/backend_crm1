import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationFindFirst: vi.fn(),
  settings: {} as Record<string, string>,
}));

vi.mock("@/lib/prisma", () => ({ prisma: { conversation: { findFirst: mocks.conversationFindFirst } } }));
vi.mock("@/lib/org-settings", () => ({
  getOrgSettingOrDefault: async (key: string, fallback: string) => mocks.settings[key] ?? fallback,
}));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

import { isCourtesyOnlyInbound, resolvePostCloseInbound } from "../post-close-return";

const NOW = new Date("2026-01-10T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const resolved = (overrides: Partial<{ closedAt: Date; hasHumanReply: boolean }> = {}) => ({
  id: "conv-old",
  organizationId: "org-1",
  channelId: "ch-1",
  closedAt: minutesAgo(5),
  hasHumanReply: false,
  ...overrides,
});

const base = { contactId: "contact-1", channel: "whatsapp", channelId: "ch-1", messageType: "text", now: NOW };

describe("mensagem logo depois de uma conversa encerrada", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(mocks.settings)) delete mocks.settings[k];
    mocks.conversationFindFirst.mockResolvedValue(null);
  });

  it("cortesia dentro da janela fica na conversa encerrada", async () => {
    mocks.conversationFindFirst.mockResolvedValueOnce(resolved());
    const out = await resolvePostCloseInbound({ ...base, text: "Ta bm obrigado" });
    expect(out).toMatchObject({ kind: "courtesy", conversation: { id: "conv-old" }, windowMinutes: 15 });
    // Procura só o que foi encerrado nos últimos 15 minutos, no mesmo canal.
    const where = mocks.conversationFindFirst.mock.calls[0][0].where as { closedAt: { gte: Date }; channelId: string; status: string };
    expect(where.status).toBe("RESOLVED");
    expect(where.channelId).toBe("ch-1");
    expect(where.closedAt.gte.getTime()).toBe(minutesAgo(15).getTime());
  });

  it("cortesia sem conversa encerrada recente: caminho normal", async () => {
    const out = await resolvePostCloseInbound({ ...base, text: "ok" });
    expect(out).toBeNull();
  });

  it("pergunta com conteúdo não é cortesia; após atendimento de pessoa vai para a equipe", async () => {
    mocks.conversationFindFirst.mockResolvedValueOnce(resolved({ hasHumanReply: true, closedAt: minutesAgo(40) }));
    const out = await resolvePostCloseInbound({ ...base, text: "A solicitação foi aberta?" });
    expect(out).toMatchObject({ kind: "return_to_human", windowMinutes: 60 });
    const where = mocks.conversationFindFirst.mock.calls[0][0].where as { closedAt: { gte: Date } };
    expect(where.closedAt.gte.getTime()).toBe(minutesAgo(60).getTime());
  });

  it("pergunta após atendimento do agente de IA: caminho normal (a IA pode atender)", async () => {
    mocks.conversationFindFirst.mockResolvedValueOnce(resolved({ hasHumanReply: false }));
    const out = await resolvePostCloseInbound({ ...base, text: "E o prazo?" });
    expect(out).toBeNull();
  });

  it("mídia nunca é cortesia", async () => {
    mocks.conversationFindFirst.mockResolvedValue(resolved());
    expect(isCourtesyOnlyInbound("ok", "image")).toBe(false);
    // Adiamento logo depois do encerramento fica na conversa encerrada, sem IA.
    expect(isCourtesyOnlyInbound("Estou no trabalho chamou depoos", "text")).toBe(true);
    const out = await resolvePostCloseInbound({ ...base, text: "ok", messageType: "image" });
    expect(out).toBeNull();
  });

  it("janelas configuráveis; \"0\" desliga", async () => {
    mocks.settings["conversation.postCloseCourtesyMinutes"] = "0";
    mocks.settings["conversation.postCloseReturnToHumanMinutes"] = "0";
    mocks.conversationFindFirst.mockResolvedValue(resolved({ hasHumanReply: true }));
    expect(await resolvePostCloseInbound({ ...base, text: "obrigado" })).toBeNull();
    expect(await resolvePostCloseInbound({ ...base, text: "e agora?" })).toBeNull();
    expect(mocks.conversationFindFirst).not.toHaveBeenCalled();

    mocks.settings["conversation.postCloseCourtesyMinutes"] = "30";
    const out = await resolvePostCloseInbound({ ...base, text: "valeu" });
    expect(out).toMatchObject({ kind: "courtesy", windowMinutes: 30 });
  });

  it("erro no banco não derruba o inbound", async () => {
    mocks.conversationFindFirst.mockRejectedValue(new Error("conexão perdida"));
    expect(await resolvePostCloseInbound({ ...base, text: "obrigado" })).toBeNull();
  });
});
