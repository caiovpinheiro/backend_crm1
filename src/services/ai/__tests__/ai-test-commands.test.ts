/**
 * Comandos de correção do modo de teste: `#base`, `#refazer`, `#porque` e o
 * `#desfazer` cobrindo os dois tipos de correção.
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. Comando de correção sem o modo ligado não corrige nada. O modo é o que
 *    garante que o desvio pôde ser provocado sem efeito real.
 * 2. `#base` malformado não cria documento com título de parágrafo.
 * 3. `#desfazer` sabe qual foi a última correção e reverte a certa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "org-1";
const CONVERSATION = "conv-1";
const CONTACT = "contact-1";
const AI_USER = "ai-user-1";
const AGENT_CONFIG = "agent-config-1";
const OWNER_PHONE = "5535999821871";

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

vi.mock("@/lib/authz", () => ({ checkPermission: vi.fn(async () => true) }));

vi.mock("@/services/ai/piloting-actions", () => ({
  sendAgentMessage: vi.fn(async () => ({ status: "sent" })),
}));

const {
  appendSteeringRule,
  createKnowledgeCorrection,
  undoLastCorrection,
  findLastCustomerQuestion,
  replayLastQuestion,
  buildWhyReport,
} = vi.hoisted(() => ({
  appendSteeringRule: vi.fn(async () => "regra"),
  createKnowledgeCorrection: vi.fn(async () => ({
    docId: "doc-1",
    title: "Prazo de cancelamento",
  })),
  undoLastCorrection: vi.fn(
    async (): Promise<
      { field: "steeringRules"; text: string } | { field: "knowledgeDoc"; title: string } | null
    > => null,
  ),
  findLastCustomerQuestion: vi.fn(async (): Promise<string | null> => null),
  replayLastQuestion: vi.fn(async () => {}),
  buildWhyReport: vi.fn(async () => ({
    question: "quero cancelar",
    rule: null,
    llmInvoked: true,
    outcome: "ANSWERED",
    confidence: 0.9,
    documents: [] as string[],
    expired: [] as string[],
  })),
}));

vi.mock("@/services/ai/test-mode-corrections", () => ({
  resolveCorrectionTarget: vi.fn(async () => ({
    agentConfigId: AGENT_CONFIG,
    organizationId: ORG,
  })),
  appendSteeringRule,
  createKnowledgeCorrection,
  undoLastCorrection,
}));

vi.mock("@/services/ai/test-mode-replay", () => ({
  findLastCustomerQuestion,
  replayLastQuestion,
}));

vi.mock("@/services/ai/test-mode-why", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/ai/test-mode-why")
  >("@/services/ai/test-mode-why");
  return { buildWhyReport, formatWhyReport: actual.formatWhyReport };
});

let conversationRow: Record<string, unknown> = {};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      findUnique: vi.fn(async () => ({
        phone: OWNER_PHONE,
        whatsappJid: null,
        whatsappUsername: null,
      })),
    },
    user: {
      findMany: vi.fn(async () => [
        { id: "user-owner", name: "Caio", phone: OWNER_PHONE },
      ]),
      findFirst: vi.fn(async () => ({ id: AI_USER, type: "AI" })),
    },
    conversation: {
      findUnique: vi.fn(async () => conversationRow),
      update: vi.fn(async () => null),
    },
  },
}));

import { sendAgentMessage } from "@/services/ai/piloting-actions";
import {
  handleAiTestCommand,
  parseAiTestCommand,
  parseKnowledgeArgument,
} from "@/services/ai/test-mode";
import { formatWhyReport } from "@/services/ai/test-mode-why";

function conversationWith(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION,
    // Modo ligado por padrão: o caso desligado é testado explicitamente.
    aiTestModeUntil: new Date(Date.now() + 600_000),
    aiTestModeById: "user-owner",
    assignedToId: AI_USER,
    assignedTo: { id: AI_USER, type: "AI" },
    ...overrides,
  };
}

/** Texto que o operador recebeu de volta. */
function lastReply(): string {
  const calls = vi.mocked(sendAgentMessage).mock.calls;
  return (calls.at(-1)?.[0] as { text: string } | undefined)?.text ?? "";
}

async function run(command: string, argument = "") {
  return handleAiTestCommand({
    conversationId: CONVERSATION,
    contactId: CONTACT,
    command: parseAiTestCommand(command)!.command,
    argument,
    channel: "meta",
    messageId: `msg-${Math.random()}`,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  conversationRow = conversationWith();
});

describe("reconhecimento dos comandos novos", () => {
  it("aceita #base, #refazer e #porque", () => {
    expect(parseAiTestCommand("#base")?.command).toBe("knowledge");
    expect(parseAiTestCommand("#refazer")?.command).toBe("replay");
    expect(parseAiTestCommand("#porque")?.command).toBe("why");
    // Acento no comando não muda nada: a comparação é sem acento.
    expect(parseAiTestCommand("#porquê")?.command).toBe("why");
  });

  it("continua não confundindo conversa com comando", () => {
    expect(parseAiTestCommand("base de conhecimento")).toBeNull();
    expect(parseAiTestCommand("#basear")).toBeNull();
  });
});

describe("formato do #base", () => {
  it("separa por barra vertical", () => {
    expect(
      parseKnowledgeArgument("Prazo de cancelamento | Até o dia 5 não cobra."),
    ).toEqual({
      title: "Prazo de cancelamento",
      content: "Até o dia 5 não cobra.",
    });
  });

  it("separa por quebra de linha", () => {
    expect(parseKnowledgeArgument("Prazo\nAté o dia 5 não cobra.")).toEqual({
      title: "Prazo",
      content: "Até o dia 5 não cobra.",
    });
  });

  it("sem separador não vira documento — título de parágrafo é pior que erro", () => {
    expect(parseKnowledgeArgument("até o dia 5 não cobra")).toBeNull();
    expect(parseKnowledgeArgument("")).toBeNull();
    expect(parseKnowledgeArgument("| só conteúdo")).toBeNull();
    expect(parseKnowledgeArgument("só título |")).toBeNull();
  });
});

describe("#base", () => {
  it("cria o documento e confirma com o título", async () => {
    await run("#base", "Prazo de cancelamento | Até o dia 5 não cobra.");

    expect(createKnowledgeCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Prazo de cancelamento",
        content: "Até o dia 5 não cobra.",
        conversationId: CONVERSATION,
      }),
    );
    expect(lastReply()).toContain("Prazo de cancelamento");
  });

  it("malformado devolve o exemplo e não cria nada", async () => {
    await run("#base", "até o dia 5 não cobra");

    expect(createKnowledgeCorrection).not.toHaveBeenCalled();
    expect(lastReply()).toContain("|");
  });

  it("erro do serviço vira mensagem, não silêncio", async () => {
    createKnowledgeCorrection.mockRejectedValueOnce(
      new Error("Conteúdo muito grande (limite 500.000 caracteres)."),
    );

    await run("#base", "Título | conteúdo");

    expect(lastReply()).toContain("Conteúdo muito grande");
  });
});

describe("modo desligado", () => {
  it.each(["#base", "#refazer", "#porque", "#desfazer", "#regra"])(
    "%s sem o modo ligado não corrige nem inspeciona",
    async (command) => {
      conversationRow = conversationWith({ aiTestModeUntil: null });

      await run(command, "Título | conteúdo");

      expect(createKnowledgeCorrection).not.toHaveBeenCalled();
      expect(appendSteeringRule).not.toHaveBeenCalled();
      expect(replayLastQuestion).not.toHaveBeenCalled();
      expect(lastReply()).toContain("#iniciar");
    },
  );
});

describe("#refazer", () => {
  it("sem pergunta anterior avisa em vez de rodar em branco", async () => {
    findLastCustomerQuestion.mockResolvedValueOnce(null);

    await run("#refazer");

    expect(replayLastQuestion).not.toHaveBeenCalled();
    expect(lastReply()).toContain("refazer");
  });

  it("mostra a pergunta e reprocessa pelo caminho normal do inbound", async () => {
    findLastCustomerQuestion.mockResolvedValueOnce("quero cancelar meu curso");

    await run("#refazer");

    // O cabeçalho sai ANTES: o operador precisa saber o que está sendo
    // refeito enquanto a resposta nova é gerada.
    expect(lastReply()).toContain("quero cancelar meu curso");
    expect(replayLastQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION,
        question: "quero cancelar meu curso",
      }),
    );
  });
});

describe("#porque", () => {
  it("responde com o diagnóstico da última pergunta", async () => {
    findLastCustomerQuestion.mockResolvedValueOnce("quero cancelar");
    buildWhyReport.mockResolvedValueOnce({
      question: "quero cancelar",
      rule: {
        position: 2,
        label: "Cancelamento",
        action: "Transferir para um departamento",
      },
      llmInvoked: false,
      outcome: "HANDOFF_COMPLETED",
      confidence: null,
      documents: [],
      expired: [],
    });

    await run("#porque");

    const reply = lastReply();
    expect(reply).toContain("Regra de assunto 2");
    expect(reply).toContain("Cancelamento");
    expect(reply).toContain("modelo NÃO rodou");
  });
});

describe("#desfazer", () => {
  it("reverte regra quando a última correção foi regra", async () => {
    undoLastCorrection.mockResolvedValueOnce({
      field: "steeringRules",
      text: "não prometa transferência",
    });

    await run("#desfazer");

    expect(lastReply()).toContain("não prometa transferência");
    expect(lastReply()).toContain("Regras de condução");
  });

  it("reverte documento quando a última correção foi documento", async () => {
    undoLastCorrection.mockResolvedValueOnce({
      field: "knowledgeDoc",
      title: "Prazo de cancelamento",
    });

    await run("#desfazer");

    expect(lastReply()).toContain("Prazo de cancelamento");
    expect(lastReply()).toContain("base");
  });

  it("sem nada para desfazer avisa", async () => {
    undoLastCorrection.mockResolvedValueOnce(null);

    await run("#desfazer");

    expect(lastReply()).toContain("desfazer");
  });
});

describe("diagnóstico do #porque", () => {
  it("sem regra e sem documento aponta o prompt como responsável", () => {
    const text = formatWhyReport({
      question: "primeiro acesso",
      rule: null,
      llmInvoked: true,
      outcome: "ANSWERED",
      confidence: 0.9,
      documents: [],
      expired: [],
    });

    expect(text).toContain("Nenhuma regra de assunto pegou");
    expect(text).toContain("Nenhum documento da base");
    expect(text).toContain("Regras do agente");
  });

  it("lista os documentos consultados quando existem", () => {
    const text = formatWhyReport({
      question: "quero cancelar",
      rule: null,
      llmInvoked: true,
      outcome: "ANSWERED",
      confidence: null,
      documents: ["Cancelamento de matrícula"],
      expired: ["Calendário 2026.1"],
    });

    expect(text).toContain("Cancelamento de matrícula");
    expect(text).toContain("Calendário 2026.1");
    // Sem marcador de confiança quando o modelo não declarou.
    expect(text).not.toContain("Confiança");
  });
});
