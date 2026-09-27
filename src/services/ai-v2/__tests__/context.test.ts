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

  it("campo configurado pelo nome (não pelo id): lê o valor preenchido no negócio e diz como achou", async () => {
    mocks.conversationFindUnique.mockResolvedValue({ contactId: "c1" });
    mocks.contactFindUnique.mockResolvedValue({ id: "c1", name: "Aluno", phone: null, email: null, tags: [], customFields: [] });
    mocks.dealFindMany.mockResolvedValue([{ id: "d1" }]);
    mocks.dealFindUnique.mockResolvedValue({
      id: "d1",
      number: 48030,
      title: "Aluno",
      status: "OPEN",
      value: null,
      stage: { id: "s1", name: "Qualificado" },
      customFields: [
        { customFieldId: "cf-111", value: "aluno@escola.edu", customField: { name: "email_academico", label: "Email acadêmico" } },
        { customFieldId: "cf-222", value: "12345678", customField: { name: "rgm", label: "RGM" } },
      ],
    });
    const { loadV2Context, describeV2ContextForTrace } = await import("../context");
    const config = baseConfig({
      contextFields: {
        contact: [],
        deal: [
          { key: "email_academico", label: "E-mail acadêmico", permissions: ["read", "cite"] },
          { key: "cf-222", label: "RGM", permissions: ["read", "cite"] },
          { key: "campo_apagado", label: "Polo", permissions: ["read"] },
        ],
      },
    });
    const ctx = await loadV2Context({ organizationId: "org-1", conversationId: "conv-1", config });
    expect(ctx.selectedDeal).toMatchObject({ "E-mail acadêmico": "aluno@escola.edu", RGM: "12345678" });
    expect(ctx.selectedDealRaw).toMatchObject({ email_academico: "aluno@escola.edu", "cf-222": "12345678" });
    const trace = describeV2ContextForTrace(config, ctx);
    expect(trace).toContain("Negócio lido: #48030 Aluno (2 campo(s) personalizado(s) preenchido(s) no CRM)");
    expect(trace).toContain("Achados pelo nome do campo (a configuração guarda o nome, não o id): E-mail acadêmico → “Email acadêmico”");
    expect(trace).toContain("Configurados que não existem no CRM (escolha de novo em Dados do cliente): Polo (negócio)");
    expect(trace).not.toContain("RGM →");
  });

  it("informação montada (senha provisória) lê campo que só aparece nela, pelo nome", async () => {
    mocks.conversationFindUnique.mockResolvedValue({ contactId: "c1" });
    mocks.contactFindUnique.mockResolvedValue({ id: "c1", name: "Marcelo Pinheiro", phone: null, email: null, tags: [], customFields: [] });
    mocks.dealFindMany.mockResolvedValue([{ id: "d1" }]);
    mocks.dealFindUnique.mockResolvedValue({
      id: "d1", number: 1, title: "Aluno", status: "OPEN", value: null, stage: { id: "s1", name: "Qualificado" },
      customFields: [
        { customFieldId: "cf-rgm", value: "12345678", customField: { name: "rgm", label: "RGM" } },
        { customFieldId: "cf-cpf", value: "678546334", customField: { name: "cpf", label: "CPF" } },
      ],
    });
    const { loadV2Context } = await import("../context");
    const { derivedFieldValues } = await import("@/lib/ai-v2/field-mask");
    const config = baseConfig({
      contextFields: { contact: [{ key: "name", label: "Nome", permissions: ["read", "cite"] }], deal: [] },
      derivedFields: [{
        id: "senha", label: "Senha Provisória",
        parts: [
          { kind: "field", entity: "contact", key: "name", take: "first", count: 3, letterCase: "capitalize" },
          { kind: "text", text: "@" },
          { kind: "field", entity: "deal", key: "rgm", take: "first", count: 3 },
          { kind: "field", entity: "deal", key: "cpf", take: "first", count: 3 },
        ],
      }],
    } as never);
    const ctx = await loadV2Context({ organizationId: "org-1", conversationId: "conv-1", config });
    expect(ctx.selectedDealRaw).toMatchObject({ rgm: "12345678", cpf: "678546334" });
    expect(Object.values(derivedFieldValues(config, ctx.contactRaw ?? null, ctx.selectedDealRaw ?? null))[0]).toBe("Mar@123678");
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
      title: "Contrato",
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
            { key: "cf-course", label: "Plano", permissions: ["read", "cite"] },
          ],
        },
      }),
    });

    expect(ctx.selectedDeal).toMatchObject({ Título: "Contrato", Plano: "Engenharia" });
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

  it("normaliza objetos e retorna stageName como string", async () => {
    mocks.conversationFindUnique.mockResolvedValue({ contactId: "c1" });
    mocks.contactFindUnique.mockResolvedValue({
      id: "c1",
      name: "Maria",
      phone: null,
      email: null,
      tags: [],
      customFields: [],
    });
    mocks.dealFindMany.mockResolvedValue([{ id: "d1" }]);
    mocks.dealFindUnique.mockResolvedValue({
      id: "d1",
      title: "Venda",
      status: "OPEN",
      value: { toNumber: () => 1234.56 },
      stage: { id: "s1", name: "Negociação" },
      customFields: [{ customFieldId: "cf-json", value: { foo: "bar" } }],
    });

    const { loadV2Context } = await import("../context");
    const ctx = await loadV2Context({
      organizationId: "org-1",
      conversationId: "conv-1",
      config: baseConfig({
        contextFields: {
          contact: [],
          deal: [
            { key: "title", label: "Título", permissions: ["read"] },
            { key: "stageName", label: "Etapa", permissions: ["cite"] },
            { key: "value", label: "Valor", permissions: ["read"] },
            { key: "cf-json", label: "JSON", permissions: ["read"] },
          ],
        },
      }),
    });

    expect(ctx.selectedDeal).toMatchObject({
      Título: "Venda",
      Etapa: "Negociação",
      Valor: "1234.56",
      JSON: '{"foo":"bar"}',
    });
    expect(Object.values(ctx.selectedDeal!).some((v) => String(v) === "[object Object]")).toBe(false);
  });
});
