import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  findConnectedBaileysChannel: vi.fn(),
  getWhatsAppGroup: vi.fn(),
  findGroupMessageForAction: vi.fn(),
  applyGroupMessageReaction: vi.fn(),
  parseGroupReactions: (raw: unknown) => (Array.isArray(raw) ? raw : []),
}));
const queue = vi.hoisted(() => ({ enqueueBaileysOutbound: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (h: (s: unknown) => unknown) => h({ user: { id: "u1", name: "William" } }),
}));
vi.mock("@/lib/authz", () => ({ requirePermission: async () => null }));
vi.mock("@/lib/queue", () => queue);
vi.mock("@/services/whatsapp-groups", () => svc);

import { POST } from "../route";

const ctx = { params: Promise.resolve({ id: "g1", messageId: "m1" }) };
const react = (emoji: unknown) =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify({ emoji }) }), ctx);

describe("POST /api/whatsapp-groups/:id/messages/:messageId/reaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.findConnectedBaileysChannel.mockResolvedValue({ id: "ch1" });
    svc.getWhatsAppGroup.mockResolvedValue({ id: "g1", jid: "1@g.us" });
    svc.findGroupMessageForAction.mockResolvedValue({
      id: "m1",
      waMessageId: "WA1",
      fromMe: false,
      fromJid: "77@lid",
      reactions: [],
    });
    svc.applyGroupMessageReaction.mockImplementation(async (_id, _cur, r) => [r]);
    queue.enqueueBaileysOutbound.mockResolvedValue({ id: "j1" });
  });

  it("reage na mensagem de um participante (key com participant)", async () => {
    const res = await react("👍");
    expect(res.status).toBe(200);
    expect(queue.enqueueBaileysOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "1@g.us",
        messageType: "reaction",
        reaction: { emoji: "👍", key: { id: "WA1", fromMe: false, participant: "77@lid" } },
      }),
    );
    expect(svc.applyGroupMessageReaction).toHaveBeenCalledWith("m1", [], { from: "me", emoji: "👍", name: "William" });
  });

  it("mesmo emoji de novo remove (o número tem uma reação só)", async () => {
    svc.findGroupMessageForAction.mockResolvedValue({
      id: "m1", waMessageId: "WA1", fromMe: true, fromJid: "me",
      reactions: [{ emoji: "👍", from: "me", name: "Caio" }],
    });
    await react("👍");
    expect(queue.enqueueBaileysOutbound.mock.calls[0][0].reaction).toEqual({
      emoji: "",
      key: { id: "WA1", fromMe: true, participant: null },
    });
  });

  it("mensagem antiga sem id do WhatsApp: 409 e nada sai", async () => {
    svc.findGroupMessageForAction.mockResolvedValue({ id: "m1", waMessageId: null, fromMe: true, fromJid: "me", reactions: [] });
    expect((await react("👍")).status).toBe(409);
    expect(queue.enqueueBaileysOutbound).not.toHaveBeenCalled();
  });

  it("reação inválida: 400; mensagem de outro grupo: 404", async () => {
    expect((await react("x".repeat(20))).status).toBe(400);
    svc.findGroupMessageForAction.mockResolvedValue(null);
    expect((await react("👍")).status).toBe(404);
  });
});
