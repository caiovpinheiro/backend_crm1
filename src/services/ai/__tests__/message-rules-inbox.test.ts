/**
 * Regras de mensagem: "quando a mensagem for sobre ISTO, o próximo passo é
 * AQUILO", declarado pelo operador.
 *
 * Bug que motivou o mecanismo: "quero trocar de polo" nunca chegava ao
 * modelo. Tirar a keyword de `courseShoppingKeywords` não resolvia, porque o
 * intercepto seguinte (`retention_intent`) caía num regex fixo no código —
 * e "trocar/mudar de polo" interceptava enquanto "transferir de polo" não,
 * por acidente de digitação do regex.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MessageRule } from "@/lib/ai-agents/message-rules";

vi.mock("@/lib/debug-log", () => ({
  debugInfo: () => {},
  debugWarn: () => {},
  debugError: () => {},
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => "org-1",
  getOrgIdOrThrow: () => "org-1",
  getRequestContext: () => ({ userId: "system", organizationId: "org-1" }),
  runWithContext: async (_ctx: unknown, fn: () => Promise<void>) => fn(),
}));

vi.mock("@/lib/cache", () => ({
  cache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
    tryClaim: vi.fn(async () => true),
  },
}));

vi.mock("@/services/ai/phone-allowlist", () => ({
  isContactAllowedForAi: vi.fn(async () => true),
}));

// `ai.newAttendanceEnabled` é default OFF: sem ligar o gate, o handler
// devolve antes de avaliar regra e intercepto, e todo teste daqui vira falso.
vi.mock("@/services/ai/attendance-gate", () => ({
  AI_NEW_ATTENDANCE_SETTING: "ai.newAttendanceEnabled",
  isAiAttendanceEnabled: vi.fn(async () => true),
  inheritContactAssigneeForNewTicket: vi.fn(async () => null),
  releaseAiAssigneeIfDisabled: vi.fn(async () => false),
}));

vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaClientFromConfig: () => ({ configured: false }),
}));

vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));

vi.mock("@/services/conversation-events", () => ({
  createConversationEvent: vi.fn(async () => null),
}));

vi.mock("@/services/ai/send-agent-media", () => ({
  sendAgentFollowUpMedia: vi.fn(async () => 0),
}));

vi.mock("@/services/ai/record-intercept-run", () => ({
  recordInboxInterceptRun: vi.fn(async () => null),
}));

vi.mock("@/services/ai/runner", () => ({ runAgent: vi.fn() }));

vi.mock("@/services/ai/piloting-actions", () => ({
  sendAgentMessage: vi.fn(async () => ({ status: "sent" })),
  hasAgentGreetedInCurrentAssignment: vi.fn(async () => true),
  markAgentGreetedNow: vi.fn(async () => null),
}));

vi.mock("@/services/ai/department-handoff", () => ({
  executeDepartmentHandoff: vi.fn(async () => ({
    departmentId: "dept-1",
    departmentName: "Retenção",
    distribution: null,
  })),
}));

// Qualquer intercepto do pack "pega" a mensagem. Se a regra do operador
// perdesse a precedência, o LLM não rodaria — é esse o bug do polo.
vi.mock("@/verticals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/verticals")>();
  return {
    ...actual,
    runVerticalIntercepts: vi.fn(async () => ({
      handled: true,
      interceptName: "retention_intent",
    })),
  };
});

const AGENT_USER_ID = "ai-user-1";
const CONVERSATION_ID = "conv-1";

let verticalPack: string | null = "academic";
let inboxPolicy: Record<string, unknown> | null = null;

vi.mock("@/lib/prisma", () => {
  const agentConfig = () => ({
    id: "agent-1",
    active: true,
    autonomyMode: "AUTONOMOUS",
    openingMessage: null,
    openingDelayMs: 0,
    keywordHandoffs: [],
    inactivityHandoffMode: "NONE",
    inactivityHandoffUserId: null,
    businessHours: null,
    simulateTyping: false,
    typingPerCharMs: 0,
    markMessagesRead: false,
    model: "gpt-4o-mini",
    inboxPolicy,
    verticalPack,
  });
  return {
    prisma: {
      conversation: {
        findUnique: vi.fn(async (args: any) => {
          if (args?.select?.assignedTo) {
            return {
              id: CONVERSATION_ID,
              assignedToId: AGENT_USER_ID,
              hasHumanReply: false,
              status: "OPEN",
              departmentId: null,
              assignedTo: { type: "AI" },
            };
          }
          return {
            id: CONVERSATION_ID,
            assignedToId: AGENT_USER_ID,
            contactId: "contact-1",
            hasHumanReply: false,
            channelRef: {
              id: "channel-1",
              config: {},
              status: "CONNECTED",
              name: "Canal Teste",
              phoneNumber: "5511900000000",
            },
          };
        }),
        update: vi.fn(async () => null),
      },
      user: {
        findUnique: vi.fn(async () => ({
          id: AGENT_USER_ID,
          type: "AI",
          organizationId: "org-1",
          aiAgentConfig: agentConfig(),
        })),
        findFirst: vi.fn(async () => ({
          id: AGENT_USER_ID,
          aiAgentConfig: agentConfig(),
        })),
      },
      contact: {
        findUnique: vi.fn(async () => ({ phone: "5511911111111" })),
        update: vi.fn(async () => null),
      },
      message: {
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: "msg-1", createdAt: new Date() })),
      },
      deal: { findFirst: vi.fn(async () => null) },
      distributionPending: { findFirst: vi.fn(async () => null) },
      aIAgentRun: { update: vi.fn(() => ({ catch: async () => null })) },
      $transaction: vi.fn(async (fn: any) => fn({})),
    },
  };
});

import { runVerticalIntercepts } from "@/verticals";
import { executeDepartmentHandoff } from "@/services/ai/department-handoff";
import { sendAgentMessage } from "@/services/ai/piloting-actions";
import { runAgent } from "@/services/ai/runner";
import { maybeReplyAsAIAgent } from "@/services/ai/inbox-handler";

const POLO_PHRASES = [
  "quero trocar de polo",
  "quero mudar de polo",
  "quero transferir de polo",
  "me colocaram num polo distante",
];

const POLO_RULE: MessageRule = {
  id: "assunto-polo",
  label: "Assunto de polo",
  enabled: true,
  anyOf: ["polo"],
  allOf: [],
  noneOf: [],
  action: "answer_with_knowledge",
  department: null,
  message: null,
};

function mockRun() {
  vi.mocked(runAgent).mockResolvedValue({
    runId: "run-1",
    status: "COMPLETED",
    text: "O polo fica na Rua X, das 8h às 18h.",
    toolCalls: [],
    autonomyMode: "AUTONOMOUS",
    followUpMedia: [],
  } as never);
}

async function inbound(userMessage: string) {
  await maybeReplyAsAIAgent({
    conversationId: CONVERSATION_ID,
    contactId: "contact-1",
    userMessage,
    channel: "baileys",
  });
}

describe("regras de mensagem no inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verticalPack = "academic";
    inboxPolicy = null;
    mockRun();
  });

  it("sem regra de polo, nenhuma das quatro frases chega ao modelo", async () => {
    // Herdado: transferência pelas regras semeadas do pack (o que era regex)
    // ou pelo intercepto determinístico. Em nenhum caso o LLM roda — é o
    // defeito relatado, e o motivo de a base de conhecimento nunca ser lida.
    for (const phrase of POLO_PHRASES) {
      vi.clearAllMocks();
      mockRun();
      await inbound(phrase);
      expect(vi.mocked(runAgent), `LLM rodou em "${phrase}"`).not.toHaveBeenCalled();
    }
  });

  it("com a regra, as quatro frases têm o MESMO próximo passo: responder com a base", async () => {
    inboxPolicy = { messageRules: [POLO_RULE] };

    for (const phrase of POLO_PHRASES) {
      vi.clearAllMocks();
      mockRun();
      await inbound(phrase);

      // Nenhum intercepto do pack rodou — a regra do operador tem precedência.
      expect(
        vi.mocked(runVerticalIntercepts),
        `interceptou "${phrase}"`,
      ).not.toHaveBeenCalled();
      // llmInvoked = true para todas: sem assimetria por acidente de regex.
      expect(vi.mocked(runAgent), `LLM não rodou em "${phrase}"`).toHaveBeenCalledTimes(1);
      expect(vi.mocked(executeDepartmentHandoff)).not.toHaveBeenCalled();
    }
  });

  it("agente sem vertical pack: a regra responde com a base do mesmo jeito", async () => {
    verticalPack = null;
    inboxPolicy = { messageRules: [POLO_RULE] };

    await inbound("me colocaram num polo distante");

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeDepartmentHandoff)).not.toHaveBeenCalled();
  });

  it("agente sem vertical pack: transferência por regra usa o handoff genérico", async () => {
    verticalPack = null;
    inboxPolicy = {
      messageRules: [
        {
          ...POLO_RULE,
          id: "polo-para-secretaria",
          action: "transfer_department",
          department: "Secretaria",
          message: "Já chamei a Secretaria pra te ajudar com o polo.",
        },
      ],
    };

    await inbound("quero transferir de polo");

    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    const handoff = vi.mocked(executeDepartmentHandoff).mock.calls[0]?.[0];
    expect(handoff?.departmentName).toBe("Secretaria");
    const sent = vi.mocked(sendAgentMessage).mock.calls.at(-1)?.[0] as
      | { text: string }
      | undefined;
    expect(sent?.text).toContain("Secretaria");
  });

  it("texto fixo responde sem chamar o modelo", async () => {
    verticalPack = null;
    inboxPolicy = {
      messageRules: [
        {
          ...POLO_RULE,
          id: "polo-texto-fixo",
          action: "fixed_reply",
          message: "Nosso polo funciona de 8h às 18h.",
        },
      ],
    };

    await inbound("qual o horário do polo?");

    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    const sent = vi.mocked(sendAgentMessage).mock.calls.at(-1)?.[0] as
      | { text: string }
      | undefined;
    expect(sent?.text).toBe("Nosso polo funciona de 8h às 18h.");
  });
});
