/**
 * `search_crm_records` ponta a ponta (tool → payload que o modelo recebe).
 *
 * O que este teste protege: a redação é CÓDIGO, não instrução de prompt.
 * Campo que o operador não liberou não pode aparecer no payload — nem com
 * a busca casando justamente nele.
 *
 * Os dados abaixo espelham o cadastro real de uma aluna em DEV.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

/// Negócios que o mock do Prisma devolve. Mutável: o desempate por
/// campo-chave só existe com mais de um registro no mesmo contato.
const dealRow = (id: string, number: number, rgm: string, stage: string) => ({
  id,
  number,
  title: "MILENA BEATRIZ SILVEIRA RIBEIRO",
  status: "OPEN",
  value: 0,
  expectedClose: null,
  lostReason: null,
  stage: { name: stage },
  customFields: DEAL_CUSTOM_FIELDS.map((f) => ({
    value: f.name === "rgm" ? rgm : DEAL_VALUES[f.name],
    customField: { name: f.name },
  })),
});

const ONE_DEAL = [dealRow("deal-1", 37514, RGM, "Graduação")];
let dealRows: ReturnType<typeof dealRow>[] = ONE_DEAL;

/// Identificação fixada na conversa. É o que um agente anterior gravou e o
/// próximo herda — o mock guarda em memória para o teste ler de volta.
type StoredIdentity = {
  aiIdentifiedEntity: string | null;
  aiIdentifiedRecordId: string | null;
  aiIdentifiedRef: string | null;
  aiIdentifiedBy: string | null;
};
const NO_IDENTITY: StoredIdentity = {
  aiIdentifiedEntity: null,
  aiIdentifiedRecordId: null,
  aiIdentifiedRef: null,
  aiIdentifiedBy: null,
};
let identity: StoredIdentity = { ...NO_IDENTITY };

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
      findMany: vi.fn(async () => dealRows),
    },
    company: { findMany: vi.fn(async () => []) },
    product: { findMany: vi.fn(async () => []) },
    conversation: {
      findUnique: vi.fn(async () => identity),
      update: vi.fn(async ({ data }: { data: Partial<StoredIdentity> }) => {
        identity = { ...identity, ...data };
        return identity;
      }),
    },
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
  keyField?: string;
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

/**
 * Identificação por campo declarado: é o caminho que o aluno usa quando
 * digita o próprio RGM. Sem `identityKeys` a ferramenta nem expõe o
 * argumento, e era por isso que o agente nunca pedia o número.
 */
describe("search_crm_records: identificação por campo do negócio", () => {
  const IDENTITY = { identityKeys: ["deal.rgm"] };

  it("sem identityKeys o argumento não existe", async () => {
    const out = await search({
      query: "matricula",
      identificador: { campo: "deal.rgm", valor: RGM },
    });
    // O arg extra é ignorado pelo schema: cai na busca por termo de antes.
    expect(out.ok).toBe(true);
    expect(out.records?.length).toBeGreaterThan(0);
  });

  it("acha o negócio pelo RGM informado", async () => {
    const out = await search(
      { query: "matricula", identificador: { campo: "deal.rgm", valor: RGM } },
      ["deal.curso"],
      IDENTITY,
    );

    expect(out.ok).toBe(true);
    expect(deal(out)?.fields).toEqual([
      { label: "Curso", value: "CST EM GESTÃO DE RECURSOS HUMANOS" },
    ]);
  });

  it("identificar não libera leitura: o RGM continua retido", async () => {
    const out = await search(
      { query: "matricula", identificador: { campo: "deal.rgm", valor: RGM } },
      ["deal.curso"],
      IDENTITY,
    );

    expect(deal(out)?.hiddenFields).toContain("RGM");
    expect(JSON.stringify(out)).not.toContain(RGM);
  });

  it("campo não declarado como identificador é recusado", async () => {
    const out = await search(
      { query: "x", identificador: { campo: "deal.cpf", valor: CPF } },
      [],
      IDENTITY,
    );
    expect(out.ok).toBe(false);
  });
});

/**
 * Identificação passiva: o contato chega pelo telefone e já tem negócio
 * associado. Com campo-chave declarado, dois registros divergentes no
 * mesmo telefone viram pergunta — nunca escolha silenciosa.
 */
describe("search_crm_records: registros já ligados ao contato", () => {
  const LINKED = { linkedIdentityKeys: ["deal.rgm"] };

  afterEach(() => {
    dealRows = ONE_DEAL;
    identity = { ...NO_IDENTITY };
  });

  it("um registro só: responde normalmente", async () => {
    const out = await search({ query: "curso" }, ["deal.curso"], LINKED);
    expect(out.ok).toBe(true);
    expect(deal(out)?.fields).toHaveLength(1);
  });

  it("dois registros com chaves diferentes: pede o campo-chave", async () => {
    dealRows = [
      dealRow("deal-1", 37514, RGM, "Graduação"),
      dealRow("deal-2", 37515, "20239999", "Pós-graduação"),
    ];

    const out = await search({ query: "curso" }, ["deal.curso"], LINKED);

    expect(out.ok).toBe(true);
    expect(out.records).toEqual([]);
    expect(out.keyField).toBe("RGM");
    expect(out.hint).toContain("RGM");
    // Nenhum dado dos dois registros pode vazar na pergunta.
    expect(JSON.stringify(out)).not.toContain("Pós-graduação");
  });

  it("mesma chave nos dois: é duplicata, não ambiguidade", async () => {
    dealRows = [
      dealRow("deal-1", 37514, RGM, "Graduação"),
      dealRow("deal-2", 37515, RGM, "Graduação"),
    ];

    const out = await search({ query: "curso" }, ["deal.curso"], LINKED);
    expect(out.records?.filter((r) => r.entity === "deal")).toHaveLength(2);
  });

  it("sem campo-chave declarado devolve todos, como antes", async () => {
    dealRows = [
      dealRow("deal-1", 37514, RGM, "Graduação"),
      dealRow("deal-2", 37515, "20239999", "Pós-graduação"),
    ];

    const out = await search({ query: "curso" }, ["deal.curso"]);
    expect(out.records?.filter((r) => r.entity === "deal")).toHaveLength(2);
  });
});

/**
 * Identificar custa uma pergunta ao cliente. Pagar de novo a cada
 * transferência é o defeito que este bloco tranca: o resultado pertence à
 * conversa, então o próximo agente herda em vez de interrogar.
 */
describe("search_crm_records: a identificação atravessa a transferência", () => {
  const LINKED = { linkedIdentityKeys: ["deal.rgm"] };
  const BOTH = { identityKeys: ["deal.rgm"], linkedIdentityKeys: ["deal.rgm"] };

  afterEach(() => {
    dealRows = ONE_DEAL;
    identity = { ...NO_IDENTITY };
  });

  it("o número informado fica gravado na conversa", async () => {
    await search(
      { query: "matricula", identificador: { campo: "deal.rgm", valor: RGM } },
      ["deal.curso"],
      BOTH,
    );

    expect(identity.aiIdentifiedEntity).toBe("deal");
    expect(identity.aiIdentifiedRecordId).toBe("deal-1");
    expect(identity.aiIdentifiedBy).toBe("RGM");
  });

  it("o vínculo do telefone também identifica, sem perguntar nada", async () => {
    await search({ query: "curso" }, ["deal.curso"], LINKED);

    expect(identity.aiIdentifiedRecordId).toBe("deal-1");
    // Ninguém digitou número: a origem precisa ficar distinguível.
    expect(identity.aiIdentifiedBy).toBeNull();
  });

  it("com a conversa já identificada não pergunta de novo", async () => {
    dealRows = [
      dealRow("deal-1", 37514, RGM, "Graduação"),
      dealRow("deal-2", 37515, "20239999", "Pós-graduação"),
    ];
    // Estado deixado pelo agente anterior.
    identity = {
      aiIdentifiedEntity: "deal",
      aiIdentifiedRecordId: "deal-2",
      aiIdentifiedRef: "negócio #37515",
      aiIdentifiedBy: "RGM",
    };

    const out = await search({ query: "curso" }, ["deal.curso"], LINKED);

    // Sem o herdado, este cenário devolvia needsIdentification.
    expect(out.keyField).toBeUndefined();
    const deals = out.records?.filter((r) => r.entity === "deal");
    expect(deals).toHaveLength(1);
    expect(deals?.[0].fields).toEqual([
      { label: "Curso", value: "CST EM GESTÃO DE RECURSOS HUMANOS" },
    ]);
  });

  it("um palpite do telefone não derruba o que a pessoa confirmou", async () => {
    identity = {
      aiIdentifiedEntity: "deal",
      aiIdentifiedRecordId: "deal-9",
      aiIdentifiedRef: "negócio #9",
      aiIdentifiedBy: "RGM",
    };

    await search({ query: "curso" }, ["deal.curso"], LINKED);

    expect(identity.aiIdentifiedRecordId).toBe("deal-9");
  });

  it("mas um número novo informado sobrescreve", async () => {
    identity = {
      aiIdentifiedEntity: "deal",
      aiIdentifiedRecordId: "deal-9",
      aiIdentifiedRef: "negócio #9",
      aiIdentifiedBy: null,
    };

    await search(
      { query: "matricula", identificador: { campo: "deal.rgm", valor: RGM } },
      ["deal.curso"],
      BOTH,
    );

    expect(identity.aiIdentifiedRecordId).toBe("deal-1");
  });
});

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
