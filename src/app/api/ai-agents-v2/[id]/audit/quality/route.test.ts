import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requirePermission: vi.fn(async (): Promise<Response | null> => null),
  listQualityRuns: vi.fn(async (): Promise<unknown[]> => []),
  startQualityRun: vi.fn(async (): Promise<{ runId: string }> => ({ runId: "run-1" })),
  getQualityRun: vi.fn(async (): Promise<unknown> => null),
  estimateQualityRun: vi.fn(async (): Promise<unknown> => ({ turns: 10 })),
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: mocks.requireAuth,
  requirePermission: mocks.requirePermission,
  runInSessionContext: (_s: unknown, fn: () => Promise<Response>) => fn(),
}));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/services/ai-v2/reply-quality", () => ({
  listQualityRuns: mocks.listQualityRuns,
  startQualityRun: mocks.startQualityRun,
  getQualityRun: mocks.getQualityRun,
  estimateQualityRun: mocks.estimateQualityRun,
}));

const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ id: "agent-1", ...extra }) });
const post = (body: unknown) => new Request("http://x/api/ai-agents-v2/agent-1/audit/quality", { method: "POST", body: JSON.stringify(body) });

describe("/api/ai-agents-v2/[id]/audit/quality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ ok: true, session: { user: { id: "u1", organizationId: "org-1" } } });
    mocks.requirePermission.mockResolvedValue(null);
    mocks.startQualityRun.mockResolvedValue({ runId: "run-1" });
  });

  it("lista as análises do agente na organização da sessão", async () => {
    mocks.listQualityRuns.mockResolvedValue([{ id: "run-1", status: "done" }]);
    const { GET } = await import("./route");
    const res = await GET(new Request("http://x"), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [{ id: "run-1", status: "done" }] });
    expect(mocks.listQualityRuns).toHaveBeenCalledWith("org-1", "agent-1");
  });

  it("inicia em segundo plano: 202 com o id; repassa o corpo e o usuário", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ from: "2026-10-07", to: "2026-10-11", claimSample: 100 }), params());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "run-1" });
    expect(mocks.startQualityRun).toHaveBeenCalledWith({ organizationId: "org-1", agentId: "agent-1", userId: "u1", input: { from: "2026-10-07", to: "2026-10-11", claimSample: 100 } });
  });

  it("erros conhecidos viram status próprios: sem chave 400, em andamento 409, agente 404", async () => {
    const { POST } = await import("./route");
    mocks.startQualityRun.mockRejectedValueOnce(new Error("NO_OPENAI_KEY"));
    expect((await POST(post({}), params())).status).toBe(400);
    mocks.startQualityRun.mockRejectedValueOnce(new Error("Já existe uma análise em andamento para este agente."));
    expect((await POST(post({}), params())).status).toBe(409);
    mocks.startQualityRun.mockRejectedValueOnce(new Error("Agente não encontrado."));
    expect((await POST(post({}), params())).status).toBe(404);
    mocks.startQualityRun.mockRejectedValueOnce(new Error("falha"));
    expect((await POST(post({}), params())).status).toBe(500);
  });

  it("sem permissão: devolve a resposta da checagem e não roda nada", async () => {
    mocks.requirePermission.mockResolvedValue(new Response(null, { status: 403 }));
    const { POST, GET } = await import("./route");
    expect((await POST(post({}), params())).status).toBe(403);
    expect((await GET(new Request("http://x"), params())).status).toBe(403);
    expect(mocks.startQualityRun).not.toHaveBeenCalled();
    expect(mocks.listQualityRuns).not.toHaveBeenCalled();
  });

  it("estimativa lê o período da URL; análise inexistente dá 404", async () => {
    const est = await import("./estimate/route");
    const res = await est.GET(new Request("http://x/est?from=2026-10-07&to=2026-10-11&claimSample=50"), params());
    expect(res.status).toBe(200);
    expect(mocks.estimateQualityRun).toHaveBeenCalledWith("org-1", "agent-1", { from: "2026-10-07", to: "2026-10-11", claimSample: "50" });

    const one = await import("./[runId]/route");
    expect((await one.GET(new Request("http://x"), { params: Promise.resolve({ id: "agent-1", runId: "nope" }) })).status).toBe(404);
    mocks.getQualityRun.mockResolvedValueOnce({ id: "run-1", status: "running" });
    const ok = await one.GET(new Request("http://x"), { params: Promise.resolve({ id: "agent-1", runId: "run-1" }) });
    expect(await ok.json()).toEqual({ id: "run-1", status: "running" });
    expect(mocks.getQualityRun).toHaveBeenLastCalledWith("org-1", "agent-1", "run-1");
  });
});
