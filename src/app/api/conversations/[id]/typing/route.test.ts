/**
 * POST /typing publica o evento SSE `typing` para os outros agentes mesmo
 * quando o canal Meta não repassa o indicador (sem config / sem recibo de
 * leitura) — o "digitando…" do CRM não depende do WhatsApp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publish, findUnique, findFirst, metaConfigured } = vi.hoisted(() => ({
  publish: vi.fn(),
  findUnique: vi.fn(async () => ({
    organizationId: "org_1",
    contactId: "contact_1",
    channelRef: { id: "ch_1", config: {} },
  })),
  findFirst: vi.fn(async () => null),
  metaConfigured: { value: false },
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: vi.fn(
    async (handler: (session: unknown) => unknown) =>
      handler({
        user: { id: "user_a", name: "Ana", organizationId: "org_1" },
      }),
  ),
}));
vi.mock("@/lib/conversation-access", () => ({
  requireConversationAccess: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findUnique },
    message: { findFirst },
  },
}));
vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaClientFromConfig: () => ({ configured: metaConfigured.value }),
}));
vi.mock("@/lib/channels/config", () => ({
  channelSendsReadReceipts: () => false,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish } }));

import { POST } from "@/app/api/conversations/[id]/typing/route";
import { __resetTypingThrottleForTests } from "@/lib/realtime-events";

function call(id = "conv_1") {
  return POST(new Request("http://localhost/api/conversations/x/typing", { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

describe("POST /api/conversations/:id/typing → SSE typing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-30T12:00:00.000Z"));
    publish.mockReset();
    findUnique.mockClear();
    __resetTypingThrottleForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publica `typing` com conversationId/contactId/userId/until mesmo sem Meta", async () => {
    const res = await call();
    expect(await res.json()).toEqual({ ok: false }); // Meta não configurada
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("typing", {
      organizationId: "org_1",
      conversationId: "conv_1",
      contactId: "contact_1",
      userId: "user_a",
      userName: "Ana",
      source: "agent",
      until: "2026-09-30T12:00:05.000Z",
    });
  });

  it("duas chamadas em 3s publicam uma vez; depois de 3s publica de novo", async () => {
    await call();
    vi.advanceTimersByTime(2_000);
    await call();
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await call();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("conversa inexistente: nada publicado", async () => {
    findUnique.mockResolvedValueOnce(null as never);
    await call("conv_404");
    expect(publish).not.toHaveBeenCalled();
  });
});
