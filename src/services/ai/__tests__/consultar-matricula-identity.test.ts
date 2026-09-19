/**
 * O identificador informado no chat, ponta a ponta (schema da tool →
 * argumento do lookup).
 *
 * O sintoma que originou isto: a pessoa escreveu o número do registro dela,
 * o schema não tinha onde guardá-lo, o modelo repetiu a chamada com os
 * mesmos dados e respondeu que havia verificado pelo número informado. A
 * ferramenta nunca consultou por ele.
 */
import { describe, expect, it, vi } from "vitest";

const ORG = "org-1";

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

const lookupStudent = vi.fn(async () => [] as unknown[]);
vi.mock("@/services/academic-records", () => ({
  lookupStudent: (...a: unknown[]) => lookupStudent(...(a as [])),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    customField: { findMany: vi.fn(async () => []) },
    contact: {
      findUnique: vi.fn(async () => ({
        phone: "5511999990000",
        email: null,
      })),
    },
  },
}));

import { normalizeToolConfig } from "@/lib/ai-agents/steering";
import {
  availableToolIdsForPack,
  AVAILABLE_TOOL_IDS,
  buildToolSet,
  type RunContext,
} from "@/services/ai/tools";

const ctx: RunContext = {
  agentUserId: "ai-user-1",
  agentId: "agent-1",
  conversationId: "conv-1",
  contactId: "contact-1",
  dealId: null,
  userMessage: "",
  priorUserMessages: [],
  // A ferramenta é do pack acadêmico, não do núcleo: sem o pack ela nem
  // existe para o agente (ver o teste no fim do arquivo).
  verticalPack: "academic",
  inboxPolicy: null,
};

type ToolLike = {
  description: string;
  inputSchema: { shape?: Record<string, unknown> };
  execute: (a: object, o?: unknown) => Promise<unknown>;
};

function buildTool(identityKeys: string[] = []): ToolLike {
  const config = normalizeToolConfig({
    consultar_matricula: { identityKeys },
  });
  const set = buildToolSet(ctx, ["consultar_matricula"], config) as Record<
    string,
    ToolLike
  >;
  return set.consultar_matricula;
}

function argNames(t: ToolLike): string[] {
  const shape = (t.inputSchema as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

describe("consultar_matricula sem identificador configurado", () => {
  it("o schema é exatamente o de antes", () => {
    expect(argNames(buildTool())).toEqual(["cpf", "nomeCompleto"]);
  });

  it("a description proíbe pedir número que a ferramenta não consulta", () => {
    expect(buildTool().description).toContain("NUNCA peça");
  });

  it("o lookup é chamado sem identificador", async () => {
    lookupStudent.mockClear();
    await buildTool().execute({}, {});
    expect(lookupStudent).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ rgm: null, cpf: null }),
    );
  });
});

describe("consultar_matricula com identificador configurado", () => {
  it("o argumento aparece no schema", () => {
    expect(argNames(buildTool(["rgm"]))).toContain("identificador");
  });

  it("a description nomeia o identificador aceito", () => {
    expect(buildTool(["rgm"]).description).toContain("RGM");
  });

  it("o valor informado chega ao lookup na chave certa", async () => {
    lookupStudent.mockClear();
    await buildTool(["rgm"]).execute(
      { identificador: { campo: "rgm", valor: "12345678" } },
      {},
    );
    expect(lookupStudent).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ rgm: "12345678" }),
    );
  });

  it("identificador de CPF entra pela chave de CPF, não pela de registro", async () => {
    lookupStudent.mockClear();
    await buildTool(["cpf"]).execute(
      { identificador: { campo: "cpf", valor: "39912345678" } },
      {},
    );
    expect(lookupStudent).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ cpf: "39912345678", rgm: null }),
    );
  });

  it("chave configurada que o lookup não consulta não cria argumento", () => {
    expect(argNames(buildTool(["curso"]))).toEqual(["cpf", "nomeCompleto"]);
  });
});

describe("a ferramenta pertence ao pack, não ao núcleo", () => {
  it("agente de tenant sem pack acadêmico não recebe a ferramenta", () => {
    const set = buildToolSet(
      { ...ctx, verticalPack: null },
      ["consultar_matricula"],
      normalizeToolConfig({}),
    );
    expect(Object.keys(set)).toEqual([]);
  });

  it("o núcleo não lista a ferramenta; o pack lista", () => {
    expect(AVAILABLE_TOOL_IDS).not.toContain("consultar_matricula");
    expect(availableToolIdsForPack("academic")).toContain(
      "consultar_matricula",
    );
  });
});
