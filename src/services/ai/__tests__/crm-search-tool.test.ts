/**
 * `search_crm_records` ponta a ponta (tool → payload que o modelo recebe).
 *
 * O que este teste protege: a redação é CÓDIGO, não instrução de prompt.
 * Campo que o operador não liberou não pode aparecer no payload — nem com
 * a busca casando justamente nele.
 *
 * Os dados abaixo espelham o cadastro real de uma aluna em DEV.
 */
import { describe, expect, it, vi } from "vitest";

const ORG = "org-1";
const CPF = "39912345678";
const RGM = "20231234";

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => ORG,
  getOrgIdOrThrow: () => ORG,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));
vi.mock("@/services/ai/department-handoff", () => ({
  executeDepartmentHandoff: vi.fn(),
  resolveDepartmentForAgent: vi.fn(),
  departmentNotFoundMessage: vi.fn(),
  listDepartmentNames: vi.fn(async () => []),
}));
vi.mock("@/services/distribution", () => ({ executeDistribution: vi.fn() }));
vi.mock("@/services/deals", () => ({
  createDeal: vi.fn(),
  createDealEvent: vi.fn(),
  updateDeal: vi.fn(),
}));
vi.mock("@/services/activities", () => ({ createActivity: vi.fn() }));
vi.mock("@/services/tags", () => ({ addTagToContact: vi.fn() }));
vi.mock("@/services/academic-records", () => ({ lookupStudent: vi.fn() }));
vi.mock("@/services/automation-triggers", () => ({
  notifyDealStageChanged: vi.fn(),
}));

const DEAL_CUSTOM_FIELDS = [
  { name: "curso", label: "Curso", type: "TEXT" },
  { name: "polo", label: "Polo", type: "TEXT" },
  { name: "cpf", label: "CPF", type: "TEXT" },
  { name: "rgm", label: "RGM", type: "NUMBER" },
  { name: "situacao_matricula", label: "Situação Matrícula", type: "TEXT" },
  { name: "inadimplente", label: "Inadimplente", type: "SELECT" },
  { name: "doc_pendentes", label: "Doc pendentes", type: "SELECT" },
];

const DEAL_VALUES: Record<string, string> = {
  curso: "CST EM GESTÃO DE RECURSOS HUMANOS",
  polo: "Vila Prudente",
  cpf: CPF,
  rgm: RGM,
  situacao_matricula: "Em Curso",
  inadimplente: "Não",
  doc_pendentes: "Sim",
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customField: {
      findMany: vi.fn(async () =>
        DEAL_CUSTOM_FIELDS.map((f) => ({ ...f, entity: "deal" })),
      ),
    },
    contact: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({
        id: "contact-1",
        number: 42,
        name: "Milena Beatriz",
        email: "milena@exemplo.com",
        phone: "5511999990000",
        source: null,
        lifecycleStage: "CUSTOMER",
        company: null,
        customFields: [],
      })),
    },
    deal: {
      findMany: vi.fn(async () => [
        {
          id: "deal-1",
          number: 37514,
          title: "MILENA BEATRIZ SILVEIRA RIBEIRO",
          status: "OPEN",
          value: 0,
          expectedClose: null,
          lostReason: null,
          stage: { name: "Graduação" },
          customFields: DEAL_CUSTOM_FIELDS.map((f) => ({
            value: DEAL_VALUES[f.name],
            customField: { name: f.name },
          })),
        },
      ]),
    },
    company: { findMany: vi.fn(async () => []) },
    product: { findMany: vi.fn(async () => []) },
  },
}));

import { normalizeToolConfig } from "@/lib/ai-agents/steering";
import { buildToolSet, type RunContext } from "@/services/ai/tools";

const ctx: RunContext = {
  agentUserId: "ai-user-1",
  agentId: "agent-1",
  conversationId: "conv-1",
  contactId: "contact-1",
  dealId: null,
  userMessage: "",
  priorUserMessages: [],
  verticalPack: null,
  inboxPolicy: null,
};

type Payload = {
  ok: boolean;
  error?: string;
  total?: number;
  hint?: string;
  records?: Array<{
    entity: string;
    fields: Array<{ label: string; value: string }>;
    hiddenFields: string[];
    matchedFields: string[];
  }>;
};

async function search(
  args: Record<string, unknown>,
  readableFields: string[] = [],
  extra: Record<string, unknown> = {},
  runCtx: RunContext = ctx,
): Promise<Payload> {
  // Mesma normalização que o read do agente aplica antes de montar o set.
  const config = normalizeToolConfig({
    search_crm_records: { readableFields, ...extra },
  });
  const set = buildToolSet(runCtx, ["search_crm_records"], config) as Record<
    string,
    { execute: (a: object, o?: unknown) => Promise<unknown> }
  >;
  return (await set.search_crm_records.execute(args, {})) as Payload;
}

const deal = (p: Payload) => p.records?.find((r) => r.entity === "deal");

describe("search_crm_records", () => {
  it("sem liberação do operador nenhum valor chega ao modelo", async () => {
    const out = await search({ query: "curso" });

    expect(out.ok).toBe(true);
    expect(deal(out)?.fields).toEqual([]);
    // Saber que o dado existe é o que permite encaminhar em vez de negar.
    expect(deal(out)?.hiddenFields).toContain("Curso");
    expect(out.hint).toContain("encaminhe para a equipe");

    const serialized = JSON.stringify(out);
    for (const leak of [CPF, RGM, "GESTÃO DE RECURSOS HUMANOS", "Vila Prudente"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("libera exatamente os campos da allowlist e retém o resto", async () => {
    const out = await search({ query: "documento pendente" }, [
      "deal.doc_pendentes",
      "deal.stage",
    ]);

    expect(deal(out)?.fields).toEqual([
      { label: "Etapa do funil", value: "Graduação" },
      { label: "Doc pendentes", value: "Sim" },
    ]);
    for (const retido of [
      "Título do negócio",
      "Curso",
      "Polo",
      "CPF",
      "RGM",
      "Situação Matrícula",
      "Inadimplente",
    ]) {
      expect(deal(out)?.hiddenFields).toContain(retido);
    }
    expect(deal(out)?.hiddenFields).not.toContain("Doc pendentes");

    const serialized = JSON.stringify(out);
    for (const leak of [CPF, RGM, "Em Curso", "Vila Prudente"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("a busca casa por um campo retido sem devolver o valor dele", async () => {
    // O aluno digita o próprio CPF: acha o cadastro, não recebe o número.
    const out = await search({ query: CPF }, ["deal.doc_pendentes"]);

    expect(deal(out)?.matchedFields).toEqual(["CPF"]);
    expect(JSON.stringify(out)).not.toContain(CPF);
  });

  it("busca em cadastro de terceiros é recusada por default", async () => {
    const out = await search({ query: "milena", scope: "organization" }, [
      "deal.curso",
    ]);

    expect(out.ok).toBe(false);
    expect(out.error).toContain("não está liberada");
  });

  it("busca ampla só roda quando o operador liga", async () => {
    const out = await search(
      { query: "milena", scope: "organization" },
      ["deal.curso"],
      { allowOrgWideSearch: true },
    );
    expect(out.ok).toBe(true);
  });

  it("sem contato na conversa não há o que ler", async () => {
    const out = await search({ query: "curso" }, ["deal.curso"], {}, {
      ...ctx,
      contactId: null,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("Sem contato");
  });

  it("o hint muda quando existe campo liberado e campo retido", async () => {
    const out = await search({ query: "curso" }, ["deal.curso"]);
    expect(deal(out)?.fields).toEqual([
      { label: "Curso", value: "CST EM GESTÃO DE RECURSOS HUMANOS" },
    ]);
    expect(out.hint).toContain("hiddenFields");
  });
});
