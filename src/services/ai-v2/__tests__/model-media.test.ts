import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  templateFindFirst: vi.fn(),
  sendAgentMessage: vi.fn(),
  sendMedia: vi.fn(),
  mediaFromRow: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { messageTemplate: { findFirst: mocks.templateFindFirst } },
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrNull: () => "org-1", getOrgIdOrThrow: () => "org-1" }));
vi.mock("@/services/ai/piloting-actions", () => ({ sendAgentMessage: mocks.sendAgentMessage }));
vi.mock("@/services/ai/send-agent-media", () => ({ sendAgentFollowUpMedia: mocks.sendMedia }));
vi.mock("@/services/ai/message-models-retrieval", () => ({ mediaFromTemplateRow: mocks.mediaFromRow }));

import { executeV2Actions } from "../actions";

function ctx(autonomyMode: "AUTONOMOUS" | "DRAFT" = "AUTONOMOUS") {
  return {
    organizationId: "org-1",
    conversationId: "conv-1",
    contactId: "contact-1",
    agentUserId: "ai-1",
    agentId: "agent-1",
    config: { variables: [] } as any,
    context: { contact: {}, selectedDeal: null } as any,
    llmOutput: {} as any,
    channel: "meta",
    autonomyMode,
  };
}

const VIDEO = { url: "/api/storage/org-1/tutorial.mp4", mimeType: "video/mp4", name: "tutorial.mp4" };

describe("send_message_model com anexos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendAgentMessage.mockResolvedValue({ status: "sent", messageId: "m1" });
    mocks.sendMedia.mockResolvedValue(1);
  });

  it("envia o texto e depois os anexos", async () => {
    mocks.templateFindFirst.mockResolvedValue({ id: "mm-1", name: "Tutorial", content: "Veja o passo a passo:", mediaUrl: VIDEO.url });
    mocks.mediaFromRow.mockReturnValue([VIDEO]);
    const order: string[] = [];
    mocks.sendAgentMessage.mockImplementation(async () => { order.push("texto"); return { status: "sent", messageId: "m" }; });
    mocks.sendMedia.mockImplementation(async () => { order.push("mídia"); return 1; });

    const r = await executeV2Actions([{ type: "send_message_model", modelId: "mm-1" } as any], ctx());

    expect(order).toEqual(["texto", "mídia"]);
    expect(mocks.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1", attachments: [VIDEO] }));
    expect(r.results[0]).toMatchObject({ ok: true, mediaSent: 1 });
  });

  it("modo sugestão não envia anexo", async () => {
    mocks.templateFindFirst.mockResolvedValue({ id: "mm-1", name: "Tutorial", content: "Veja:", mediaUrl: VIDEO.url });
    mocks.mediaFromRow.mockReturnValue([VIDEO]);

    await executeV2Actions([{ type: "send_message_model", modelId: "mm-1" } as any], ctx("DRAFT"));

    expect(mocks.sendMedia).not.toHaveBeenCalled();
  });

  it("mensagem pronta só com anexo (sem texto) envia só a mídia", async () => {
    mocks.templateFindFirst.mockResolvedValue({ id: "mm-2", name: "Só vídeo", content: "", mediaUrl: VIDEO.url });
    mocks.mediaFromRow.mockReturnValue([VIDEO]);

    await executeV2Actions([{ type: "send_message_model", modelId: "mm-2" } as any], ctx());

    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
    expect(mocks.sendMedia).toHaveBeenCalledTimes(1);
  });
});
