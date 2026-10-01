import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

const mocks = vi.hoisted(() => ({
  contactFindUnique: vi.fn(),
  dealFindMany: vi.fn(),
  dealFindUnique: vi.fn(),
  conversationFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findUnique: mocks.contactFindUnique },
    deal: { findMany: mocks.dealFindMany, findUnique: mocks.dealFindUnique },
    conversation: { findUnique: mocks.conversationFindUnique },
  },
}));

vi.mock("@/services/ai/crm-field-policy", () => ({
  loadCrmFieldCatalog: vi.fn().mockResolvedValue({ fields: [] }),
  partitionFieldValues: vi.fn().mockImplementation((items: any[]) => {
    const visible = items
      .filter((i) => i.value && String(i.value).trim() && i.field?.readable !== false)
      .map((i) => ({ label: i.field.label, value: String(i.value).trim() }));
    return { visible, citable: visible, hiddenLabels: [] };
  }),
  crmFieldKey: vi.fn().mockImplementation((entity: string, key: string) => `${entity}.${key}`),
}));

function config(overrides: Partial<V2AgentConfig> = {}): V2AgentConfig {
  return {
    name: "Agente",
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Objetivo",
    globalRules: [],
    allowedDomains: [],
    contextFields: {
      contact: [],
      deal: [
        { key: "stage", label: "Etapa", permissions: ["read"] },
        { key: "lostReason", label: "Motivo da perda", permissions: ["read"] },
      ],
    },
    variables: [],
    entry: { confirmContact: false, onDealNotFound: "handoff" },
    handoff: { defaultDestination: { type: "department" }, message: "Vou transferir.", humanRequestKeywords: ["humano"] },
    closure: {},
    limits: {},
    media: {},
    sentiment: {},
    survey: {},
    themes: [],
    rules: [],
    autonomyMode: "auto",
    ...overrides,
  } as unknown as V2AgentConfig;
}

const lostDeal = {
  id: "d-lost",
  title: "Pedido",
  status: "LOST",
  value: 100,
  lostReason: "Prazo de entrega",
  stage: { id: "s-lost", name: "Perdido", pipeline: { name: "Vendas" } },
  customFields: [],
};

describe("negócio perdido no contexto do agente", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationFindUnique.mockResolvedValue({ contactId: "c1" });
    mocks.contactFindUnique.mockResolvedValue({ id: "c1", name: "Ana", phone: null, email: null, tags: [], customFields: [] });
  });

  it("opção desligada: o negócio perdido não é carregado", async () => {
    mocks.dealFindMany.mockResolvedValue([]);

    const { loadV2Context } = await import("../context");
    const ctx = await loadV2Context({ organizationId: "org-1", conversationId: "conv-1", config: config() });

    expect(mocks.dealFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.dealFindMany.mock.calls[0][0].where).toEqual({ contactId: "c1", status: { not: "LOST" } });
    expect(ctx.selectedDeal).toBeNull();
    expect(ctx.dealSelectionReason).toBe("Nenhum negócio aberto encontrado.");
  });

  it("opção ligada e nenhum negócio em andamento: usa o perdido mais recente, com etapa e motivo", async () => {
    mocks.dealFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "d-lost" }]);
    mocks.dealFindUnique.mockResolvedValue(lostDeal);

    const { loadV2Context } = await import("../context");
    const ctx = await loadV2Context({
      organizationId: "org-1",
      conversationId: "conv-1",
      config: config({ includeLostDeals: true }),
    });

    expect(mocks.dealFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.dealFindMany.mock.calls[1][0].where).toEqual({ contactId: "c1", status: "LOST" });
    expect(ctx.dealId).toBe("d-lost");
    expect(ctx.selectedDeal).toMatchObject({ Etapa: "Perdido", "Motivo da perda": "Prazo de entrega" });
    expect(ctx.selectedDealRaw).toMatchObject({ stageId: "s-lost", stageName: "Perdido", pipelineName: "Vendas", status: "LOST" });
    expect(ctx.dealSelectionReason).toContain("perdido");
  });

  it("opção ligada com negócio em andamento: o em andamento vence e o perdido nem é buscado", async () => {
    mocks.dealFindMany.mockResolvedValueOnce([{ id: "d-open" }]);
    mocks.dealFindUnique.mockResolvedValue({
      id: "d-open",
      title: "Pedido novo",
      status: "OPEN",
      value: 200,
      lostReason: null,
      stage: { id: "s-open", name: "Proposta", pipeline: { name: "Vendas" } },
      customFields: [],
    });

    const { loadV2Context } = await import("../context");
    const ctx = await loadV2Context({
      organizationId: "org-1",
      conversationId: "conv-1",
      config: config({ includeLostDeals: true }),
    });

    expect(mocks.dealFindMany).toHaveBeenCalledTimes(1);
    expect(ctx.dealId).toBe("d-open");
    expect(ctx.selectedDeal).toMatchObject({ Etapa: "Proposta" });
    expect(ctx.selectedDeal).not.toHaveProperty("Motivo da perda");
    expect(ctx.dealSelectionReason).toBe("Negócio mais recente selecionado automaticamente.");
  });

  it("campo 'etapa' do catálogo chega como nome da etapa, não como objeto", async () => {
    mocks.dealFindMany.mockResolvedValueOnce([{ id: "d-open" }]);
    mocks.dealFindUnique.mockResolvedValue({
      id: "d-open",
      title: "Pedido",
      status: "OPEN",
      value: 10,
      stage: { id: "s1", name: "Em análise", pipeline: { name: "Vendas" } },
      customFields: [],
    });

    const { loadV2Context } = await import("../context");
    const ctx = await loadV2Context({ organizationId: "org-1", conversationId: "conv-1", config: config() });

    expect(ctx.selectedDeal).toMatchObject({ Etapa: "Em análise" });
    expect(String(ctx.selectedDeal?.Etapa)).not.toContain("{");
  });
});
