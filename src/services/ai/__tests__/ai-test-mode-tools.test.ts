/**
 * Bloqueio das ferramentas de efeito em modo de teste.
 *
 * O que este teste protege: o bloqueio é CÓDIGO, não instrução de prompt. A
 * função real da tool não pode ser chamada — não basta o modelo ser orientado
 * a não transferir.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "org-1";
const CONVERSATION = "conv-1";

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => ORG,
  getOrgIdOrThrow: () => ORG,
}));

vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));

vi.mock("@/services/ai/department-handoff", () => ({
  executeDepartmentHandoff: vi.fn(async () => ({
    departmentId: "dept-1",
    departmentName: "Atendimento",
    distribution: { success: true, selectedUserName: "Fulano" },
  })),
  resolveDepartmentForAgent: vi.fn(async () => ({
    id: "dept-1",
    name: "Atendimento",
  })),
  departmentNotFoundMessage: vi.fn(async () => "não encontrado"),
  listDepartmentNames: vi.fn(async () => ["Atendimento"]),
}));

vi.mock("@/services/distribution", () => ({
  executeDistribution: vi.fn(async () => ({ success: true })),
}));

vi.mock("@/services/deals", () => ({
  createDeal: vi.fn(async () => ({ id: "deal-1", title: "x" })),
  createDealEvent: vi.fn(async () => null),
  updateDeal: vi.fn(async () => null),
}));

vi.mock("@/services/activities", () => ({ createActivity: vi.fn() }));
vi.mock("@/services/tags", () => ({ addTagToContact: vi.fn() }));
vi.mock("@/services/academic-records", () => ({ lookupStudent: vi.fn() }));
vi.mock("@/services/automation-triggers", () => ({
  notifyDealStageChanged: vi.fn(),
}));

const { conversationUpdate } = vi.hoisted(() => ({
  conversationUpdate: vi.fn(async () => null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async () => ({ assignedTo: { type: "AI" } })),
      update: conversationUpdate,
    },
    contact: { findUnique: vi.fn(async () => ({ id: "contact-1" })) },
    deal: { findFirst: vi.fn(async () => null) },
  },
}));

import { executeDepartmentHandoff } from "@/services/ai/department-handoff";
import { executeDistribution } from "@/services/distribution";
import { buildToolSet, type RunContext } from "@/services/ai/tools";

function ctx(testMode: boolean): RunContext {
  return {
    agentUserId: "ai-user-1",
    agentId: "agent-1",
    conversationId: CONVERSATION,
    contactId: "contact-1",
    dealId: null,
    userMessage: "quero falar com um atendente",
    priorUserMessages: [],
    verticalPack: null,
    inboxPolicy: null,
    testMode,
  };
}

async function callTool(testMode: boolean, id: string, args: object) {
  const set = buildToolSet(ctx(testMode), [id]) as Record<
    string,
    { execute: (a: object, o?: unknown) => Promise<unknown> }
  >;
  return set[id].execute(args, {});
}

beforeEach(() => vi.clearAllMocks());

describe("modo de teste bloqueia ferramenta de efeito", () => {
  it("execute_distribution não chega ao handoff nem à distribuição", async () => {
    const result = (await callTool(true, "execute_distribution", {
      departmentName: "Atendimento",
      reason: "cliente pediu",
    })) as Record<string, unknown>;

    expect(vi.mocked(executeDepartmentHandoff)).not.toHaveBeenCalled();
    expect(vi.mocked(executeDistribution)).not.toHaveBeenCalled();
    expect(conversationUpdate).not.toHaveBeenCalled();

    // O modelo recebe de volta um resultado que diz claramente o que houve.
    expect(result.simulated).toBe(true);
    expect(result.executed).toBe(false);
    expect(String(result.message)).toContain("MODO DE TESTE");
    expect(result.wouldHave).toMatchObject({ departmentName: "Atendimento" });
  });

  it("mesmo bloqueio para transfer_to_human, transfer_to_department e close_conversation", async () => {
    for (const id of [
      "transfer_to_human",
      "transfer_to_department",
      "close_conversation",
    ]) {
      vi.clearAllMocks();
      const result = (await callTool(true, id, {
        departmentName: "Atendimento",
        reason: "teste",
      })) as Record<string, unknown>;

      expect(result.simulated, `${id} executou`).toBe(true);
      expect(vi.mocked(executeDepartmentHandoff)).not.toHaveBeenCalled();
      expect(conversationUpdate).not.toHaveBeenCalled();
    }
  });

  it("sem modo de teste a mesma chamada transfere de verdade", async () => {
    // Contraprova: se este caso também não chamasse o handoff, o teste acima
    // estaria passando por outro motivo.
    const result = (await callTool(false, "execute_distribution", {
      departmentName: "Atendimento",
    })) as Record<string, unknown>;

    expect(vi.mocked(executeDepartmentHandoff)).toHaveBeenCalledTimes(1);
    expect(result.simulated).toBeUndefined();
  });
});
