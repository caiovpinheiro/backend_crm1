import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  searchV2Products,
  searchV2CrmRecords,
  searchV2Knowledge,
  listV2MessageModels,
} from "../tools";
import { retrieveAgentKnowledge } from "@/services/ai/retrieval";
import { retrieveRelevantMessageModels } from "@/services/ai/message-models-retrieval";

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: vi.fn().mockReturnValue("org-1"),
  getOrgIdOrNull: vi.fn().mockReturnValue("org-1"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findMany: vi.fn() },
    contact: { findMany: vi.fn() },
    deal: { findMany: vi.fn() },
    note: { create: vi.fn() },
  },
}));

vi.mock("@/services/ai/retrieval", () => ({
  retrieveAgentKnowledge: vi.fn(),
}));

vi.mock("@/services/ai/message-models-retrieval", () => ({
  retrieveRelevantMessageModels: vi.fn(),
}));

describe("searchV2Products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retorna produtos ativos que casam com o termo", async () => {
    (prisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "p1",
        name: "Plano Empresarial",
        sku: "ADM-001",
        type: "PRODUCT",
        unit: "un",
        price: 199.9,
        description: "Plano mensal",
        customValues: [{ value: "Mensal", customField: { name: "periodicidade", label: "Periodicidade" } }],
      },
      {
        id: "p2",
        name: "Plano Pessoal",
        sku: "DIR-001",
        type: "PRODUCT",
        unit: "un",
        price: 299.9,
        description: "Presencial",
        customValues: [],
      },
    ]);

    const result = await searchV2Products({ query: "administracao" });
    expect(result.total).toBe(1);
    expect(result.products[0].id).toBe("p1");
    expect(result.products[0].priceFormatted).toMatch(/R\$/);
  });

  it("respeita filtro por tipo", async () => {
    (prisma.product.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await searchV2Products({ query: "x", type: "SERVICE", limit: 3 });
    const where = (prisma.product.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.type).toBe("SERVICE");
  });
});

describe("searchV2CrmRecords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retorna contato e negócio atuais que casam com o termo", async () => {
    (prisma.contact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "c1", name: "Ana Silva", phone: "119999", email: "ana@x.com", customFields: [] },
    ]);
    (prisma.deal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "d1",
        title: "Venda de Notebook",
        status: "OPEN",
        value: 5000,
        stage: { id: "s1", name: "Proposta" },
        customFields: [],
      },
    ]);

    const result = await searchV2CrmRecords({ query: "notebook", contactId: "c1", dealId: "d1" });
    expect(result.contacts.length).toBe(1);
    expect(result.deals.length).toBe(1);
    expect(result.deals[0].title).toBe("Venda de Notebook");
  });

  it("usa a relação customFields (a única que existe em Contact/Deal)", async () => {
    (prisma.contact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.deal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await searchV2CrmRecords({ query: "x", contactId: "c1" });

    const contactArgs = (prisma.contact.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const dealArgs = (prisma.deal.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Object.keys(contactArgs.include)).toEqual(["customFields"]);
    expect(Object.keys(dealArgs.include)).toContain("customFields");
    expect(dealArgs.include).not.toHaveProperty("customValues");
  });

  it("nunca busca fora do contato da conversa", async () => {
    (prisma.contact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.deal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const withoutContact = await searchV2CrmRecords({ query: "Maria Souza" });
    expect(withoutContact).toEqual({ query: "Maria Souza", contacts: [], deals: [] });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();

    await searchV2CrmRecords({ query: "Maria Souza", contactId: "c1", scope: "organization" } as any);
    const contactArgs = (prisma.contact.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(contactArgs.where).toMatchObject({ id: "c1" });
    const dealArgs = (prisma.deal.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(dealArgs.where).toMatchObject({ contactId: "c1" });
  });

  it("só devolve campos liberados pela config do agente", async () => {
    (prisma.contact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "c1",
        name: "Ana",
        phone: "119999",
        email: "ana@x.com",
        customFields: [
          { customFieldId: "cf-plano", value: "Básico", customField: { name: "plano", label: "Plano" } },
          { customFieldId: "cf-cpf", value: "123.456.789-00", customField: { name: "cpf", label: "CPF" } },
        ],
      },
    ]);
    (prisma.deal.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const r = await searchV2CrmRecords({ query: "plano", contactId: "c1", readableKeys: ["contact.cf-plano", "contact.email"] });

    const c = r.contacts[0] as Record<string, unknown>;
    expect(c.customFields).toEqual([{ label: "Plano", value: "Básico" }]);
    expect(c.email).toBe("ana@x.com");
    expect(c).not.toHaveProperty("phone");
  });
});

describe("searchV2Knowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passa a lista de documentos permitidos para a recuperação", async () => {
    (retrieveAgentKnowledge as ReturnType<typeof vi.fn>).mockResolvedValue({
      chunks: [{ docId: "doc-a", docTitle: "A", content: "trecho A", distance: 0.2 }],
      expired: [],
    });

    await searchV2Knowledge({
      agentId: "agent-1",
      apiKey: "key",
      query: "pergunta",
      allowedDocIds: ["doc-a"],
    });
    expect(retrieveAgentKnowledge).toHaveBeenCalledWith(
      "agent-1",
      "pergunta",
      "key",
      4,
      expect.any(Date),
      ["doc-a"],
    );
  });

  it("retorna vazio quando a lista permitida é explicitamente vazia", async () => {
    const result = await searchV2Knowledge({
      agentId: "agent-1",
      apiKey: "key",
      query: "pergunta",
      allowedDocIds: [],
    });
    expect(retrieveAgentKnowledge).toHaveBeenCalledWith(
      "agent-1",
      "pergunta",
      "key",
      4,
      expect.any(Date),
      [],
    );
    expect(result.chunks.length).toBe(0);
  });
});

describe("listV2MessageModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filtra modelos pelos ids permitidos do tema", async () => {
    (retrieveRelevantMessageModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "m1", name: "Tutorial A", content: "conteúdo A", score: 5, media: [] },
      { id: "m2", name: "Tutorial B", content: "conteúdo B", score: 4, media: [] },
    ]);

    const result = await listV2MessageModels({ query: "tutorial", allowedIds: ["m2"], limit: 3 });
    expect(result.models.length).toBe(1);
    expect(result.models[0].id).toBe("m2");
  });
});
