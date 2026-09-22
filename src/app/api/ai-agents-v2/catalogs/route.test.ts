import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  departmentFindMany: vi.fn().mockResolvedValue([]),
  distributionRuleFindMany: vi.fn().mockResolvedValue([]),
  userFindMany: vi.fn().mockResolvedValue([]),
  aIAgentConfigFindMany: vi.fn().mockResolvedValue([]),
  messageTemplateFindMany: vi.fn().mockResolvedValue([]),
  aIAgentKnowledgeDocFindMany: vi.fn().mockResolvedValue([]),
  channelFindMany: vi.fn().mockResolvedValue([]),
  pipelineFindMany: vi.fn().mockResolvedValue([]),
  customFieldFindMany: vi.fn().mockResolvedValue([]),
  productFindMany: vi.fn().mockResolvedValue([]),
  whatsAppTemplateConfigFindMany: vi.fn().mockResolvedValue([]),
  contactFindMany: vi.fn().mockResolvedValue([{ id: "c1", name: "João", phone: "+5511999999999", email: null }]),
}));

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: mocks.requireAuth,
  requirePermission: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    department: { findMany: mocks.departmentFindMany },
    distributionRule: { findMany: mocks.distributionRuleFindMany },
    user: { findMany: mocks.userFindMany },
    aIAgentConfig: { findMany: mocks.aIAgentConfigFindMany },
    messageTemplate: { findMany: mocks.messageTemplateFindMany },
    aIAgentKnowledgeDoc: { findMany: mocks.aIAgentKnowledgeDocFindMany },
    channel: { findMany: mocks.channelFindMany },
    pipeline: { findMany: mocks.pipelineFindMany },
    customField: { findMany: mocks.customFieldFindMany },
    product: { findMany: mocks.productFindMany },
    whatsAppTemplateConfig: { findMany: mocks.whatsAppTemplateConfigFindMany },
    contact: { findMany: mocks.contactFindMany },
  },
}));

describe("GET /api/ai-agents-v2/catalogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      ok: true,
      session: { user: { id: "u1", organizationId: "org-1", isSuperAdmin: false } },
    });
  });

  it("retorna 200 e carrega contatos sem filtro inexistente isErased", async () => {
    const { GET } = await import("./route");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.contacts).toEqual([
      { id: "c1", name: "João", phone: "+5511999999999", email: null },
    ]);

    expect(mocks.contactFindMany).toHaveBeenCalledTimes(1);
    const contactWhere = (mocks.contactFindMany.mock.calls[0][0] as Record<string, unknown>).where as Record<string, unknown>;
    expect(contactWhere.organizationId).toBe("org-1");
    expect(contactWhere).not.toHaveProperty("isErased");
  });

  it("classifica campos personalizados com entity em minúsculas", async () => {
    mocks.customFieldFindMany.mockResolvedValue([
      { id: "cf-contact", name: "Cidade", entity: "contact" },
      { id: "cf-deal", name: "Curso", entity: "deal" },
      { id: "cf-upper", name: "Segmento", entity: "DEAL" },
    ]);
    const { GET } = await import("./route");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.contactCustomFields).toEqual([{ id: "cf-contact", name: "Cidade", entity: "contact" }]);
    expect(body.dealCustomFields).toEqual([
      { id: "cf-deal", name: "Curso", entity: "deal" },
      { id: "cf-upper", name: "Segmento", entity: "DEAL" },
    ]);
  });
});
