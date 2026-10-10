import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Módulos pequenos do motor v2 sem teste próprio: dono da conversa,
 * pesquisa de satisfação e ponte com fluxos de automação.
 */

const mocks = vi.hoisted(() => ({
  activeContexts: vi.fn(async (): Promise<unknown[]> => []),
  continueFromStep: vi.fn(async () => undefined),
  surveyCreate: vi.fn(async () => ({})),
}));

vi.mock("@/services/automation-context", () => ({ getContactActiveContexts: mocks.activeContexts }));
vi.mock("@/services/automation-executor", () => ({ continueFromStep: mocks.continueFromStep }));
vi.mock("@/lib/prisma", () => ({ prisma: { aIAgentSurveyResponse: { create: mocks.surveyCreate } } }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { continueV2AutomationOnClose, loadV2AutomationBridge, mapAutomationVariables } from "../automation-bridge";
import { canChangeOwner, ownerTransitionMessage, parseOwner } from "../owner";
import { buildSurveyMessage, parseSurveyScore, recordSurveyResponse } from "../survey";

describe("dono da conversa", () => {
  it("pessoa só perde para agente (devolução), fluxo de automação ou ninguém; nunca para outra pessoa por este caminho", () => {
    expect(canChangeOwner("pessoa", "pessoa")).toBe(true);
    expect(canChangeOwner("pessoa", "agente")).toBe(true);
    expect(canChangeOwner("pessoa", "automation")).toBe(true);
    expect(canChangeOwner("pessoa", "ninguem")).toBe(true);
  });

  it("agente perde para qualquer um; fluxo de automação perde para pessoa, agente ou ninguém; ninguém aceita qualquer", () => {
    for (const to of ["pessoa", "automation", "agente", "ninguem"] as const) {
      expect(canChangeOwner("agente", to)).toBe(true);
      expect(canChangeOwner("ninguem", to)).toBe(true);
    }
    expect(canChangeOwner("automation", "pessoa")).toBe(true);
    expect(canChangeOwner("automation", "agente")).toBe(true);
    expect(canChangeOwner("automation", "ninguem")).toBe(true);
    expect(canChangeOwner("automation", "automation")).toBe(true);
  });

  it("valor gravado desconhecido ou vazio vira agente", () => {
    expect(parseOwner(null)).toBe("agente");
    expect(parseOwner(undefined)).toBe("agente");
    expect(parseOwner("")).toBe("agente");
    expect(parseOwner("humano")).toBe("agente");
    expect(parseOwner("pessoa")).toBe("pessoa");
    expect(parseOwner("automation")).toBe("automation");
    expect(parseOwner("ninguem")).toBe("ninguem");
  });

  it("mensagem de transição é legível no rastro", () => {
    expect(ownerTransitionMessage({ from: "agente", to: "pessoa", reason: "transferência" })).toBe("dono: agente → pessoa (transferência)");
  });
});

describe("pesquisa de satisfação", () => {
  it("só pergunta quando está ligada", () => {
    expect(buildSurveyMessage(normalizeV2Config({ name: "A", tone: "t" }))).toBeNull();
    expect(buildSurveyMessage(normalizeV2Config({ name: "A", tone: "t", survey: { enabled: true, question: "De 0 a 10?" } }))).toBe("De 0 a 10?");
  });

  it("NPS aceita 0 a 10; CSAT 1 a 5; fora da faixa ou sem número não conta", () => {
    expect(parseSurveyScore("10", "nps")).toBe(10);
    expect(parseSurveyScore("Dou nota 8 pra vocês", "nps")).toBe(8);
    expect(parseSurveyScore("0", "nps")).toBe(0);
    expect(parseSurveyScore("11", "nps")).toBeNull();
    expect(parseSurveyScore("ótimo", "nps")).toBeNull();
    expect(parseSurveyScore("5", "csat")).toBe(5);
    expect(parseSurveyScore("nota 1", "csat")).toBe(1);
    expect(parseSurveyScore("0", "csat")).toBeNull();
    expect(parseSurveyScore("6", "csat")).toBeNull();
  });

  it("binária: sim/gostei/ok → 1, não/ruim → 0, resto não conta", () => {
    expect(parseSurveyScore("Sim, gostei", "binary")).toBe(1);
    expect(parseSurveyScore("ok", "binary")).toBe(1);
    expect(parseSurveyScore("não", "binary")).toBe(0);
    expect(parseSurveyScore("achei ruim", "binary")).toBe(0);
    expect(parseSurveyScore("talvez", "binary")).toBeNull();
  });

  it("registro da resposta grava o que veio e não derruba o fluxo quando a tabela não existe", async () => {
    await recordSurveyResponse({ organizationId: "org-1", contactId: "ct-1", agentId: "agent-1", score: 9, reason: "rápido" });
    expect(mocks.surveyCreate).toHaveBeenCalledWith({
      data: { organizationId: "org-1", contactId: "ct-1", dealId: null, agentId: "agent-1", score: 9, reason: "rápido" },
    });
    mocks.surveyCreate.mockRejectedValueOnce(new Error("relation does not exist"));
    await expect(recordSurveyResponse({ organizationId: "org-1", contactId: "ct-1", dealId: "deal-1", agentId: "agent-1", score: 1 })).resolves.toBeUndefined();
  });
});

describe("ponte com fluxos de automação", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeContexts.mockResolvedValue([]);
  });

  it("sem contexto ativo: ponte vazia", async () => {
    expect(await loadV2AutomationBridge("ct-1")).toEqual({ variables: {} });
  });

  it("com contexto: usa o mais recente, com fluxo, etapa e variáveis", async () => {
    mocks.activeContexts.mockResolvedValue([
      { automationId: "auto-2", currentStepId: "step-b", variables: { origem: "site" } },
      { automationId: "auto-1", currentStepId: null, variables: null },
    ]);
    expect(await loadV2AutomationBridge("ct-1")).toEqual({ automationId: "auto-2", stepId: "step-b", variables: { origem: "site" } });
    mocks.activeContexts.mockResolvedValue([{ automationId: "auto-1", currentStepId: null, variables: null }]);
    expect(await loadV2AutomationBridge("ct-1")).toEqual({ automationId: "auto-1", stepId: undefined, variables: {} });
  });

  it("mapeia só as variáveis do fluxo que existem, com o nome do agente", () => {
    const config = normalizeV2Config({ name: "A", tone: "t", entry: { automationVariablesMapping: { origem: "canal_origem", plano: "plano" } } });
    expect(mapAutomationVariables({ variables: { origem: "site", outra: 1 } }, config)).toEqual({ canal_origem: "site" });
    expect(mapAutomationVariables({ variables: {} }, config)).toEqual({});
  });

  it("no encerramento: retoma o fluxo na etapa configurada juntando as variáveis do fluxo com as coletadas", async () => {
    const config = normalizeV2Config({ name: "A", tone: "t", closure: { nextAutomationStepId: "step-z" } });
    mocks.activeContexts.mockResolvedValue([{ automationId: "auto-2", currentStepId: "step-b", variables: { origem: "site", plano: "antigo" } }]);
    await continueV2AutomationOnClose({ config, contactId: "ct-1", collectedVariables: { plano: "novo", email: "x@y.z" } });
    expect(mocks.continueFromStep).toHaveBeenCalledWith("auto-2", "ct-1", "step-z", { origem: "site", plano: "novo", email: "x@y.z" });
  });

  it("no encerramento: sem etapa configurada ou sem contexto ativo, não retoma nada", async () => {
    await continueV2AutomationOnClose({ config: normalizeV2Config({ name: "A", tone: "t" }), contactId: "ct-1", collectedVariables: {} });
    expect(mocks.activeContexts).not.toHaveBeenCalled();
    const config = normalizeV2Config({ name: "A", tone: "t", closure: { nextAutomationStepId: "step-z" } });
    await continueV2AutomationOnClose({ config, contactId: "ct-1", collectedVariables: {} });
    expect(mocks.continueFromStep).not.toHaveBeenCalled();
  });
});
