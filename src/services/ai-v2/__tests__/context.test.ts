import { describe, expect, it, vi, beforeEach } from "vitest";
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

function baseConfig(overrides: Partial<V2AgentConfig> = {}): V2AgentConfig {
  return {
    name: "Agente",
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Objetivo",
    globalRules: [],
    allowedDomains: [],
    contextFields: { contact: [], deal: [] },
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

describe("loadV2Context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carrega contato com campo personalizado via relação", async () => {
    mocks.conversationFindUnique.mockResolvedValue({ contactId: "c1" });
    mocks.contactFindUnique.mockResolvedValue({
      id: "c1",
      name: "João",
      phone: "+5511999999999",
      email: "joao@teste.com",
      tags: [],
      customFields: [
        { customFieldId: "cf-city", value: "São Paulo" },
        { customFieldId: "cf-age", value: "30" },
      ],
    });
    mocks.dealFindMany.mockResolvedValue([]);

    const { loadV2Context } = await import("../context");
    const ctx = await loadV2Context({
      organizationId: "org-1",
      conversationId: "conv-1",
      config: baseConfig({
        contextFields: {
          contact: [
            { key: "name", label: "Nome", permissions: ["read", "cite"] },
            { key: "cf-city", label: "Cidade", permissions: ["read", "cite"] },
          ],
          deal: [],
        },
      }),
    });

    expect(ctx.contact).toMatchObject({ Nome: "João", Cidade: "São Paulo" });
    expect(ctx.contact).not.toHaveProperty("30");
  });

  it("carrega negócio com campo personalizado via relação", async () => {
    mocks.conversationFindUnique.mockResolvedValue({ contactId: "c1" });
    mocks.contactFindUnique.mockResolvedValue({
      id: "c1",
      name: "João",
      phone: null,
      email: null,
      tags: [],
      customFields: [],
    });
    mocks.dealFindMany.mockResolvedValue([{ id: "d1" }]);
    mocks.dealFindUnique.mockResolvedValue({
      id: "d1",
      title: "Matrícula",
      status: "OPEN",
      value: 1200,
      stage: { id: "s1", name: "Proposta" },
      customFields: [{ customFieldId: "cf-course", value: "Engenharia" }],
    });

    const { loadV2Context } = await import("../context");
    const ctx = await loadV2Context({
      organizationId: "org-1",
      conversationId: "conv-1",
      config: baseConfig({
        contextFields: {
          contact: [],
          deal: [
            { key: "title", label: "Título", permissions: ["read", "cite"] },
            { key: "cf-course", label: "Curso", permissions: ["read", "cite"] },
          ],
        },
      }),
    });

    expect(ctx.selectedDeal).toMatchObject({ Título: "Matrícula", Curso: "Engenharia" });
  });

  it("mantém campos nativos de contato e negócio", async () => {
    mocks.conversationFindUnique.mockResolvedValue({ contactId: "c1" });
    mocks.contactFindUnique.mockResolvedValue({
      id: "c1",
      name: "Maria",
      phone: "+5511888888888",
      email: "maria@teste.com",
      tags: [{ tag: { name: "vip" } }],
      customFields: [],
    });
    mocks.dealFindMany.mockResolvedValue([{ id: "d1" }]);
    mocks.dealFindUnique.mockResolvedValue({
      id: "d1",
      title: "Venda",
      status: "OPEN",
      value: 500,
      stage: { id: "s1", name: "Negociação" },
      customFields: [],
    });

    const { loadV2Context } = await import("../context");
    const ctx = await loadV2Context({
      organizationId: "org-1",
      conversationId: "conv-1",
      config: baseConfig({
        contextFields: {
          contact: [
            { key: "name", label: "Nome", permissions: ["read"] },
            { key: "phone", label: "Telefone", permissions: ["read"] },
            { key: "email", label: "E-mail", permissions: ["cite"] },
          ],
          deal: [
            { key: "title", label: "Título", permissions: ["read"] },
            { key: "stageName", label: "Etapa", permissions: ["cite"] },
            { key: "value", label: "Valor", permissions: ["cite"] },
          ],
        },
      }),
    });

    expect(ctx.contact).toMatchObject({
      Nome: "Maria",
      Telefone: "+5511888888888",
      "E-mail": "maria@teste.com",
    });
    expect(ctx.selectedDeal).toMatchObject({
      Título: "Venda",
      Etapa: "Negociação",
      Valor: "500",
    });
  });
});
