import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  findConnectedBaileysChannel: vi.fn(),
  getWhatsAppGroup: vi.fn(),
  listWhatsAppGroupMessages: vi.fn(),
  appendWhatsAppGroupMessage: vi.fn(),
}));
const queue = vi.hoisted(() => ({ enqueueBaileysOutbound: vi.fn() }));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ ok: true, session: { user: { id: "u1", name: "Ana" } } }),
}));
vi.mock("@/lib/authz", () => ({ requirePermission: async () => null }));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org1",
  getRequestContext: () => undefined,
}));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/services/whatsapp-groups", () => svc);

import { GET, POST } from "../route";

const ctx = { params: Promise.resolve({ id: "g1" }) };
const post = (text: string) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify({ text }) }), ctx);

describe("POST /api/whatsapp-groups/:id/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1", phoneNumber: "+55 11 90000-0000" });
    svc.getWhatsAppGroup.mockResolvedValue({ id: "g1", jid: "1@g.us" });
    queue.enqueueBaileysOutbound.mockResolvedValue({ id: "job1" });
  });

  it("devolve JSON 200 com a mensagem gravada", async () => {
    svc.appendWhatsAppGroupMessage.mockResolvedValue({ id: "m1", text: "oi" });
    const res = await post("oi");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, message: { id: "m1" } });
  });

  it("mensagem já enfileirada: falha ao gravar o histórico não vira 500 sem corpo", async () => {
    svc.appendWhatsAppGroupMessage.mockRejectedValue(new Error('relation "whatsapp_group_messages" does not exist'));
    const res = await post("testando!");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toMatchObject({ ok: true, message: null });
    expect(queue.enqueueBaileysOutbound).toHaveBeenCalledOnce();
  });
});

describe("GET /api/whatsapp-groups/:id/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1", phoneNumber: null });
    svc.getWhatsAppGroup.mockResolvedValue({ id: "g1", jid: "1@g.us" });
  });

  it("erro do banco vira JSON com mensagem (não página HTML)", async () => {
    svc.listWhatsAppGroupMessages.mockRejectedValue(new Error("boom"));
    const res = await GET(new Request("http://x"), ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).message).toMatch(/mensagens/i);
  });
});
