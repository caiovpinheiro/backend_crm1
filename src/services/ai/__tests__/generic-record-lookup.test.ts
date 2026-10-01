/**
 * A consulta é infraestrutura, não regra de negócio.
 *
 * O que este teste prende: "quero saber do meu pedido 12345" funciona numa
 * loja, e "minha matrícula é 987654" funcionaria numa faculdade, pelo MESMO
 * caminho e sem uma linha de código nova — a diferença é só qual campo o
 * operador marcou como chave e qual rótulo ele deu a ele.
 *
 * A segunda metade prova o outro eixo: uma tabela que não é do CRM (um pack
 * de vertical registra a fonte) vira entidade consultável pela mesma
 * ferramenta, com a mesma allowlist e o mesmo casamento exato.
 */
import { describe, expect, it, vi } from "vitest";

const ORG = "org-loja";
const PEDIDO = "12345";

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
vi.mock("@/services/automation-triggers", () => ({
  notifyDealStageChanged: vi.fn(),
}));

/// Campos personalizados de uma LOJA. Nenhum conceito acadêmico envolvido.
const DEAL_FIELDS = [
  { name: "numero_pedido", label: "Número do pedido", type: "TEXT" },
  { name: "transportadora", label: "Transportadora", type: "TEXT" },
  { name: "codigo_rastreio", label: "Código de rastreio", type: "TEXT" },
];

const DEAL_VALUES: Record<string, string> = {
  numero_pedido: PEDIDO,
  transportadora: "Expressa Log",
  codigo_rastreio: "BR9988776655",
};

const dealRow = {
  id: "deal-1",
  number: 88,
  title: "Pedido de Ana",
  status: "OPEN",
  value: 0,
  expectedClose: null,
  lostReason: null,
  stage: { name: "Em separação" },
  customFields: DEAL_FIELDS.map((f) => ({
    value: DEAL_VALUES[f.name],
    customField: { name: f.name },
  })),
};

/// Chamadas ao `findMany` de deal, para provar que o filtro é igualdade.
const dealWheres: unknown[] = [];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customField: {
      findMany: vi.fn(async () =>
        DEAL_FIELDS.map((f) => ({ ...f, entity: "deal" })),
      ),
    },
    contact: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({
        id: "contact-1",
        number: 7,
        name: "Ana",
        email: "ana@exemplo.com",
        phone: "5511988887777",
        source: null,
        lifecycleStage: "CUSTOMER",
        company: null,
        customFields: [],
      })),
    },
    deal: {
      findMany: vi.fn(async ({ where }: { where: unknown }) => {
        dealWheres.push(where);
        return [dealRow];
      }),
    },
    company: { findMany: vi.fn(async () => []) },
    product: { findMany: vi.fn(async () => []) },
    conversation: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
  },
}));

import { normalizeToolConfig } from "@/lib/ai-agents/steering";
import type { RecordSource } from "@/services/ai/record-sources";
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
  identifiedBy?: string;
  records?: Array<{
    entity: string;
    fields: Array<{ label: string; value: string }>;
    hiddenFields: string[];
  }>;
};

async function search(
  args: Record<string, unknown>,
  policy: Record<string, unknown>,
  runCtx: RunContext = ctx,
): Promise<Payload> {
  const config = normalizeToolConfig({ search_crm_records: policy });
  const set = buildToolSet(runCtx, ["search_crm_records"], config) as Record<
    string,
    { execute: (a: object, o?: unknown) => Promise<unknown> }
  >;
  return (await set.search_crm_records.execute(args, {})) as Payload;
}

describe("campo-chave é configuração, não código", () => {
  const POLICY = {
    identityKeys: ["deal.numero_pedido"],
    readableFields: ["deal.transportadora", "deal.codigo_rastreio"],
  };

  it("acha o registro pelo número que a pessoa informou", async () => {
    const out = await search(
      {
        query: "pedido",
        identificador: { campo: "deal.numero_pedido", valor: PEDIDO },
      },
      POLICY,
    );

    expect(out.ok).toBe(true);
    expect(out.identifiedBy).toBe("Número do pedido");
    expect(out.records?.[0].fields).toEqual([
      { label: "Transportadora", value: "Expressa Log" },
      { label: "Código de rastreio", value: "BR9988776655" },
    ]);
  });

  it("o rótulo do tenant chega ao modelo junto da chave", async () => {
    const set = buildToolSet(
      { ...ctx, crmFieldLabels: { "deal.numero_pedido": "Número do pedido" } },
      ["search_crm_records"],
      normalizeToolConfig({ search_crm_records: POLICY }),
    ) as Record<string, { description: string }>;

    const description = set.search_crm_records.description;
    expect(description).toContain("deal.numero_pedido");
    expect(description).toContain("Número do pedido");
  });

  it("o filtro é igualdade, nunca `contains`", async () => {
    dealWheres.length = 0;
    await search(
      {
        query: "pedido",
        identificador: { campo: "deal.numero_pedido", valor: PEDIDO },
      },
      POLICY,
    );
    const serialized = JSON.stringify(dealWheres);
    expect(serialized).toContain('"in"');
    expect(serialized).not.toContain('"contains"');
  });

  it("número parcial não abre o pedido de outra pessoa", async () => {
    const out = await search(
      {
        query: "pedido",
        identificador: { campo: "deal.numero_pedido", valor: "1234" },
      },
      POLICY,
    );
    expect(out.ok).toBe(true);
    expect(out.records).toEqual([]);
    expect(out.hint).toContain("não afirme");
  });

  it("identificar não libera leitura do próprio campo-chave", async () => {
    const out = await search(
      {
        query: "pedido",
        identificador: { campo: "deal.numero_pedido", valor: PEDIDO },
      },
      { ...POLICY, readableFields: ["deal.transportadora"] },
    );
    expect(out.records?.[0].hiddenFields).toContain("Número do pedido");
    expect(JSON.stringify(out)).not.toContain(PEDIDO);
  });
});

/**
 * Tabela que não é do CRM entrando pela porta de fontes. É o substituto da
 * tool de negócio: o dado continua alcançável, mas por configuração.
 */
describe("fonte registrada por um pack de vertical", () => {
  const rows = [
    {
      id: "rec-1",
      contrato: "CT-7781",
      documento: "39912345678",
      plano: "Fibra 600",
      vencimento: "dia 10",
    },
  ];

  const fakeSource: RecordSource = {
    entity: "assinatura",
    label: "Assinaturas (sistema legado)",
    supportsCustomValues: false,
    identifiesPerson: true,
    multiplePerContact: true,
    sharedCatalog: false,
    fields: [
      { name: "contrato", label: "Número do contrato" },
      { name: "plano", label: "Plano contratado" },
      { name: "vencimento", label: "Vencimento" },
      { name: "documento", label: "Documento", readable: false },
    ],
    forContact: async () => [],
    findByFieldValue: async ({ field, candidates }) =>
      rows
        .filter((r) =>
          candidates.includes(
            String((r as Record<string, unknown>)[field.name] ?? ""),
          ),
        )
        .map((r) => ({ id: r.id, ref: "assinatura", builtin: r, custom: [] })),
    searchByTerm: async () => [],
  };

  const packCtx: RunContext = { ...ctx, verticalPack: "legado" };

  function withPack() {
    vi.doMock("@/verticals", () => ({
      getVerticalPack: (id: string | null) =>
        id === "legado" ? { recordSources: [fakeSource] } : null,
    }));
  }

  it("a entidade do pack é consultável pela ferramenta do núcleo", async () => {
    withPack();
    vi.resetModules();
    const { buildToolSet: build } = await import("@/services/ai/tools");
    const { normalizeToolConfig: norm } = await import(
      "@/lib/ai-agents/steering"
    );
    const set = build(
      packCtx,
      ["search_crm_records"],
      norm({
        search_crm_records: {
          identityKeys: ["assinatura.contrato"],
          readableFields: ["assinatura.plano", "assinatura.vencimento"],
        },
      }),
    ) as Record<
      string,
      {
        description: string;
        execute: (a: object, o?: unknown) => Promise<unknown>;
      }
    >;

    // A entidade do pack aparece no menu que o modelo lê.
    expect(set.search_crm_records.description).toContain(
      "assinatura.contrato",
    );

    const out = (await set.search_crm_records.execute(
      {
        query: "meu plano",
        identificador: { campo: "assinatura.contrato", valor: "CT-7781" },
      },
      {},
    )) as Payload;

    expect(out.ok).toBe(true);
    expect(out.identifiedBy).toBe("Número do contrato");
    expect(out.records?.[0].fields).toEqual([
      { label: "Plano contratado", value: "Fibra 600" },
      { label: "Vencimento", value: "dia 10" },
    ]);
    // `readable: false` é veto da fonte: fica em hiddenFields mesmo que o
    // operador tentasse liberar.
    expect(out.records?.[0].hiddenFields).toContain("Documento");
    expect(JSON.stringify(out)).not.toContain("39912345678");
    vi.doUnmock("@/verticals");
  });
});
