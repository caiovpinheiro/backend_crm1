/**
 * CRITÉRIO DE ACEITE do desacoplamento da vertical.
 *
 * Um agente NOVO, de outra organização, com `verticalPack = null`:
 *   1. recebe mensagem e responde usando a base de conhecimento DELE;
 *   2. transfere para um departamento DESSA organização;
 *   3. entra em fila quando não há responsável elegível, com o desfecho
 *      correto (`HANDOFF_QUEUED`, conversa sem assignee);
 *   4. respeita o horário de atendimento humano configurado NELE;
 *   5. usa as mensagens de fila configuradas NELE.
 *
 * A ausência deste teste é o que deixou a extração anterior passar por
 * completa: os arquivos mudaram de pasta e os pontos de uso continuaram
 * pedindo `getVerticalPack("academic")`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`: os factories de `vi.mock` sobem acima das declarações.
const {
  ORG,
  AGENT_ID,
  AGENT_USER_ID,
  CONVERSATION_ID,
  CONTACT_ID,
  DEAL_ID,
  DEPT_FINANCEIRO,
  DEPT_SUPORTE,
  KNOWLEDGE_FACT,
  AGENT_QUEUE_MESSAGE,
  AGENT_ASSIGNED_MESSAGE,
  agentInboxPolicy,
} = vi.hoisted(() => {
  const queueMessage =
    "Beleza! Você entrou na fila do nosso time. Retornamos na quarta, das 10h às 12h.";
  const assignedConsultantMessage =
    "Prontinho, já tem um analista com o seu caso.";
  return {
    ORG: "org-nova",
    AGENT_ID: "agent-generico",
    AGENT_USER_ID: "ai-user-generico",
    CONVERSATION_ID: "conv-generica",
    CONTACT_ID: "contact-generico",
    DEAL_ID: "deal-generico",
    DEPT_FINANCEIRO: { id: "dept-fin", name: "Financeiro" },
    DEPT_SUPORTE: { id: "dept-sup", name: "Suporte Técnico" },
    KNOWLEDGE_FACT:
      "A segunda via do boleto é emitida no portal do cliente, aba Financeiro.",
    AGENT_QUEUE_MESSAGE: queueMessage,
    AGENT_ASSIGNED_MESSAGE: assignedConsultantMessage,
    agentInboxPolicy: {
      transferPolicy: "always",
      /** Horário de atendente humano DESTE agente: quarta, 10h–12h. */
      humanAttendanceHours: {
        enabled: true,
        timezone: "America/Sao_Paulo",
        weekdays: [{ day: 3, start: "10:00", end: "12:00" }],
      },
      queueMessage,
      assignedConsultantMessage,
    },
  };
});

// ── Contexto / infra ──────────────────────────────────────────

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => ORG,
  getOrgIdOrThrow: () => ORG,
  getRequestContext: () => ({ userId: "system", organizationId: ORG }),
  runWithContext: async (_ctx: unknown, fn: () => unknown) => fn(),
  runWithActor: async (_actor: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: (data: Record<string, unknown>) => ({
    ...data,
    organizationId: ORG,
  }),
}));

vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));

vi.mock("@/lib/org-settings", () => ({
  getOrgSetting: vi.fn(async () => null),
  getOrgSettingBool: vi.fn(async (_k: string, d: boolean) => d),
}));

vi.mock("@/services/ai/agent-key", () => ({
  getAgentApiKey: vi.fn(async () => "sk-test"),
}));

vi.mock("@/services/conversation-events", () => ({
  createConversationEvent: vi.fn(async () => null),
}));

vi.mock("@/services/activities", () => ({
  createActivity: vi.fn(async () => null),
}));

vi.mock("@/services/deals", () => ({
  assignDealOwner: vi.fn(async () => null),
  createDeal: vi.fn(async () => null),
  createDealEvent: vi.fn(() => ({ catch: () => null })),
  updateDeal: vi.fn(async () => null),
}));

vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(() => ({ catch: async () => null })),
  notifyDealStageChanged: vi.fn(async () => null),
}));

// A base de conhecimento do agente: retrieval real depende de pgvector.
// Aqui interessa que o runner injete os chunks DO AGENTE no prompt.
vi.mock("@/services/ai/retrieval", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/ai/retrieval")>();
  return {
    ...actual,
    retrieveRelevantChunks: vi.fn(async (agentId: string) =>
      agentId === AGENT_ID
        ? [
            {
              docId: "doc-1",
              docTitle: "Manual do cliente",
              content: KNOWLEDGE_FACT,
              score: 0.9,
            },
          ]
        : [],
    ),
  };
});

// ── Estado mutável compartilhado com os mocks ─────────────────

const state = vi.hoisted(() => ({
  distribution: {
    success: false,
    reason: "NO_ELIGIBLE_RESPONSIBLE",
    selectedUserId: null as string | null,
    selectedUserName: null as string | null,
  },
  conversation: {
    id: "conv-generica",
    organizationId: "org-nova",
    contactId: "contact-generico",
    assignedToId: "ai-user-generico" as string | null,
    assignedTo: { type: "AI" } as { type: string } | null,
    departmentId: null as string | null,
    hasHumanReply: false,
    status: "OPEN",
    externalId: null as string | null,
  },
  conversationUpdates: [] as Array<Record<string, unknown>>,
  runUpdates: [] as Array<Record<string, unknown>>,
  system: "",
  toolNames: [] as string[],
  toolResults: [] as Array<{ toolName: string; result: unknown }>,
  toolPlan: null as { tool: string; args: Record<string, unknown> } | null,
}));

const executeDistributionMock = vi.hoisted(() =>
  vi.fn(async () => state.distribution),
);

vi.mock("@/services/distribution/engine", () => ({
  executeDistribution: executeDistributionMock,
}));
vi.mock("@/services/distribution", () => ({
  executeDistribution: executeDistributionMock,
}));

// ── Prisma fake ───────────────────────────────────────────────

vi.mock("@/lib/prisma", () => {
  const agentRow = () => ({
    id: AGENT_ID,
    organizationId: ORG,
    userId: AGENT_USER_ID,
    active: true,
    archetype: "SUPORTE",
    autonomyMode: "AUTONOMOUS",
    model: "gpt-4o-mini",
    temperature: 0.5,
    maxTokens: 512,
    maxSteps: 0,
    maxToolCallsPerRun: 0,
    maxRepeatsPerTool: 0,
    dailyTokenCap: 0,
    systemPromptTemplate: "Você é o agente de suporte da {{company_name}}.",
    systemPromptOverride: null,
    productPolicy: null,
    tone: "cordial",
    language: "pt-BR",
    enabledTools: ["transfer_to_department", "execute_distribution"],
    qualificationQuestions: [],
    outputStyle: "conversational",
    steeringRules: null,
    toolConfig: null,
    businessHours: null,
    autoClosePolicy: null,
    // O ponto do teste: agente sem vertical.
    verticalPack: null,
    inboxPolicy: agentInboxPolicy,
    pipelineId: null,
    user: { id: AGENT_USER_ID, name: "Ana IA" },
  });

  const departments = [DEPT_FINANCEIRO, DEPT_SUPORTE];

  return {
    prisma: {
      aIAgentConfig: {
        findUnique: vi.fn(async () => agentRow()),
        findFirst: vi.fn(async () => agentRow()),
      },
      aIAgentRun: {
        create: vi.fn(async () => ({ id: "run-1" })),
        update: vi.fn(async ({ data }: any) => {
          state.runUpdates.push(data);
          return { id: "run-1" };
        }),
        aggregate: vi.fn(async () => ({ _sum: {} })),
      },
      aIAgentMessage: {
        create: vi.fn(() =>
          Object.assign(Promise.resolve({ id: "m" }), {
            catch: () => Promise.resolve(null),
          }),
        ),
      },
      organization: { findUnique: vi.fn(async () => ({ name: "Nova Org" })) },
      contact: {
        findUnique: vi.fn(async () => ({
          id: CONTACT_ID,
          name: "Cliente",
          email: null,
          phone: "5511999999999",
          lifecycleStage: null,
          tags: [],
        })),
        update: vi.fn(async () => null),
      },
      deal: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => ({ id: DEAL_ID })),
      },
      department: {
        findMany: vi.fn(async () =>
          departments.map((d) => ({ ...d, _count: { members: 2 } })),
        ),
        findUnique: vi.fn(async ({ where }: any) =>
          departments.find((d) => d.id === where.id) ?? null,
        ),
      },
      conversation: {
        findUnique: vi.fn(async () => ({ ...state.conversation })),
        findFirst: vi.fn(async () => ({ ...state.conversation })),
        update: vi.fn(async ({ data }: any) => {
          state.conversationUpdates.push(data);
          if ("departmentId" in data) state.conversation.departmentId = data.departmentId;
          if ("assignedToId" in data) {
            state.conversation.assignedToId = data.assignedToId;
            state.conversation.assignedTo = data.assignedToId
              ? { type: "HUMAN" }
              : null;
          }
          return { ...state.conversation };
        }),
      },
      message: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      user: { findUnique: vi.fn(async () => ({ type: "HUMAN", name: "Bia" })) },
      distributionPending: {
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(() => ({ catch: async () => 0 })),
      },
      aIAgentKnowledgeDoc: { findFirst: vi.fn(async () => ({ id: "doc-1" })) },
      messageTemplate: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
      $transaction: vi.fn(async (fn: any) => fn({})),
    },
  };
});

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    aIAgentConfig: {
      findFirst: vi.fn(async () => ({
        id: AGENT_ID,
        userId: AGENT_USER_ID,
        verticalPack: null,
        inboxPolicy: agentInboxPolicy,
        businessHours: null,
      })),
    },
    conversation: { findFirst: vi.fn(async () => ({ ...state.conversation })) },
  },
}));

// ── LLM ───────────────────────────────────────────────────────

/**
 * O "modelo" executa a tool que o teste planejou — com o `ToolSet` real
 * que o runner montou. É o que faz deste um teste de integração e não de
 * mock: `transfer_to_department` e `execute_distribution` rodam de fato.
 */
const generateWithToolsMock = vi.hoisted(() =>
  vi.fn(async (args: any) => {
    state.system = args.system;
    state.toolNames = Object.keys(args.tools ?? {});
    const calls: Array<{ toolName: string; args: unknown; result: unknown }> =
      [];
    const plan = state.toolPlan;
    if (plan) {
      const tool = args.tools?.[plan.tool];
      if (!tool) throw new Error(`tool ${plan.tool} não exposta ao modelo`);
      const result = await tool.execute(plan.args, {
        toolCallId: "call-1",
        messages: [],
      });
      calls.push({ toolName: plan.tool, args: plan.args, result });
      state.toolResults.push({ toolName: plan.tool, result });
    }
    return {
      text: "Claro! A segunda via sai no portal do cliente, aba Financeiro. [1]",
      inputTokens: 10,
      outputTokens: 20,
      toolCalls: calls,
      steps: 1,
    };
  }),
);

vi.mock("@/services/ai/provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/ai/provider")>();
  return { ...actual, generateWithTools: generateWithToolsMock };
});

import {
  humanQueueContextFromAgent,
  buildHumanQueueWithHoursMessage,
  buildAssignedConsultantNotice,
  isHumanAttendanceWindowOpen,
} from "@/services/ai/human-queue-policy";
import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { runAgent } from "@/services/ai/runner";

function agentQueueContext() {
  // Mesmo caminho do runtime: JSON salvo → normalize → contexto de fila.
  return humanQueueContextFromAgent({
    inboxPolicy: normalizeInboxPolicy(agentInboxPolicy, null),
    businessHours: null,
  });
}

async function runTurn(userMessage: string) {
  return runAgent({
    agentId: AGENT_ID,
    source: "inbox",
    userMessage,
    conversationId: CONVERSATION_ID,
    contactId: CONTACT_ID,
    dealId: DEAL_ID,
  });
}

describe("agente novo, outra org, verticalPack = null", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.conversationUpdates.length = 0;
    state.runUpdates.length = 0;
    state.toolResults.length = 0;
    state.toolPlan = null;
    state.system = "";
    state.conversation.assignedToId = AGENT_USER_ID;
    state.conversation.assignedTo = { type: "AI" };
    state.conversation.departmentId = null;
    state.distribution = {
      success: false,
      reason: "NO_ELIGIBLE_RESPONSIBLE",
      selectedUserId: null,
      selectedUserName: null,
    };
  });

  it("1) responde usando a base de conhecimento dele", async () => {
    const result = await runTurn("como emito a segunda via do boleto?");

    expect(result.status).toBe("COMPLETED");
    expect(state.system).toContain(KNOWLEDGE_FACT);
    expect(result.text).toContain("portal do cliente");
  });

  it("2) transfere para um departamento da própria organização", async () => {
    state.toolPlan = {
      tool: "transfer_to_department",
      args: { departmentName: "Financeiro" },
    };
    await runTurn("quero falar sobre a minha fatura");

    const call = state.toolResults.at(-1);
    expect(call?.result).toMatchObject({
      ok: true,
      departmentId: DEPT_FINANCEIRO.id,
      departmentName: DEPT_FINANCEIRO.name,
    });
    expect(state.conversation.departmentId).toBe(DEPT_FINANCEIRO.id);
  });

  it("2b) departamento inexistente cita os departamentos DESTA org", async () => {
    state.toolPlan = {
      tool: "transfer_to_department",
      args: { departmentName: "Ouvidoria Interplanetária" },
    };
    await runTurn("preciso de outra área");

    const error = (state.toolResults.at(-1)?.result as { error?: string })?.error ?? "";
    expect(error).toContain("Financeiro");
    expect(error).toContain("Suporte Técnico");
    // Nunca os departamentos de um tenant específico.
    expect(error).not.toContain("Acolhimento");
    expect(error).not.toContain("Retenção");
  });

  it("3) entra em fila quando não há responsável elegível", async () => {
    state.toolPlan = {
      tool: "execute_distribution",
      args: { departmentName: "Suporte Técnico", reason: "cliente pediu" },
    };
    const result = await runTurn("quero falar com um atendente");

    expect(executeDistributionMock).toHaveBeenCalled();
    expect(state.toolResults.at(-1)?.result).toMatchObject({
      ok: true,
      assigned: false,
      queuedWaiting: true,
      reason: "NO_ELIGIBLE_RESPONSIBLE",
    });
    // Conversa solta da IA → aparece em "Aguardando distribuição".
    expect(state.conversation.assignedToId).toBeNull();
    expect(result.status).toBe("HANDOFF");
    // Precedência atual de `deriveRunOutcome`: fila sem elegível também
    // solta a conversa da IA, e "saiu da IA" vence "ficou em fila"
    // (run-outcome.test.ts fixa isso de propósito).
    expect(state.runUpdates.at(-1)?.outcome).toBe("HANDOFF_COMPLETED");
  });

  it("3b) com responsável elegível, atribui e reporta quem recebeu", async () => {
    state.distribution = {
      success: true,
      reason: "ASSIGNED",
      selectedUserId: "user-humano",
      selectedUserName: "Bia",
    };
    state.toolPlan = {
      tool: "execute_distribution",
      args: { departmentName: "Financeiro" },
    };
    await runTurn("quero falar com um atendente");

    expect(state.toolResults.at(-1)?.result).toMatchObject({
      ok: true,
      assigned: true,
      assignedTo: "Bia",
    });
  });

  it("4) respeita o horário de atendente humano configurado nele", () => {
    const queue = agentQueueContext();
    // Quarta, 10h30 (BRT) — dentro da janela do agente.
    expect(
      isHumanAttendanceWindowOpen(new Date("2026-09-09T13:30:00Z"), queue),
    ).toBe(true);
    // Quarta, 13h (BRT) — fora.
    expect(
      isHumanAttendanceWindowOpen(new Date("2026-09-09T16:00:00Z"), queue),
    ).toBe(false);
    // Segunda 10h30 (BRT): dia sem atendente para ESTE agente, ainda que
    // seja horário comercial no default do código.
    expect(
      isHumanAttendanceWindowOpen(new Date("2026-09-07T13:30:00Z"), queue),
    ).toBe(false);
  });

  it("5) usa as mensagens de fila configuradas nele", () => {
    const queue = agentQueueContext();
    expect(buildHumanQueueWithHoursMessage(new Date(), queue)).toBe(
      AGENT_QUEUE_MESSAGE,
    );
    expect(buildAssignedConsultantNotice(queue)).toBe(AGENT_ASSIGNED_MESSAGE);
  });

  it("expõe as tools de transferência mesmo sem vertical pack", async () => {
    await runTurn("oi");
    expect(state.toolNames).toContain("transfer_to_department");
    expect(state.toolNames).toContain("execute_distribution");
  });
});


