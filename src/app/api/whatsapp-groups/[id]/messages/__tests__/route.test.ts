import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  findConnectedBaileysChannel: vi.fn(),
  getWhatsAppGroup: vi.fn(),
  listWhatsAppGroupMessages: vi.fn(),
  appendWhatsAppGroupMessage: vi.fn(),
  deleteGroupMessage: vi.fn(),
  groupReplyFor: vi.fn(),
}));
const queue = vi.hoisted(() => ({ enqueueBaileysOutbound: vi.fn() }));

const ctxOrg = vi.hoisted(() => ({ value: "org1" as string | null }));
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: async () => ({ ok: true, session: { user: { id: "u1", name: "Ana" } } }),
  // Como o real: o handler roda dentro do contexto da org (runWithContext).
  withOrgContext: async (h: (s: unknown) => unknown) => {
    ctxOrg.value = "org1";
    try {
      return await h({ user: { id: "u1", name: "Ana" } });
    } finally {
      ctxOrg.value = null;
    }
  },
}));
vi.mock("@/lib/authz", () => ({ requirePermission: async () => null }));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => {
    if (!ctxOrg.value) throw new Error("getOrgIdOrThrow: organization context ausente");
    return ctxOrg.value;
  },
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

describe("POST — responder e id do WhatsApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1", phoneNumber: "5511900000000" });
    svc.getWhatsAppGroup.mockResolvedValue({ id: "g1", jid: "1@g.us" });
    svc.appendWhatsAppGroupMessage.mockResolvedValue({ id: "m9", text: "ok" });
    queue.enqueueBaileysOutbound.mockResolvedValue({ id: "job1" });
  });
  const postBody = (body: unknown) =>
    POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), ctx);

  it("grava antes e manda o id para o worker guardar o id do WhatsApp", async () => {
    await postBody({ text: "oi" });
    expect(queue.enqueueBaileysOutbound).toHaveBeenCalledWith(expect.objectContaining({ groupMessageId: "m9" }));
  });

  it("responder cita a original no WhatsApp e grava o quadro", async () => {
    const reply = {
      quoted: { id: "WA1", fromMe: false, participant: "77@lid", text: "folha assinada" },
      replyTo: { waId: "WA1", text: "folha assinada", author: "Kleber Raia" },
    };
    svc.groupReplyFor.mockResolvedValue(reply);
    await postBody({ text: "certo", replyToMessageId: "m1" });
    expect(svc.groupReplyFor).toHaveBeenCalledWith("g1", "m1");
    expect(svc.appendWhatsAppGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ replyTo: reply.replyTo }));
    expect(queue.enqueueBaileysOutbound).toHaveBeenCalledWith(expect.objectContaining({ quoted: reply.quoted }));
  });

  it("original antiga sem id: devolve o erro e não envia", async () => {
    svc.groupReplyFor.mockResolvedValue({ error: "antiga", status: 409 });
    expect((await postBody({ text: "x", replyToMessageId: "m1" })).status).toBe(409);
    expect(queue.enqueueBaileysOutbound).not.toHaveBeenCalled();
  });

  it("fila fora: apaga a linha gravada (não saiu no WhatsApp)", async () => {
    queue.enqueueBaileysOutbound.mockResolvedValue(null);
    svc.deleteGroupMessage.mockResolvedValue(undefined);
    expect((await postBody({ text: "x" })).status).toBe(503);
    expect(svc.deleteGroupMessage).toHaveBeenCalledWith("m9");
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
