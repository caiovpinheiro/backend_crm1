import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeV2Actions } from "../actions";
import { prisma } from "@/lib/prisma";
import { sendAgentMessage } from "@/services/ai/piloting-actions";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import type { V2Action, V2AgentConfig, V2LLMOutput } from "@/lib/ai-v2/types";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    messageTemplate: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
    note: { create: vi.fn() },
    conversation: { findUnique: vi.fn() },
    contact: { findUnique: vi.fn() },
    message: { create: vi.fn() },
    whatsAppTemplateConfig: { findFirst: vi.fn() },
  },
}));

vi.mock("@/services/ai/piloting-actions", () => ({
  sendAgentMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaClientFromConfig: vi.fn().mockReturnValue({ configured: false }),
}));

vi.mock("@/lib/meta-whatsapp/enrich-template-flow", () => ({
  enrichTemplateComponentsForFlowSend: vi.fn(),
}));

vi.mock("@/lib/sse-bus", () => ({
  sseBus: { publish: vi.fn() },
}));

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org-1",
    conversationId: "conv-1",
    contactId: "contact-1",
    dealId: "deal-1",
    agentUserId: "user-1",
    agentId: "agent-1",
    config: {} as V2AgentConfig,
    context: { contact: { name: "Ana" }, selectedDeal: null } as any,
    llmOutput: { collected: {} } as V2LLMOutput,
    channel: "meta",
    autonomyMode: "AUTONOMOUS" as const,
    ...overrides,
  };
}

describe("executeV2Actions effect tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("add_note cria nota vinculada ao contato", async () => {
    (prisma.note.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "n1" });
    const action: V2Action = { type: "add_note", content: "Cliente pediu desconto" };
    const res = await executeV2Actions([action], ctx());
    expect(res.results[0].ok).toBe(true);
    expect(prisma.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: "Cliente pediu desconto", contactId: "contact-1" }),
      }),
    );
  });

  it("send_message_model envia texto renderizado do template", async () => {
    (prisma.messageTemplate.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "m1",
      name: "Boas-vindas",
      content: "Olá @contact.name, bem-vinda!",
      mediaUrl: null,
      mediaType: null,
    });
    const action: V2Action = { type: "send_message_model", modelId: "m1" };
    const res = await executeV2Actions([action], ctx());
    expect(res.results[0].ok).toBe(true);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Olá Ana, bem-vinda!" }),
    );
  });

  it("send_product envia resumo do produto", async () => {
    (prisma.product.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "p1",
      name: "Notebook Pro",
      price: 3500,
      description: "14 polegadas",
      sku: "NB-01",
      unit: "un",
      customValues: [],
    });
    const action: V2Action = { type: "send_product", productId: "p1" };
    const res = await executeV2Actions([action], ctx());
    expect(res.results[0].ok).toBe(true);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Notebook Pro") }),
    );
  });
});
