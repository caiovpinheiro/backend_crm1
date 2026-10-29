import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  published: [] as Record<string, unknown>[],
  findFirstArgs: null as unknown,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        h.created.push(data);
        return { id: "m1", organizationId: "org-1", conversationId: data.conversationId, externalId: null, createdAt: new Date() };
      }),
    },
    conversation: {
      findFirst: vi.fn(async (args: unknown) => {
        h.findFirstArgs = args;
        return { id: "cv-1", number: 7 };
      }),
    },
  },
}));
vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: <T,>(d: T) => ({ ...d, organizationId: "org-1" }),
}));
vi.mock("@/lib/cache/message-versions", () => ({ noteMessageChange: vi.fn(async () => {}) }));
vi.mock("@/lib/realtime-events", () => ({
  publishNewMessage: vi.fn((p: Record<string, unknown>) => void h.published.push(p)),
}));
vi.mock("@/services/conversations", () => ({
  activeConversationOnAccountWhere: (w: Record<string, unknown>) => ({ ...w, active: true }),
}));

import {
  createWebchatSiteNote,
  findActiveWebchatConversation,
  WEBCHAT_NOTE_MAX_CHARS,
} from "@/lib/webchat/conversation-notes";

beforeEach(() => {
  h.created.length = 0;
  h.published.length = 0;
});

describe("nota do site", () => {
  it("é privada, do tipo note, autor Webchat, e vai para o SSE do inbox", async () => {
    const id = await createWebchatSiteNote({
      organizationId: "org-1",
      conversationId: "cv-1",
      contactId: "ct-1",
      content: "Evento no site: erro_pagamento",
    });
    expect(id).toBe("m1");
    expect(h.created[0]).toMatchObject({
      conversationId: "cv-1",
      messageType: "note",
      isPrivate: true,
      direction: "out",
      senderName: "Webchat",
    });
    expect(h.published[0]).toMatchObject({ conversationId: "cv-1", messageType: "note" });
  });

  it("corta o texto no teto", async () => {
    await createWebchatSiteNote({
      organizationId: "org-1",
      conversationId: "cv-1",
      contactId: "ct-1",
      content: "x".repeat(WEBCHAT_NOTE_MAX_CHARS + 50),
    });
    expect((h.created[0].content as string).length).toBe(WEBCHAT_NOTE_MAX_CHARS);
  });

  it("busca o ticket webchat ativo do contato no canal", async () => {
    expect(await findActiveWebchatConversation("ct-1", "ch-1")).toEqual({ id: "cv-1", number: 7 });
    expect((h.findFirstArgs as { where: unknown }).where).toEqual({
      contactId: "ct-1",
      channel: "webchat",
      channelId: "ch-1",
      active: true,
    });
  });
});
