import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resumo para a equipe (gravação e resumo corrente) e estado da conversa
 * (herança da janela pós-encerramento, zeragem): o que vai ao banco e o
 * que acontece quando o modelo ou o banco falham.
 */

const mocks = vi.hoisted(() => ({
  messageFindMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
  messageCreate: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "m-s" })),
  conversationFindMany: vi.fn(async (_args: unknown): Promise<Array<{ id: string }>> => []),
  stateFindFirst: vi.fn(async (_args: unknown): Promise<unknown> => null),
  stateUpdate: vi.fn(async (_args: unknown) => undefined),
  stateUpdateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  generate: vi.fn(async (_args: Record<string, unknown>): Promise<{ text: string }> => ({ text: "" })),
  traceStep: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: { findMany: mocks.messageFindMany, create: mocks.messageCreate },
    conversation: { findMany: mocks.conversationFindMany },
    aISimpleConversationState: { findFirst: mocks.stateFindFirst, update: mocks.stateUpdate, updateMany: mocks.stateUpdateMany },
  },
}));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/services/ai/agent-key", () => ({ tryGetAgentApiKey: async () => "k", getAgentChatKey: async () => "k" }));
vi.mock("@/services/ai/provider", () => ({ generateWithTools: mocks.generate }));
vi.mock("../trace", () => ({ traceStep: mocks.traceStep }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { findInheritablePostCloseState, resetV2Counters, resetV2ConversationStateOwner } from "../state";
import { SUMMARY_MESSAGE_TYPE, updateRunningSummary, writeV2Summary } from "../summary";

const at = (s: string) => new Date(`2026-03-10T${s}:00.000Z`);
const msg = (direction: "in" | "out", content: string, time: string, authorType: string | null = null) => ({ direction, content, createdAt: at(time), authorType });
const config = (summary: Record<string, unknown> | undefined) => normalizeV2Config({ name: "Agente", tone: "t", closure: summary ? { summary } : {} });

describe("resumo gravado para a equipe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.messageFindMany.mockResolvedValue([]);
    mocks.generate.mockResolvedValue({ text: "" });
  });

  it("desligado: não lê nem grava nada", async () => {
    expect(await writeV2Summary({ organizationId: "org-1", conversationId: "conv-1", agentId: "agent-1", config: config(undefined), moment: "close", reason: "resolved" })).toBeNull();
    expect(mocks.messageFindMany).not.toHaveBeenCalled();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("conversa curta: resumo pelo histórico (sem modelo), gravado como mensagem privada do agente", async () => {
    mocks.messageFindMany.mockResolvedValue([msg("out", "Enviei a orientação.", "10:05"), msg("in", "Não consigo entrar", "10:02")]);
    const text = await writeV2Summary({ organizationId: "org-1", conversationId: "conv-1", agentId: "agent-1", config: config({ enabled: true, verbosity: "standard" }), moment: "close", reason: "resolved", tabulation: "Suporte › Acesso" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(text?.split("\n")).toEqual([
      "Motivo: Não consigo entrar",
      "O que foi feito: Enviei a orientação.",
      "Pendência: Nenhuma",
      "Resultado: Encerrado: resolvido",
      "Tabulação: Suporte › Acesso",
      "Próximo passo: —",
    ]);
    expect(mocks.messageCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ organizationId: "org-1", conversationId: "conv-1", content: text, direction: "out", messageType: SUMMARY_MESSAGE_TYPE, isPrivate: true, authorType: "bot", senderName: "Agente" }) });
    // Só mensagens visíveis entram no histórico: sem notas, rascunhos, resumos ou eventos.
    expect(mocks.messageFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isPrivate: false, messageType: { notIn: ["note", "ai_draft", SUMMARY_MESSAGE_TYPE] } }) }));
    expect(mocks.traceStep).toHaveBeenCalledWith("resumo", expect.stringContaining("pelo histórico"));
  });

  it("conversa com duas ou mais mensagens do cliente: o modelo resume; o resultado é do sistema; dado sensível sai mascarado", async () => {
    mocks.messageFindMany.mockResolvedValue([
      msg("out", "Pronto, ajustado.", "10:08"),
      msg("in", "Agora deu certo, obrigado", "10:07"),
      msg("out", "Tenta de novo.", "10:05", "human"),
      msg("in", "Não consigo entrar", "10:02"),
    ]);
    mocks.generate.mockResolvedValue({ text: '```json\n{"motivo":"Não conseguia entrar","feito":"Acesso ajustado pela equipe","pendencia":"","resultado":"inventado","proximo":"Nada","dados":["cartão: 4111 1111 1111 1111"],"marcos":["10:05 — equipe orientou"]}\n```' });

    const text = await writeV2Summary({ organizationId: "org-1", conversationId: "conv-1", agentId: "agent-1", config: config({ enabled: true, verbosity: "detailed" }), moment: "transfer", reason: "department" });

    const prompt = mocks.generate.mock.calls[0][0] as { system: string; messages: Array<{ content: string }> };
    expect(prompt.system).toContain("Resultado deste atendimento: Transferido para a equipe");
    expect(prompt.messages[0].content).toContain("Equipe: Tenta de novo.");
    expect(prompt.messages[0].content).toContain("Cliente: Não consigo entrar");
    expect(text).toContain("Motivo: Não conseguia entrar");
    expect(text).toContain("Resultado: Transferido para a equipe");
    expect(text).toContain("Pendência: Nenhuma");
    expect(text).toContain("Mensagens-chave: 10:05 — equipe orientou");
    expect(text).not.toContain("4111 1111 1111 1111");
    expect(mocks.traceStep).toHaveBeenCalledWith("resumo", expect.stringContaining("pelo modelo"));
  });

  it("modelo falha ou devolve lixo: resumo pelo histórico; banco falha: devolve null sem lançar", async () => {
    mocks.messageFindMany.mockResolvedValue([msg("in", "e agora?", "10:07"), msg("out", "Tenta de novo.", "10:05"), msg("in", "Não consigo entrar", "10:02")]);
    mocks.generate.mockRejectedValueOnce(new Error("timeout"));
    const cfg = config({ enabled: true, verbosity: "minimal" });
    expect(await writeV2Summary({ organizationId: "org-1", conversationId: "conv-1", agentId: "agent-1", config: cfg, moment: "close", reason: "inactivity" })).toBe("Não consigo entrar → Encerrado por inatividade · Cliente escreveu por último, sem resposta");
    mocks.generate.mockResolvedValueOnce({ text: "sem json" });
    expect(await writeV2Summary({ organizationId: "org-1", conversationId: "conv-1", agentId: "agent-1", config: cfg, moment: "close", reason: "deferred" })).toContain("Encerrado: cliente vai falar depois");
    mocks.messageCreate.mockRejectedValueOnce(new Error("db"));
    expect(await writeV2Summary({ organizationId: "org-1", conversationId: "conv-1", agentId: "agent-1", config: cfg, moment: "close", reason: "resolved" })).toBeNull();
    expect(mocks.traceStep).toHaveBeenLastCalledWith("resumo", expect.stringContaining("não gravado"));
  });

  it("histórico vazio: nada gravado", async () => {
    expect(await writeV2Summary({ organizationId: "org-1", conversationId: "conv-1", agentId: "agent-1", config: config({ enabled: true }), moment: "close", reason: "resolved" })).toBeNull();
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });
});

describe("resumo corrente (a cada resposta)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.messageFindMany.mockResolvedValue([msg("out", "Tenta de novo.", "10:05"), msg("in", "Não consigo entrar", "10:02")]);
  });

  it("só com 'a cada resposta' ligado; devolve o texto padrão sem gravar mensagem", async () => {
    expect(await updateRunningSummary({ conversationId: "conv-1", agentId: "agent-1", config: config({ enabled: true }) })).toBeNull();
    const text = await updateRunningSummary({ conversationId: "conv-1", agentId: "agent-1", config: config({ enabled: true, everyTurn: true }) });
    expect(text).toContain("Resultado: Em andamento");
    expect(text).toContain("Motivo: Não consigo entrar");
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });

  it("falha ao ler o histórico: null, sem lançar", async () => {
    mocks.messageFindMany.mockRejectedValue(new Error("db"));
    expect(await updateRunningSummary({ conversationId: "conv-1", agentId: "agent-1", config: config({ enabled: true, everyTurn: true }) })).toBeNull();
  });
});

describe("estado da conversa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.conversationFindMany.mockResolvedValue([]);
    mocks.stateFindFirst.mockResolvedValue(null);
  });

  it("herança da janela pós-encerramento: procura nos últimos tickets resolvidos do contato, do mesmo agente, ainda na janela", async () => {
    const now = at("12:00");
    expect(await findInheritablePostCloseState({ contactId: "ct-1", conversationId: "conv-new", agentId: "agent-1", now })).toBeNull();
    expect(mocks.stateFindFirst).not.toHaveBeenCalled();

    mocks.conversationFindMany.mockResolvedValue([{ id: "conv-old" }, { id: "conv-older" }]);
    const row = { id: "st-1", conversationId: "conv-old", stage: "closed", postCloseWindowEndAt: at("13:00") };
    mocks.stateFindFirst.mockResolvedValue(row);
    expect(await findInheritablePostCloseState({ contactId: "ct-1", conversationId: "conv-new", agentId: "agent-1", now })).toBe(row);
    expect(mocks.conversationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { contactId: "ct-1", id: { not: "conv-new" }, status: "RESOLVED" }, take: 5 }));
    expect(mocks.stateFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId: { in: ["conv-old", "conv-older"] }, agentId: "agent-1", stage: "closed", postCloseWindowEndAt: { gt: now } },
    }));
  });

  it("zerar contadores grava os valores iniciais; atribuição a um agente devolve o estado ao agente em 'idle'", async () => {
    await resetV2Counters("conv-1");
    expect(mocks.stateUpdate).toHaveBeenCalledWith({ where: { conversationId: "conv-1" }, data: { counters: expect.objectContaining({ courtesyReplies: 0, helpOffers: 0, aiTransferCount: 0 }) } });
    await resetV2ConversationStateOwner("conv-1");
    expect(mocks.stateUpdateMany).toHaveBeenCalledWith({ where: { conversationId: "conv-1" }, data: { owner: "agente", stage: "idle", humanActive: false, identificationAttempts: 0 } });
  });
});
