import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  conversation: null as Record<string, unknown> | null,
  denied: false,
  canOpen: true,
  findActive: vi.fn(),
  access: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  authenticateApiRequest: vi.fn(async () => ({
    ok: true,
    user: { id: "u1", role: "MEMBER", organizationId: "org-1" },
  })),
  runWithApiUserContext: vi.fn((_user: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { conversation: { findFirst: vi.fn() } } }));
vi.mock("@/lib/conversation-access", () => ({
  CONVERSATION_ACCESS_SELECT: {},
  requireConversationAccessAndLoad: vi.fn(async () =>
    h.denied
      ? { response: new Response(JSON.stringify({ message: "x" }), { status: 404 }) }
      : { conversation: h.conversation },
  ),
  userHasConversationAccess: h.access,
}));
vi.mock("@/lib/webchat/active-conversation", () => ({
  findActiveWebchatConversationForContact: h.findActive,
}));

import { GET } from "@/app/api/conversations/[id]/active-webchat/route";

const call = () =>
  GET(new Request("http://localhost/api/conversations/c1/active-webchat"), {
    params: Promise.resolve({ id: "c1" }),
  });

beforeEach(() => {
  h.denied = false;
  h.conversation = { id: "c1", organizationId: "org-1", contactId: "ct1", channel: "whatsapp" };
  h.findActive.mockReset();
  h.access.mockReset();
});

describe("GET /api/conversations/:id/active-webchat", () => {
  it("sem acesso à conversa: 404, sem consultar o contato", async () => {
    h.denied = true;
    const res = await call();
    expect(res.status).toBe(404);
    expect(h.findActive).not.toHaveBeenCalled();
  });

  it("conversa de webchat não consulta", async () => {
    h.conversation = { ...h.conversation, channel: "webchat" };
    const res = await call();
    expect(await res.json()).toEqual({ active: null });
    expect(h.findActive).not.toHaveBeenCalled();
  });

  it("conversa sem contato não consulta", async () => {
    h.conversation = { ...h.conversation, contactId: null };
    expect(await (await call()).json()).toEqual({ active: null });
    expect(h.findActive).not.toHaveBeenCalled();
  });

  it("usa a org e o contato da própria conversa, sem cache", async () => {
    const active = { id: "w1", number: 42, reason: "online" };
    h.findActive.mockResolvedValue(active);
    const res = await call();
    expect(await res.json()).toEqual({ active });
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(h.findActive).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", contactId: "ct1" }),
    );
  });

  it("confere o acesso do usuário ao ticket do aviso", async () => {
    h.access.mockResolvedValue(false);
    h.findActive.mockImplementation(async (a: { canOpen: (id: string) => Promise<boolean> }) =>
      (await a.canOpen("w1")) ? { id: "w1" } : null,
    );
    expect(await (await call()).json()).toEqual({ active: null });
    expect(h.access).toHaveBeenCalledWith(
      expect.objectContaining({ id: "u1" }),
      "w1",
      expect.anything(),
    );
  });
});
