/**
 * MA-4: POST /read publica `conversation_updated` mínimo para as outras
 * abas zerarem o badge de não lidas sem refetch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { publish, update, findUnique, findFirst } = vi.hoisted(() => ({
  publish: vi.fn(),
  update: vi.fn(async () => ({})),
  findUnique: vi.fn(async () => ({ channelRef: { id: "ch_1", config: {} } })),
  findFirst: vi.fn(async () => null),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: vi.fn(
    async (handler: (session: unknown) => unknown) =>
      handler({ user: { id: "user_1", organizationId: "org_1" } }),
  ),
}));
vi.mock("@/lib/conversation-access", () => ({
  requireConversationAccess: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { update, findUnique },
    message: { findFirst },
  },
}));
vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaClientFromConfig: () => ({ configured: false }),
}));
vi.mock("@/lib/channels/config", () => ({
  channelSendsReadReceipts: () => false,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish } }));

import { POST } from "@/app/api/conversations/[id]/read/route";

beforeEach(() => {
  publish.mockReset();
  update.mockClear();
});

describe("POST /api/conversations/[id]/read", () => {
  it("zera unread e publica conversation_updated mínimo", async () => {
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ id: "conv_1" }),
    });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "conv_1" },
        data: expect.objectContaining({ unreadCount: 0 }),
      }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("conversation_updated", {
      organizationId: "org_1",
      conversationId: "conv_1",
      unreadCount: 0,
    });
  });

  it("falha no publish não derruba o read", async () => {
    publish.mockImplementation(() => {
      throw new Error("bus down");
    });
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), {
      params: Promise.resolve({ id: "conv_2" }),
    });
    expect(res.status).toBe(200);
  });
});
