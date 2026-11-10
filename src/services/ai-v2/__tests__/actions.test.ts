import { beforeEach, describe, expect, it, vi } from "vitest";

const customMocks = vi.hoisted(() => ({
  upsertDeal: vi.fn(async () => []),
  upsertContact: vi.fn(async () => []),
  findField: vi.fn(async () => ({ id: "cf-1" })),
}));

import { executeV2Actions } from "../actions";
import { prisma } from "@/lib/prisma";
import { sendAgentMessage } from "@/services/ai/send-agent-message";
import { sendAgentFollowUpMedia } from "@/services/ai/send-agent-media";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import type { V2Action, V2AgentConfig, V2LLMOutput } from "@/lib/ai-v2/types";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    messageTemplate: { findFirst: vi.fn() },
    product: { findFirst: vi.fn() },
    note: { create: vi.fn() },
    conversation: { findUnique: vi.fn() },
    contact: { findUnique: vi.fn(), update: vi.fn() },
    customField: { findFirst: customMocks.findField },
    message: { create: vi.fn() },
    whatsAppTemplateConfig: { findFirst: vi.fn() },
  },
}));

vi.mock("@/services/ai/send-agent-message", () => ({
  sendAgentMessage: vi.fn().mockResolvedValue(undefined),
  assertAiStillAuthorized: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/services/ai/send-agent-media", () => ({
  sendAgentFollowUpMedia: vi.fn().mockResolvedValue(1),
  mediaNotSentTrace: (what: string) => `${what} não enviados`,
}));

vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaClientFromConfig: vi.fn().mockReturnValue({ configured: false }),
}));

vi.mock("@/lib/meta-whatsapp/enrich-template-flow", () => ({
  enrichTemplateComponentsForFlowSend: vi.fn(),
}));

vi.mock("@/services/custom-fields", () => ({
  upsertDealCustomFieldValues: customMocks.upsertDeal,
  upsertContactCustomFieldValues: customMocks.upsertContact,
}));

vi.mock("@/lib/sse-bus", () => ({
  sseBus: { publish: vi.fn() },
}));

vi.mock("../handoff", () => ({
  simpleHandoff: vi.fn().mockResolvedValue(undefined),
  leadsHandoffOption: () => undefined,
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

  it("send_product com imagem: a imagem sai com o texto na legenda e o texto não se repete", async () => {
    (prisma.product.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "p1", name: "Notebook Pro", price: 3500, description: "14 polegadas", imageUrl: "/api/storage/org-1/media/nb.png", imageMime: "image/png", imageName: "nb.png", customValues: [],
    });
    const res = await executeV2Actions([{ type: "send_product", productId: "p1" }], ctx());
    expect(res.results[0]).toMatchObject({ ok: true, imageSent: true });
    const media = (sendAgentFollowUpMedia as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(media.attachments[0]).toMatchObject({ url: "/api/storage/org-1/media/nb.png", mimeType: "image/png" });
    expect(media.attachments[0].caption).toContain("Notebook Pro");
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  it("send_product: imagem que não pôde sair ou modo sugestão → vai o texto; produto fora da lista liberada falha", async () => {
    const product = { id: "p1", name: "Notebook Pro", price: 3500, description: null, imageUrl: "/api/storage/org-1/media/nb.png", imageMime: "image/png", imageName: "nb.png", customValues: [] };
    (prisma.product.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(product);
    (sendAgentFollowUpMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
    const blocked = await executeV2Actions([{ type: "send_product", productId: "p1" }], ctx());
    expect(blocked.results[0]).toMatchObject({ ok: true, imageSent: false });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    (prisma.product.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(product);
    const draft = await executeV2Actions([{ type: "send_product", productId: "p1" }], ctx({ autonomyMode: "DRAFT" }));
    expect(draft.results[0].ok).toBe(true);
    expect(sendAgentFollowUpMedia).not.toHaveBeenCalled();
    expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ autonomyMode: "DRAFT", text: expect.stringContaining("Notebook Pro") }));

    vi.clearAllMocks();
    const notAllowed = await executeV2Actions(
      [{ type: "send_product", productId: "p1" }],
      ctx({ config: { productPolicy: { enabled: true, sendCard: true, allowedProductIds: ["p2"] } } as unknown as V2AgentConfig }),
    );
    expect(notAllowed.results[0].ok).toBe(false);
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });

  it("handoff delega para simpleHandoff com destino específico", async () => {
    const { simpleHandoff } = await import("../handoff");
    const action: V2Action = { type: "handoff", destination: { type: "user", id: "u-99" } };
    const res = await executeV2Actions([action], ctx());
    expect(res.results[0].ok).toBe(true);
    expect(simpleHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ destination: { type: "user", id: "u-99" } }),
    );
  });

  it("update_field bloqueia campo somente leitura", async () => {
    const action: V2Action = { type: "update_field", entity: "contact", field: "name", value: "Novo" };
    const config = {
      contextFields: { contact: [{ key: "name", label: "Nome", permissions: ["read"] }], deal: [] },
    } as unknown as V2AgentConfig;
    const res = await executeV2Actions([action], ctx({ config }));
    expect(res.results[0].ok).toBe(false);
    expect(res.results[0].error).toContain("read-only");
  });

  it("update_field permite campo com permissão de escrita", async () => {
    (prisma.contact.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "contact-1" });
    const action: V2Action = { type: "update_field", entity: "contact", field: "email", value: "novo@exemplo.com" };
    const config = {
      contextFields: { contact: [{ key: "email", label: "Email", permissions: ["read", "write"] }], deal: [] },
    } as unknown as V2AgentConfig;
    const res = await executeV2Actions([action], ctx({ config }));
    expect(res.results[0].ok).toBe(true);
    expect(prisma.contact.update).toHaveBeenCalled();
  });

  it("update_field grava campo personalizado do negócio pelo nome", async () => {
    customMocks.findField.mockResolvedValue({ id: "cf-plano" });
    const action: V2Action = { type: "update_field", entity: "deal", field: "plano", value: "Básico" };
    const config = {
      contextFields: { contact: [], deal: [{ key: "plano", label: "Plano", permissions: ["write"] }] },
    } as unknown as V2AgentConfig;
    const res = await executeV2Actions([action], ctx({ config }));
    expect(res.results[0].ok).toBe(true);
    expect(customMocks.upsertDeal).toHaveBeenCalledWith("deal-1", [{ fieldId: "cf-plano", value: "Básico" }]);
    expect(prisma.customField.findFirst).toHaveBeenCalled();
  });
});
