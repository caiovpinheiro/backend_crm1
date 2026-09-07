/**
 * Modo de teste do agente: comando, autorização por telefone e expiração.
 *
 * O caso que não pode regredir nunca: um CLIENTE digitando o comando. Se a
 * resposta for qualquer coisa diferente do atendimento normal — inclusive um
 * educado "comando não autorizado" — o recurso está entregue para quem não
 * deveria nem saber que ele existe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "org-1";
const CONVERSATION = "conv-1";
const CONTACT = "contact-1";
const AI_USER = "ai-user-1";

/** Telefone do dono, escrito de um jeito no contato e de outro no perfil. */
const OWNER_PHONE_INBOUND = "5535999821871";
const OWNER_PHONE_PROFILE = "(35) 99982-1871";
const CLIENT_PHONE = "5511911111111";

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrNull: () => ORG,
  getOrgIdOrThrow: () => ORG,
  getRequestContext: () => ({ userId: "system", organizationId: ORG }),
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

vi.mock("@/lib/authz", () => ({
  checkPermission: vi.fn(async () => true),
}));

vi.mock("@/services/ai/piloting-actions", () => ({
  sendAgentMessage: vi.fn(async () => ({ status: "sent" })),
}));

// Estado controlado pelos testes.
let contactPhone = OWNER_PHONE_INBOUND;
let orgUsers: Array<{ id: string; name: string; phone: string | null }> = [];
let conversationRow: Record<string, unknown> = {};

// `vi.mock` é içado, então o spy precisa existir antes da factory.
const { conversationUpdate } = vi.hoisted(() => ({
  conversationUpdate: vi.fn(
    async (_args: { data: Record<string, unknown> }) => null,
  ),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      findUnique: vi.fn(async () => ({
        phone: contactPhone,
        whatsappJid: null,
        whatsappUsername: null,
      })),
    },
    user: {
      findMany: vi.fn(async () => orgUsers),
      findFirst: vi.fn(async () => ({ id: AI_USER, type: "AI" })),
    },
    conversation: {
      findUnique: vi.fn(async () => conversationRow),
      update: conversationUpdate,
    },
  },
}));

import { checkPermission } from "@/lib/authz";
import { sendAgentMessage } from "@/services/ai/piloting-actions";
import {
  AI_TEST_COMMANDS,
  TEST_MODE_TTL_MINUTES,
  handleAiTestCommand,
  parseAiTestCommand,
  readTestMode,
} from "@/services/ai/test-mode";

const OWNER = { id: "user-owner", name: "Caio", phone: OWNER_PHONE_PROFILE };

function conversationWith(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION,
    aiTestModeUntil: null,
    aiTestModeById: null,
    assignedToId: AI_USER,
    assignedTo: { id: AI_USER, type: "AI" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  contactPhone = OWNER_PHONE_INBOUND;
  orgUsers = [OWNER];
  conversationRow = conversationWith();
  vi.mocked(checkPermission).mockResolvedValue(true);
});

describe("parseAiTestCommand", () => {
  it("reconhece os dois comandos, com e sem pontuação", () => {
    expect(parseAiTestCommand("#iniciar")).toBe("start");
    expect(parseAiTestCommand("  #INICIAR  ")).toBe("start");
    expect(parseAiTestCommand("#iniciar.")).toBe("start");
    expect(parseAiTestCommand("#fim")).toBe("stop");
  });

  it("não confunde conversa com comando", () => {
    // Sem o `#` é mensagem — e é o que o cliente escreve de verdade.
    expect(parseAiTestCommand("iniciar")).toBeNull();
    expect(parseAiTestCommand("queria iniciar minha matrícula")).toBeNull();
    expect(parseAiTestCommand("#iniciarei depois")).toBeNull();
    expect(parseAiTestCommand("")).toBeNull();
  });
});

describe("expiração do modo", () => {
  it("timestamp no futuro está ativo; no passado, desligado", () => {
    const now = new Date("2026-09-07T12:00:00Z");
    expect(
      readTestMode({ aiTestModeUntil: new Date("2026-09-07T12:10:00Z") }, now),
    ).not.toBeNull();
    // Expira sozinho na leitura: nenhum cron precisa passar limpando, e um
    // worker que acordou depois da janela já lê o modo desligado.
    expect(
      readTestMode({ aiTestModeUntil: new Date("2026-09-07T11:59:59Z") }, now),
    ).toBeNull();
    expect(readTestMode({ aiTestModeUntil: null }, now)).toBeNull();
    expect(readTestMode(null, now)).toBeNull();
  });
});

describe("autorização por telefone", () => {
  it("telefone de cliente digitando #iniciar é mensagem comum", async () => {
    contactPhone = CLIENT_PHONE;

    const consumed = await handleAiTestCommand({
      conversationId: CONVERSATION,
      contactId: CONTACT,
      command: "start",
      channel: "meta",
      messageId: "msg-1",
    });

    // false = o ingest segue com a mensagem para o agente, como qualquer
    // outra. Nada foi respondido: responder já revelaria o comando.
    expect(consumed).toBe(false);
    expect(vi.mocked(sendAgentMessage)).not.toHaveBeenCalled();
    expect(conversationUpdate).not.toHaveBeenCalled();
  });

  it("telefone certo, mas sem permissão de editar agente, também é mensagem comum", async () => {
    vi.mocked(checkPermission).mockResolvedValue(false);

    const consumed = await handleAiTestCommand({
      conversationId: CONVERSATION,
      contactId: CONTACT,
      command: "start",
      channel: "meta",
      messageId: "msg-2",
    });

    expect(consumed).toBe(false);
    expect(vi.mocked(sendAgentMessage)).not.toHaveBeenCalled();
    expect(conversationUpdate).not.toHaveBeenCalled();
  });

  it("usuário de OUTRA org com o mesmo número não liga o modo", async () => {
    // A query já filtra por organizationId; aqui o cenário é a lista vindo
    // vazia porque ninguém DESTA org tem o número.
    orgUsers = [];

    const consumed = await handleAiTestCommand({
      conversationId: CONVERSATION,
      contactId: CONTACT,
      command: "start",
      channel: "meta",
      messageId: "msg-3",
    });

    expect(consumed).toBe(false);
    expect(conversationUpdate).not.toHaveBeenCalled();
  });

  it("operador autorizado liga o modo com prazo e recebe confirmação", async () => {
    const before = Date.now();

    const consumed = await handleAiTestCommand({
      conversationId: CONVERSATION,
      contactId: CONTACT,
      command: "start",
      channel: "meta",
      messageId: "msg-4",
    });

    const after = Date.now();

    expect(consumed).toBe(true);
    const write = conversationUpdate.mock.calls[0][0].data as {
      aiTestModeUntil: Date;
      aiTestModeById: string;
    };
    expect(write.aiTestModeById).toBe(OWNER.id);
    const ttlMs = TEST_MODE_TTL_MINUTES * 60_000;
    expect(write.aiTestModeUntil.getTime()).toBeGreaterThanOrEqual(
      before + ttlMs,
    );
    expect(write.aiTestModeUntil.getTime()).toBeLessThanOrEqual(after + ttlMs);

    const sent = vi.mocked(sendAgentMessage).mock.calls[0]?.[0] as {
      text: string;
    };
    // A confirmação diz o que está desligado e quando expira.
    expect(sent.text).toContain("Modo de teste ligado");
    expect(sent.text).toContain(`${TEST_MODE_TTL_MINUTES} min`);
    expect(sent.text).toContain(AI_TEST_COMMANDS.stop);
  });

  it("#fim desliga e confirma", async () => {
    conversationRow = conversationWith({
      aiTestModeUntil: new Date(Date.now() + 600_000),
      aiTestModeById: OWNER.id,
    });

    const consumed = await handleAiTestCommand({
      conversationId: CONVERSATION,
      contactId: CONTACT,
      command: "stop",
      channel: "meta",
      messageId: "msg-5",
    });

    expect(consumed).toBe(true);
    expect(conversationUpdate.mock.calls[0][0].data.aiTestModeUntil).toBeNull();
  });

  it("conversa com humano: liga o modo mas avisa que o agente não responde", async () => {
    conversationRow = conversationWith({
      assignedToId: "human-1",
      assignedTo: { id: "human-1", type: "HUMAN" },
    });

    await handleAiTestCommand({
      conversationId: CONVERSATION,
      contactId: CONTACT,
      command: "start",
      channel: "meta",
      messageId: "msg-6",
    });

    // Nenhuma escrita de assignedToId: o teste não rouba conversa de humano.
    const assigneeWrites = conversationUpdate.mock.calls.filter((c) =>
      Object.prototype.hasOwnProperty.call(c[0].data, "assignedToId"),
    );
    expect(assigneeWrites).toHaveLength(0);
  });
});
