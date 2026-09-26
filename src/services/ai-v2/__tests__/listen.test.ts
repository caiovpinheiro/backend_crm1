import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const exec = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: { $queryRawUnsafe: (...a: unknown[]) => query(...a), $executeRawUnsafe: (...a: unknown[]) => exec(...a) } }));
vi.mock("@/services/ai/agent-key", () => ({ getAgentApiKey: vi.fn(async () => "sk-test"), getAgentChatKey: vi.fn() }));
const saveDraft = vi.fn(async () => ({}));
vi.mock("../agents", () => ({
  getV2Agent: vi.fn(async () => ({ id: "ag", name: "Agente", draftConfig: config, publishedConfig: config })),
  saveV2AgentDraft: (...a: unknown[]) => saveDraft(...(a as [])),
}));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { SELECT_CONVERSATIONS_SQL, applyListenProposal, startListen } from "../listen";

const config = normalizeV2Config({
  name: "Agente",
  tone: "Cordial.",
  autonomyMode: "auto",
  handoff: { defaultDestination: { type: "department", id: "dep-1" }, message: "Vou transferir." },
} as never);

beforeEach(() => {
  query.mockReset();
  exec.mockReset();
  saveDraft.mockClear();
  exec.mockResolvedValue(1);
});

describe("escutar a equipe — ligar", () => {
  const base = { organizationId: "org", agentId: "ag", userId: "u-admin", mode: "today" as const };

  it("só pessoas humanas da organização, no máximo 10", async () => {
    query.mockResolvedValueOnce([{ id: "u1" }]); // só 1 das 2 é válida
    await expect(startListen({ ...base, userIds: ["u1", "u-outra-org"] })).rejects.toThrow(/não é da equipe/);
    await expect(startListen({ ...base, userIds: Array.from({ length: 11 }, (_, i) => `u${i}`) })).rejects.toThrow(/no máximo 10/);
    await expect(startListen({ ...base, userIds: [] })).rejects.toThrow(/pelo menos uma/);
  });

  it("uma escuta ligada por agente; vencida é fechada e não bloqueia", async () => {
    query.mockResolvedValueOnce([{ id: "u1" }]).mockResolvedValueOnce([{ id: "s1", status: "on", endsAt: null }]);
    await expect(startListen({ ...base, userIds: ["u1"] })).rejects.toThrow(/Já existe uma escuta/);

    query.mockResolvedValueOnce([{ id: "u1" }]).mockResolvedValueOnce([{ id: "s0", status: "on", endsAt: new Date("2020-01-01") }]);
    const { sessionId } = await startListen({ ...base, userIds: ["u1"] });
    expect(sessionId).toBeTruthy();
    expect(exec.mock.calls.some((c) => String(c[0]).includes(`"status"='expired'`) && c[1] === "s0")).toBe(true);
    const insert = exec.mock.calls.find((c) => String(c[0]).includes(`INSERT INTO "ai_v2_listen_sessions"`));
    expect(insert?.[4]).toBe(JSON.stringify(["u1"]));
    expect(insert?.[9]).toBe("u-admin");
  });
});

describe("escutar a equipe — captação", () => {
  it("só conversas encerradas ou paradas há 1 h, não lidas ou com mensagens novas, dentro do período", () => {
    expect(SELECT_CONVERSATIONS_SQL).toContain(`c."closedAt" IS NOT NULL OR c."updatedAt" < now() - interval '60 minutes'`);
    expect(SELECT_CONVERSATIONS_SQL).toContain(`s."id" IS NULL OR conv."lastAt" > s."watermarkAt" + interval '1 hour'`);
    expect(SELECT_CONVERSATIONS_SQL).toContain(`$6::timestamptz IS NULL OR e."occurredAt" <= $6`);
    expect(SELECT_CONVERSATIONS_SQL).toContain(`"type"='MESSAGE_SENT'`);
  });
});

describe("escutar a equipe — aplicar proposta", () => {
  const proposal = (patch: Record<string, unknown>) => ({
    id: "p1", sessionId: "s1", kind: "tone", title: "Tom", summary: "", occurrences: 4, sampleCount: 5, evidence: [], status: "open",
    payload: { alteracoes: [{ path: "tone", op: "set", value: "Próximo e simples.", before: "Cordial." }] }, createdAt: new Date(), ...patch,
  });

  it("tom e abordagem vão para o rascunho", async () => {
    query.mockResolvedValueOnce([proposal({})]);
    const r = await applyListenProposal({ organizationId: "org", agentId: "ag", proposalId: "p1", userId: "u-admin" });
    expect(r.applied).toBe(true);
    expect(saveDraft).toHaveBeenCalledWith("ag", "org", { config: expect.objectContaining({ tone: "Próximo e simples." }) });
    expect(exec.mock.calls.some((c) => c[1] === "p1" && c[2] === "applied")).toBe(true);
  });

  it("alteração que não cabe mais vira 'desatualizada' com o motivo", async () => {
    query.mockResolvedValueOnce([proposal({ payload: { alteracoes: [{ path: "themes[id=nao-existe].instructions", op: "set", value: "x" }] } })]);
    const r = await applyListenProposal({ organizationId: "org", agentId: "ag", proposalId: "p1", userId: "u-admin" });
    expect(r.applied).toBe(false);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(exec.mock.calls.some((c) => c[1] === "p1" && c[2] === "stale")).toBe(true);
  });

  it("conhecimento: registra o material criado pela tela", async () => {
    query.mockResolvedValueOnce([proposal({ kind: "knowledge", payload: { title: "T", content: "C" } })]);
    await expect(applyListenProposal({ organizationId: "org", agentId: "ag", proposalId: "p1", userId: "u" })).rejects.toThrow(/material criado/);
    query.mockResolvedValueOnce([proposal({ kind: "knowledge", payload: { title: "T", content: "C" } })]);
    expect((await applyListenProposal({ organizationId: "org", agentId: "ag", proposalId: "p1", userId: "u", knowledgeDocId: "doc-9" })).applied).toBe(true);
    expect(exec.mock.calls.some((c) => c[1] === "p1" && c[3] === "doc-9")).toBe(true);
  });
});
