/**
 * Gatilho "Conversa encerrada" (`conversation_tabulated`) × quem encerrou
 * (`data.closedBy`): pessoa sempre casa (comportamento antigo); IA só com
 * `includeAiCloses` ou a chave da org; automação só com
 * `includeAutomationCloses`.
 */
import { describe, expect, it } from "vitest";

import { evaluateTrigger } from "@/services/automations";

const ctx = (data: Record<string, unknown>) => ({ event: "conversation_tabulated", data }) as const;
const base = { conversationId: "c1", departmentId: "fin", tabulationId: null, ancestorIds: [] };

describe("evaluateTrigger — conversation_tabulated × closedBy", () => {
  it("sem closedBy (pessoa) casa como antes", () => {
    expect(evaluateTrigger("conversation_tabulated", {}, ctx(base))).toBe(true);
    expect(evaluateTrigger("conversation_tabulated", {}, ctx({ ...base, closedBy: "user" }))).toBe(true);
  });

  it("IA: não casa sem opção nem chave da org", () => {
    expect(evaluateTrigger("conversation_tabulated", {}, ctx({ ...base, closedBy: "ai" }))).toBe(false);
  });

  it("IA: casa com a opção do fluxo ou com a chave da org", () => {
    expect(
      evaluateTrigger("conversation_tabulated", { includeAiCloses: true }, ctx({ ...base, closedBy: "ai" })),
    ).toBe(true);
    expect(
      evaluateTrigger(
        "conversation_tabulated",
        {},
        ctx({ ...base, closedBy: "ai", aiCloseFlowsEnabled: true }),
      ),
    ).toBe(true);
  });

  it("automação: só com includeAutomationCloses", () => {
    expect(evaluateTrigger("conversation_tabulated", {}, ctx({ ...base, closedBy: "automation" }))).toBe(false);
    expect(
      evaluateTrigger(
        "conversation_tabulated",
        { includeAutomationCloses: true },
        ctx({ ...base, closedBy: "automation" }),
      ),
    ).toBe(true);
  });

  it("filtros de departamento e tabulação continuam valendo", () => {
    expect(
      evaluateTrigger(
        "conversation_tabulated",
        { includeAiCloses: true, departmentId: "vendas" },
        ctx({ ...base, closedBy: "ai" }),
      ),
    ).toBe(false);
    expect(
      evaluateTrigger(
        "conversation_tabulated",
        { includeAiCloses: true, tabulationId: "pai" },
        ctx({ ...base, closedBy: "ai", tabulationId: "folha", ancestorIds: ["pai"] }),
      ),
    ).toBe(true);
  });
});
