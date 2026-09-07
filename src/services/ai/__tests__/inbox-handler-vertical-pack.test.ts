/**
 * Agente SEM vertical pack não pode entrar nos caminhos acadêmicos.
 *
 * Bug: `packOps = agentPack?.ops ?? {}` e chamadas sem `?.()` — todo agente
 * com `verticalPack = null` quebrava com `TypeError: ... is not a function`
 * logo depois do LLM gerar a resposta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const aiLogs: string[] = [];

vi.mock("@/lib/debug-log", () => ({
  debugInfo: (_tag: string, payload: () => string) => {
    aiLogs.push(typeof payload === "function" ? payload() : String(payload));
  },
  debugWarn: () => {},
  debugError: () => {},
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => "org-1",
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

vi.mock("@/services/ai/runner", () => ({
  runAgent: vi.fn(),
}));

vi.mock("@/services/ai/piloting-actions", () => ({
  sendAgentMessage: vi.fn(async () => ({ status: "sent" })),
  hasAgentGreetedInCurrentAssignment: vi.fn(async () => true),
  markAgentGreetedNow: vi.fn(async () => null),
}));

// Intercepts do pack são testados à parte; aqui interessa o pós-LLM.
vi.mock("@/verticals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/verticals")>();
  return { ...actual, runVerticalIntercepts: vi.fn(async () => null) };
});

const AGENT_USER_ID = "ai-user-1";
const CONVERSATION_ID = "conv-1";

let verticalPack: string | null = null;

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
    inboxPolicy: null,
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
      distributionPending: { findFirst: vi.fn(async () => null) },
      aIAgentRun: { update: vi.fn(() => ({ catch: async () => null })) },
      $transaction: vi.fn(async (fn: any) => fn({})),
    },
  };
});

import { runAgent } from "@/services/ai/runner";
import { sendAgentMessage } from "@/services/ai/piloting-actions";
import { maybeReplyAsAIAgent } from "@/services/ai/inbox-handler";

// Bate em HUMAN_QUEUE_MSG_PATTERNS sem bater em textImpliesAcademicHandoff:
// o pack reescreve para a cópia acadêmica, o agente genérico mantém.
const LLM_REPLY =
  "Já te deixei na fila, assim que estiver livre alguém fala com você.";
const USER_MESSAGE = "como faço para atualizar meu cadastro?";

function mockRun() {
  vi.mocked(runAgent).mockResolvedValue({
    runId: "run-1",
    status: "COMPLETED",
    text: LLM_REPLY,
    toolCalls: [],
    autonomyMode: "AUTONOMOUS",
    followUpMedia: [],
  } as never);
}

async function replyOnce() {
  await maybeReplyAsAIAgent({
    conversationId: CONVERSATION_ID,
    contactId: "contact-1",
    userMessage: USER_MESSAGE,
    channel: "baileys",
  });
  const call = vi.mocked(sendAgentMessage).mock.calls.at(-1)?.[0] as
    | { text: string }
    | undefined;
  return call?.text ?? null;
}

describe("maybeReplyAsAIAgent — agente sem vertical pack", () => {
  beforeEach(() => {
    aiLogs.length = 0;
    vi.clearAllMocks();
    mockRun();
  });

  it("verticalPack = null percorre o pós-LLM sem TypeError", async () => {
    verticalPack = null;
    const sent = await replyOnce();

    expect(aiLogs.join("\n")).not.toContain("run_error");
    expect(sent).toBe(LLM_REPLY);
  });

  it("pack 'academic' mantém a reescrita da cópia acadêmica", async () => {
    verticalPack = "academic";
    const sent = await replyOnce();

    expect(aiLogs.join("\n")).not.toContain("run_error");
    expect(sent).not.toBe(LLM_REPLY);
    expect(sent).toContain("Tô aqui");
  });
});
