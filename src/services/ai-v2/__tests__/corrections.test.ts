import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  logFindFirst: vi.fn(),
  logUpdate: vi.fn(),
  getV2Agent: vi.fn(),
  saveV2AgentDraft: vi.fn(),
  createKnowledgeDoc: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({ prismaBase: { $queryRawUnsafe: mocks.queryRaw, $executeRawUnsafe: mocks.executeRaw } }));
vi.mock("@/lib/prisma", () => ({
  prisma: { aISimpleTurnLog: { findFirst: mocks.logFindFirst, update: mocks.logUpdate }, contact: { findMany: vi.fn().mockResolvedValue([]) } },
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrNull: () => "org-1", getRequestContext: () => undefined }));
vi.mock("@/lib/ai-v2/config", () => ({ validateV2Config: (c: unknown) => ({ ok: true, data: c }) }));
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
vi.mock("../agents", () => ({ getV2Agent: mocks.getV2Agent, saveV2AgentDraft: mocks.saveV2AgentDraft }));
vi.mock("@/services/ai/knowledge-docs", () => ({ createKnowledgeDoc: mocks.createKnowledgeDoc }));

import {
  applyTestCorrection,
  attachCorrectionToLog,
  correctionInEffect,
  correctionsForTestTurn,
  detachCorrectionFromLog,
  dropTestCorrection,
  parseCorrectionSuggestion,
  testCorrectionSources,
  testCorrectionsPromptSection,
} from "../corrections";

const TEST_PHONE = "5511911112222";
const row = (over: Record<string, unknown> = {}) => ({
  id: "cor-1", organizationId: "org-1", agentId: "agent-1", conversationId: "conv-1", contactId: "c1", logId: "log-9", number: 3,
  question: "qual o prazo?", reply: "O prazo é de 5 dias.", text: "o prazo é de 10 dias", agentVersion: 16, status: "pending",
  suggestion: null, suggestionError: null, createdAt: new Date("2026-11-25T15:00:00Z"), decidedAt: null, decidedById: null, ...over,
});
/** Roteia as consultas do módulo pelo texto do SQL. */
function db(args: { corrections?: unknown[]; publishedAt?: Date | null }) {
  mocks.queryRaw.mockImplementation(async (sql: string) => {
    if (sql.includes(`MAX("createdAt")`)) return [{ at: args.publishedAt ?? null }];
    if (sql.includes(`FROM "ai_v2_test_corrections"`)) return args.corrections ?? [];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeRaw.mockResolvedValue(1);
  db({ corrections: [row()] });
});

describe("somente em teste", () => {
  it("agente sem lista de números (atende clientes reais): nunca recebe correção e o banco nem é consultado", async () => {
    const out = await correctionsForTestTurn({ organizationId: "org-1", agentId: "agent-1", config: { allowedPhoneNumbers: [] }, phone: TEST_PHONE });
    expect(out).toEqual([]);
    expect(mocks.queryRaw).not.toHaveBeenCalled();

    expect(await correctionsForTestTurn({ organizationId: "org-1", agentId: "agent-1", config: {}, phone: TEST_PHONE })).toEqual([]);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("telefone fora da lista de teste (ou conversa sem telefone): não recebe", async () => {
    const config = { allowedPhoneNumbers: [TEST_PHONE] };
    expect(await correctionsForTestTurn({ organizationId: "org-1", agentId: "agent-1", config, phone: "5511900000000" })).toEqual([]);
    expect(await correctionsForTestTurn({ organizationId: "org-1", agentId: "agent-1", config, phone: null })).toEqual([]);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("número de teste: recebe as correções em vigor do próprio agente", async () => {
    const out = await correctionsForTestTurn({ organizationId: "org-1", agentId: "agent-1", config: { allowedPhoneNumbers: [TEST_PHONE] }, phone: "+55 11 91111-2222" });
    expect(out).toEqual([{ number: 3, question: "qual o prazo?", reply: "O prazo é de 5 dias.", text: "o prazo é de 10 dias" }]);
    const [sql, org, agent] = mocks.queryRaw.mock.calls[0];
    expect(sql).toContain(`"organizationId" = $1 AND "agentId" = $2 AND "status" IN ('pending','applied')`);
    expect([org, agent]).toEqual(["org-1", "agent-1"]);
  });

  it("aplicada no rascunho vale até sair uma versão publicada depois; descartada e desfeita nunca valem", async () => {
    const published = new Date("2026-11-25T16:00:00Z");
    expect(correctionInEffect({ status: "pending", decidedAt: null }, published)).toBe(true);
    expect(correctionInEffect({ status: "applied", decidedAt: "2026-11-25T17:00:00.000Z" }, published)).toBe(true);
    expect(correctionInEffect({ status: "applied", decidedAt: "2026-11-25T15:00:00.000Z" }, published)).toBe(false);
    expect(correctionInEffect({ status: "applied", decidedAt: "2026-11-25T15:00:00.000Z" }, null)).toBe(true);
    expect(correctionInEffect({ status: "discarded", decidedAt: "2026-11-25T17:00:00.000Z" }, published)).toBe(false);
    expect(correctionInEffect({ status: "undone", decidedAt: "2026-11-25T17:00:00.000Z" }, null)).toBe(false);

    db({
      publishedAt: published,
      corrections: [
        row({ id: "a", number: 1, status: "applied", decidedAt: new Date("2026-11-25T15:30:00Z") }),
        row({ id: "b", number: 2, status: "applied", decidedAt: new Date("2026-11-25T16:30:00Z") }),
        row({ id: "c", number: 3 }),
      ],
    });
    const out = await correctionsForTestTurn({ organizationId: "org-1", agentId: "agent-1", config: { allowedPhoneNumbers: [TEST_PHONE] }, phone: TEST_PHONE });
    expect(out.map((c) => c.number)).toEqual([2, 3]);
  });
});

describe("prompt e fontes", () => {
  const items = [{ number: 3, question: "qual o prazo?", reply: "O prazo é de 5 dias.", text: "o prazo é de 10 dias" }];

  it("sem correção não há seção", () => {
    expect(testCorrectionsPromptSection([])).toBe("");
    expect(testCorrectionsPromptSection(undefined)).toBe("");
    expect(testCorrectionSources(undefined)).toEqual([]);
  });

  it("a seção traz a pergunta, a resposta errada e a correção, com prioridade", () => {
    const s = testCorrectionsPromptSection(items);
    expect(s).toContain("prioridade");
    expect(s).toContain(`Pergunta: "qual o prazo?"`);
    expect(s).toContain(`Resposta que estava errada: "O prazo é de 5 dias."`);
    expect(s).toContain("Correção: o prazo é de 10 dias");
  });

  it("só o que a correção afirma é fonte da conferência — a resposta errada não", () => {
    expect(testCorrectionSources(items)).toEqual(["o prazo é de 10 dias"]);
  });
});

describe("marca no turno corrigido", () => {
  it("turno sem feedback: grava como vindo do WhatsApp", async () => {
    mocks.logFindFirst.mockResolvedValue({ id: "log-9", feedback: null });
    await attachCorrectionToLog("log-9", { id: "cor-1", number: 3, text: "o prazo é de 10 dias" });
    const feedback = mocks.logUpdate.mock.calls[0][0].data.feedback;
    expect(feedback).toMatchObject({ via: "whatsapp", diagnosis: null, byUserId: null, comment: "#corrigir nº 3: o prazo é de 10 dias" });
    expect(feedback.corrections).toHaveLength(1);
  });

  it("turno já marcado na tela: mantém o comentário e o diagnóstico", async () => {
    const diagnosis = { resumo: "r", causa: "c", categoria: "material" };
    mocks.logFindFirst.mockResolvedValue({ id: "log-9", feedback: { comment: "errou o prazo", createdAt: "2026-11-25T10:00:00.000Z", byUserId: "u1", diagnosis } });
    await attachCorrectionToLog("log-9", { id: "cor-1", number: 3, text: "o prazo é de 10 dias" });
    const feedback = mocks.logUpdate.mock.calls[0][0].data.feedback;
    expect(feedback).toMatchObject({ baseComment: "errou o prazo", byUserId: "u1", diagnosis, comment: "errou o prazo\n#corrigir nº 3: o prazo é de 10 dias" });
    expect(feedback.via).toBeUndefined();
  });

  it("desfazer a única correção devolve o turno ao estado sem feedback", async () => {
    mocks.logFindFirst.mockResolvedValue({ id: "log-9", feedback: { comment: "x", createdAt: "t", byUserId: null, diagnosis: null, via: "whatsapp", corrections: [{ id: "cor-1", number: 3, text: "x", at: "t" }] } });
    await detachCorrectionFromLog("log-9", "cor-1");
    expect(mocks.logUpdate.mock.calls[0][0].data.feedback).toBeNull();
  });

  it("desfazer mantém o que foi marcado na tela e as outras correções", async () => {
    mocks.logFindFirst.mockResolvedValue({
      id: "log-9",
      feedback: { comment: "x", createdAt: "t", byUserId: "u1", diagnosis: { resumo: "r" }, baseComment: "errou o prazo", corrections: [{ id: "cor-1", number: 3, text: "a", at: "t" }, { id: "cor-2", number: 4, text: "b", at: "t" }] },
    });
    await detachCorrectionFromLog("log-9", "cor-1");
    const feedback = mocks.logUpdate.mock.calls[0][0].data.feedback;
    expect(feedback.comment).toBe("errou o prazo\n#corrigir nº 4: b");
    expect(feedback.diagnosis).toEqual({ resumo: "r" });
  });
});

describe("sugestão para o rascunho", () => {
  it("lê regra e material; formato inválido vira nulo", () => {
    expect(parseCorrectionSuggestion('```json\n{"tipo":"regra","texto":"Não ofereça desconto antes de a pessoa pedir.","motivo":"comportamento"}\n```')).toEqual({
      tipo: "regra", titulo: "", texto: "Não ofereça desconto antes de a pessoa pedir.", motivo: "comportamento",
    });
    expect(parseCorrectionSuggestion('{"tipo":"material","titulo":"Prazo","texto":"Pergunta: qual o prazo?\\nResposta: 10 dias."}')).toMatchObject({ tipo: "material", titulo: "Prazo" });
    expect(parseCorrectionSuggestion('{"tipo":"outra","texto":"x"}')).toBeNull();
    expect(parseCorrectionSuggestion("não sei")).toBeNull();
  });
});

describe("decisão na tela", () => {
  const agent = { publishedConfig: { model: "gpt-x", globalRules: ["publicada"], allowedKnowledgeDocIds: [] }, draftConfig: { model: "gpt-x", globalRules: ["rascunho"], allowedKnowledgeDocIds: ["doc-0"] } };

  beforeEach(() => {
    mocks.getV2Agent.mockResolvedValue(agent);
    mocks.saveV2AgentDraft.mockResolvedValue({});
  });

  it("regra: entra nas regras gerais do RASCUNHO; a publicada não é tocada", async () => {
    db({ corrections: [row({ suggestion: { tipo: "regra", titulo: "", texto: "Diga o prazo de 10 dias.", motivo: "" } })] });
    await applyTestCorrection({ organizationId: "org-1", agentId: "agent-1", id: "cor-1", userId: "u1" });

    expect(mocks.saveV2AgentDraft).toHaveBeenCalledTimes(1);
    const [agentId, orgId, input] = mocks.saveV2AgentDraft.mock.calls[0];
    expect([agentId, orgId]).toEqual(["agent-1", "org-1"]);
    expect(input.config.globalRules).toEqual(["rascunho", "Diga o prazo de 10 dias."]);
    expect(agent.publishedConfig.globalRules).toEqual(["publicada"]);
    expect(agent.draftConfig.globalRules).toEqual(["rascunho"]);
    // Nenhuma escrita fora da tabela de correções.
    for (const [sql] of mocks.executeRaw.mock.calls) expect(sql).toContain(`"ai_v2_test_corrections"`);
  });

  it("material: cria o material e libera só no rascunho; texto editado na tela vale", async () => {
    db({ corrections: [row({ suggestion: { tipo: "material", titulo: "Prazo", texto: "Pergunta: prazo?\nResposta: 5 dias.", motivo: "" } })] });
    mocks.createKnowledgeDoc.mockResolvedValue({ id: "doc-9" });
    const out = await applyTestCorrection({ organizationId: "org-1", agentId: "agent-1", id: "cor-1", userId: "u1", override: { texto: "Pergunta: prazo?\nResposta: 10 dias." } });

    expect(mocks.createKnowledgeDoc).toHaveBeenCalledWith("agent-1", { title: "Prazo", content: "Pergunta: prazo?\nResposta: 10 dias." });
    expect(mocks.saveV2AgentDraft.mock.calls[0][2].config.allowedKnowledgeDocIds).toEqual(["doc-0", "doc-9"]);
    expect(out.knowledgeDocId).toBe("doc-9");
  });

  it("sem sugestão nem texto: recusa sem mexer no rascunho", async () => {
    await expect(applyTestCorrection({ organizationId: "org-1", agentId: "agent-1", id: "cor-1", userId: "u1" })).rejects.toThrow("Sem sugestão");
    expect(mocks.saveV2AgentDraft).not.toHaveBeenCalled();
  });

  it("correção já decidida não é aplicada de novo", async () => {
    db({ corrections: [row({ status: "discarded" })] });
    await expect(applyTestCorrection({ organizationId: "org-1", agentId: "agent-1", id: "cor-1", userId: "u1", override: { tipo: "regra", texto: "x" } })).rejects.toThrow("já foi decidida");
    expect(mocks.saveV2AgentDraft).not.toHaveBeenCalled();
  });

  it("descartar tira a correção dos testes e do turno, sem tocar na configuração", async () => {
    mocks.logFindFirst.mockResolvedValue({ id: "log-9", feedback: { comment: "x", createdAt: "t", byUserId: null, diagnosis: null, via: "whatsapp", corrections: [{ id: "cor-1", number: 3, text: "x", at: "t" }] } });
    expect(await dropTestCorrection({ organizationId: "org-1", agentId: "agent-1", id: "cor-1", userId: "u1", to: "discarded" })).toBe(true);
    expect(mocks.executeRaw.mock.calls[0][0]).toContain(`"status" IN ('pending','applied')`);
    expect(mocks.executeRaw.mock.calls[0]).toContain("discarded");
    expect(mocks.logUpdate.mock.calls[0][0].data.feedback).toBeNull();
    expect(mocks.saveV2AgentDraft).not.toHaveBeenCalled();
  });

  it("desfazer pelo WhatsApp só alcança correção pendente", async () => {
    await dropTestCorrection({ organizationId: "org-1", agentId: "agent-1", id: "cor-1", userId: null, to: "undone" });
    expect(mocks.executeRaw.mock.calls[0][0]).toContain(`"status" IN ('pending')`);
    expect(mocks.executeRaw.mock.calls[0]).toContain("undone");
  });
});
