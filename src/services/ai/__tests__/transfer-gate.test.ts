/**
 * Sintoma original (Julia, DEV): `unknownAnswerMode=handoff` mandava
 * transferir quando faltava base, o gate do pack academic recusava porque
 * o aluno não tinha pedido humano, e a conversa travava — o agente
 * prometia a transferência a cada turno e nunca transferia.
 */

import { describe, expect, it } from "vitest";

import {
  buildUnknownAnswerBlock,
  normalizeInboxPolicy,
} from "@/lib/ai-agents/steering";
import {
  evaluateTransferGate,
  transferBlockedByGate,
  validateUnknownAnswerAgainstGate,
} from "@/services/ai/transfer-gate";

describe("evaluateTransferGate", () => {
  it("sem pack não há gate — o agente genérico pode transferir", () => {
    const state = evaluateTransferGate({
      verticalPack: null,
      userMessage: "quanto custa o curso?",
    });
    expect(state.active).toBe(false);
    expect(state.allows).toBe(true);
  });

  it("pack academic recusa quando o cliente não pediu humano", () => {
    const state = evaluateTransferGate({
      verticalPack: "academic",
      userMessage: "Não fez ainda?",
    });
    expect(state.active).toBe(true);
    expect(state.allows).toBe(false);
    expect(transferBlockedByGate(state)).toBe(true);
  });

  it("lembra o pedido de humano feito em mensagem anterior", () => {
    const state = evaluateTransferGate({
      verticalPack: "academic",
      priorUserMessages: [
        "bom dia",
        "quero falar com um atendente",
        "obrigado",
      ],
      userMessage: "ok",
    });
    expect(state.askedForHuman).toBe(true);
    expect(state.allows).toBe(true);
    expect(transferBlockedByGate(state)).toBe(false);
  });

  it("pedido de humano na mensagem atual abre o gate", () => {
    const state = evaluateTransferGate({
      verticalPack: "academic",
      userMessage: "me passa para um consultor",
    });
    expect(state.allows).toBe(true);
  });
});

describe("buildUnknownAnswerBlock com o gate fechado", () => {
  const policy = normalizeInboxPolicy({ unknownAnswerMode: "handoff" });

  it("não instrui transferir quando o gate vai recusar", () => {
    const block = buildUnknownAnswerBlock(policy, { transferBlocked: true });
    expect(block).not.toContain("transfira para um humano");
    expect(block).toContain("NÃO transfira");
  });

  it("mantém a instrução de transferir quando o gate permite", () => {
    const block = buildUnknownAnswerBlock(policy, { transferBlocked: false });
    expect(block).toContain("transfira para um humano");
  });

  it("clarify com gate fechado também não promete transferência", () => {
    const block = buildUnknownAnswerBlock(
      normalizeInboxPolicy({ unknownAnswerMode: "clarify" }),
      { transferBlocked: true },
    );
    expect(block).not.toContain("aí sim admita e transfira");
    expect(block).toContain("NÃO transfira");
  });
});

describe("validateUnknownAnswerAgainstGate", () => {
  it("avisa quando o pack tem gate e o modo é transferir", () => {
    const warnings = validateUnknownAnswerAgainstGate({
      verticalPack: "academic",
      unknownAnswerMode: "handoff",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].field).toBe("unknownAnswerMode");
  });

  it("não avisa quando não há gate", () => {
    expect(
      validateUnknownAnswerAgainstGate({
        verticalPack: null,
        unknownAnswerMode: "handoff",
      }),
    ).toHaveLength(0);
  });

  it("não avisa quando o modo já é compatível com o gate", () => {
    expect(
      validateUnknownAnswerAgainstGate({
        verticalPack: "academic",
        unknownAnswerMode: "acknowledge",
      }),
    ).toHaveLength(0);
  });
});
