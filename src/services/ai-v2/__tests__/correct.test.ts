import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contactFindUnique: vi.fn(),
  agentFindMany: vi.fn(),
  logFindMany: vi.fn(),
  sendAgentMessage: vi.fn(),
  tryClaim: vi.fn(),
  generate: vi.fn(),
  invalidateOpenTurns: vi.fn(),
  stateDeleteMany: vi.fn(),
  resolveInline: vi.fn(),
  store: {
    activeTestCorrections: vi.fn(),
    attachCorrectionToLog: vi.fn(),
    createTestCorrection: vi.fn(),
    draftCorrectionSuggestion: vi.fn(),
    dropTestCorrection: vi.fn(),
    lastPublishedVersion: vi.fn(),
    listTestCorrections: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findUnique: mocks.contactFindUnique },
    aIAgentConfig: { findMany: mocks.agentFindMany },
    aISimpleTurnLog: { findMany: mocks.logFindMany },
    aISimpleConversationState: { deleteMany: mocks.stateDeleteMany },
  },
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrNull: () => "org-1", getRequestContext: () => undefined }));
vi.mock("@/lib/cache", () => ({ cache: { tryClaim: mocks.tryClaim } }));
vi.mock("@/services/ai/phone-allowlist", () => {
  const normalizePhoneDigits = (raw: string | null | undefined) => {
    let d = String(raw ?? "").replace(/\D/g, "");
    if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
    return d;
  };
  return {
    normalizePhoneDigits,
    phoneMatchesAllowlist: (phone: string | null, allow: Set<string>) => {
      const n = normalizePhoneDigits(phone);
      return !!n && [...allow].some((p) => p && (n === p || n.endsWith(p) || p.endsWith(n)));
    },
  };
});
vi.mock("@/services/ai/send-agent-message", () => ({ sendAgentMessage: mocks.sendAgentMessage }));
vi.mock("@/services/ai/turn-manager", () => ({ invalidateOpenTurns: mocks.invalidateOpenTurns }));
vi.mock("@/services/conversations", () => ({ resolveConversationsInline: mocks.resolveInline }));
vi.mock("@/services/ai/provider", () => ({ generateWithTools: mocks.generate }));
vi.mock("../corrections", () => ({ CORRECTION_LIMITS: { textChars: 600, quoteChars: 300, maxActive: 20, suggestionChars: 1500 }, ...mocks.store }));

import { V2_CORRECT_REPLY_PREFIX, handleV2CorrectCommand, isV2CorrectCommand, isV2CorrectReply, parseV2CorrectCommand } from "../correct";

const TEST_PHONE = "5511911112222";
const agentRow = (id: string, phones: string[]) => ({ id, userId: `ai-${id}`, simpleConfig: { allowedPhoneNumbers: phones } });
const turn = (over: Record<string, unknown> = {}) => ({ id: "log-9", agentId: "agent-2", prompt: "", inboundText: "qual o prazo?", reply: "O prazo é de 5 dias.", ...over });
const correction = (over: Record<string, unknown> = {}) => ({ id: "cor-1", number: 3, text: "o prazo é de 10 dias", status: "pending", contactId: "c1", logId: "log-9", ...over });
const run = (userMessage: string, over: Record<string, unknown> = {}) =>
  handleV2CorrectCommand({ conversationId: "conv-1", contactId: "c1", channel: "meta", messageId: "msg-1", userMessage, ...over });
const sentText = () => String(mocks.sendAgentMessage.mock.calls[0]?.[0]?.text ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contactFindUnique.mockResolvedValue({ phone: "+55 11 91111-2222" });
  mocks.agentFindMany.mockResolvedValue([agentRow("agent-1", [TEST_PHONE]), agentRow("agent-2", [TEST_PHONE]), agentRow("agent-3", [])]);
  mocks.logFindMany.mockResolvedValue([turn()]);
  mocks.tryClaim.mockResolvedValue(true);
  mocks.sendAgentMessage.mockResolvedValue({ status: "sent" });
  mocks.store.activeTestCorrections.mockResolvedValue([]);
  mocks.store.listTestCorrections.mockResolvedValue([]);
  mocks.store.lastPublishedVersion.mockResolvedValue(16);
  mocks.store.createTestCorrection.mockImplementation(async (a: Record<string, unknown>) => ({ ...correction(), ...a }));
  mocks.store.attachCorrectionToLog.mockResolvedValue(undefined);
  mocks.store.draftCorrectionSuggestion.mockResolvedValue(null);
  mocks.store.dropTestCorrection.mockResolvedValue(true);
});

describe("#corrigir: reconhecimento", () => {
  it("só vale no começo da mensagem", () => {
    expect(parseV2CorrectCommand("#corrigir o prazo é de 10 dias")).toEqual({ kind: "add", text: "o prazo é de 10 dias" });
    expect(parseV2CorrectCommand("  #CORRIGIR: o certo é 20%  ")).toEqual({ kind: "add", text: "o certo é 20%" });
    expect(parseV2CorrectCommand("#corrigir\nfalou 30%, o certo é 20%")).toEqual({ kind: "add", text: "falou 30%, o certo é 20%" });
    expect(isV2CorrectCommand("quero #corrigir meu cadastro")).toBe(false);
    expect(isV2CorrectCommand("#corrigirei depois")).toBe(false);
    expect(isV2CorrectCommand("#reset")).toBe(false);
    expect(isV2CorrectCommand(null)).toBe(false);
  });

  it("variações: ajuda, lista e desfazer", () => {
    expect(parseV2CorrectCommand("#corrigir")).toEqual({ kind: "help" });
    expect(parseV2CorrectCommand("#corrigir lista")).toEqual({ kind: "list" });
    expect(parseV2CorrectCommand("#corrigir desfazer")).toEqual({ kind: "undo", number: null });
    expect(parseV2CorrectCommand("#corrigir desfazer nº 4")).toEqual({ kind: "undo", number: 4 });
    expect(parseV2CorrectCommand("#corrigir desfazer 12.")).toEqual({ kind: "undo", number: 12 });
    // Texto que só começa com a palavra é correção, não subcomando.
    expect(parseV2CorrectCommand("#corrigir lista de preços está desatualizada")).toEqual({ kind: "add", text: "lista de preços está desatualizada" });
  });

  it("toda resposta do comando é reconhecível (fica fora do histórico do agente)", () => {
    expect(isV2CorrectReply(`${V2_CORRECT_REPLY_PREFIX} — correção nº 1 anotada`)).toBe(true);
    expect(isV2CorrectReply("O prazo é de 5 dias.")).toBe(false);
  });
});

describe("#corrigir: quem pode", () => {
  it("número fora de toda lista de teste: segue como mensagem comum, sem gravar nem responder", async () => {
    mocks.contactFindUnique.mockResolvedValue({ phone: "5511900000000" });
    expect(await run("#corrigir o prazo é de 10 dias")).toBe(false);
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
    expect(mocks.store.createTestCorrection).not.toHaveBeenCalled();
    expect(mocks.tryClaim).not.toHaveBeenCalled();
  });

  it("organização só com agentes sem lista de teste (atendem clientes reais): o comando não existe", async () => {
    mocks.agentFindMany.mockResolvedValue([agentRow("agent-3", [])]);
    expect(await run("#corrigir o prazo é de 10 dias")).toBe(false);
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
    expect(mocks.store.createTestCorrection).not.toHaveBeenCalled();
  });

  it("só agentes v2 ativos entram na busca", async () => {
    await run("#corrigir o prazo é de 10 dias");
    expect(mocks.agentFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: "org-1", engine: "simple", active: true } }));
  });

  it("webhook repetido não grava nem confirma duas vezes", async () => {
    mocks.tryClaim.mockResolvedValue(false);
    expect(await run("#corrigir o prazo é de 10 dias")).toBe(true);
    expect(mocks.store.createTestCorrection).not.toHaveBeenCalled();
    expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  });
});

describe("#corrigir: registro", () => {
  it("grava ligada à última resposta, no agente que respondeu, marca o turno e confirma", async () => {
    expect(await run("#corrigir o prazo é de 10 dias, não 5")).toBe(true);

    expect(mocks.store.createTestCorrection).toHaveBeenCalledWith({
      organizationId: "org-1",
      agentId: "agent-2",
      conversationId: "conv-1",
      contactId: "c1",
      logId: "log-9",
      question: "qual o prazo?",
      reply: "O prazo é de 5 dias.",
      text: "o prazo é de 10 dias, não 5",
      agentVersion: 16,
    });
    expect(mocks.store.attachCorrectionToLog).toHaveBeenCalledWith("log-9", expect.objectContaining({ id: "cor-1", number: 3 }));
    expect(mocks.sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({ agentUserId: "ai-agent-2", conversationId: "conv-1", bypassAssigneeCheck: true }));
    expect(sentText().startsWith(V2_CORRECT_REPLY_PREFIX)).toBe(true);
    expect(sentText()).toContain("nº 3");
    expect(sentText()).toContain("#corrigir desfazer");
    expect(mocks.store.draftCorrectionSuggestion).toHaveBeenCalledWith({ organizationId: "org-1", agentId: "agent-2", id: "cor-1" });
  });

  it("não chama o modelo de atendimento, não mexe no estado da conversa e não encerra o ticket", async () => {
    await run("#corrigir o prazo é de 10 dias");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.invalidateOpenTurns).not.toHaveBeenCalled();
    expect(mocks.stateDeleteMany).not.toHaveBeenCalled();
    expect(mocks.resolveInline).not.toHaveBeenCalled();
  });

  it("falha ao gerar a sugestão não derruba o comando", async () => {
    mocks.store.draftCorrectionSuggestion.mockRejectedValue(new Error("modelo fora"));
    expect(await run("#corrigir o prazo é de 10 dias")).toBe(true);
    expect(sentText()).toContain("anotada");
  });

  it("sem resposta do agente depois do #reset: avisa e não grava", async () => {
    mocks.logFindMany.mockResolvedValue([{ ...turn({ id: "log-r", prompt: "reset", reply: "Atendimento reiniciado." }) }, turn()]);
    expect(await run("#corrigir o prazo é de 10 dias")).toBe(true);
    expect(mocks.store.createTestCorrection).not.toHaveBeenCalled();
    expect(sentText()).toContain("não achei uma resposta");
  });

  it("última resposta de um agente em que o número não é de teste: não grava", async () => {
    mocks.logFindMany.mockResolvedValue([turn({ agentId: "agent-3" })]);
    expect(await run("#corrigir o prazo é de 10 dias")).toBe(true);
    expect(mocks.store.createTestCorrection).not.toHaveBeenCalled();
    expect(sentText()).toContain("não achei uma resposta");
  });

  it("turno sem resposta (erro) é pulado: corrige a resposta anterior", async () => {
    mocks.logFindMany.mockResolvedValue([turn({ id: "log-10", reply: null }), turn()]);
    await run("#corrigir o prazo é de 10 dias");
    expect(mocks.store.createTestCorrection).toHaveBeenCalledWith(expect.objectContaining({ logId: "log-9" }));
  });

  it("no limite de correções em vigor: avisa e não grava", async () => {
    mocks.store.activeTestCorrections.mockResolvedValue(Array.from({ length: 20 }, (_, i) => correction({ id: `c${i}`, number: i + 1 })));
    await run("#corrigir o prazo é de 10 dias");
    expect(mocks.store.createTestCorrection).not.toHaveBeenCalled();
    expect(sentText()).toContain("20 correções");
  });
});

describe("#corrigir: ajuda, lista e desfazer", () => {
  it("sozinho explica o uso, sem gravar", async () => {
    expect(await run("#corrigir")).toBe(true);
    expect(sentText()).toContain("Exemplo");
    expect(mocks.store.createTestCorrection).not.toHaveBeenCalled();
  });

  it("lista as correções em vigor do agente da conversa", async () => {
    mocks.store.activeTestCorrections.mockResolvedValue([correction(), correction({ id: "cor-0", number: 2, text: "desconto é 20%", status: "applied" })]);
    await run("#corrigir lista");
    expect(mocks.store.activeTestCorrections).toHaveBeenCalledWith("org-1", "agent-2");
    expect(sentText()).toContain("nº 3: o prazo é de 10 dias");
    expect(sentText()).toContain("nº 2 (no rascunho): desconto é 20%");
  });

  it("lista vazia", async () => {
    await run("#corrigir lista");
    expect(sentText()).toContain("nenhuma correção");
  });

  it("desfazer sem número: a última pendente de quem pediu", async () => {
    mocks.store.listTestCorrections.mockResolvedValue([correction({ id: "cor-9", number: 5, contactId: "outro" }), correction()]);
    await run("#corrigir desfazer");
    expect(mocks.store.dropTestCorrection).toHaveBeenCalledWith({ organizationId: "org-1", agentId: "agent-2", id: "cor-1", userId: null, to: "undone" });
    expect(sentText()).toContain("nº 3 desfeita");
  });

  it("desfazer com número", async () => {
    mocks.store.listTestCorrections.mockResolvedValue([correction({ id: "cor-9", number: 5, contactId: "outro" }), correction()]);
    await run("#corrigir desfazer 5");
    expect(mocks.store.dropTestCorrection).toHaveBeenCalledWith(expect.objectContaining({ id: "cor-9", to: "undone" }));
  });

  it("nada para desfazer", async () => {
    await run("#corrigir desfazer");
    expect(mocks.store.dropTestCorrection).not.toHaveBeenCalled();
    expect(sentText()).toContain("não tem correção pendente");
  });
});
