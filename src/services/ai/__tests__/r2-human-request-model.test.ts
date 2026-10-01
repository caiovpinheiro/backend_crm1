/**
 * R2 — pedido de humano julgado pelo modelo, não só por keyword.
 *
 * As variações que motivaram o item ("me passa pra alguém", "quero uma
 * pessoa de verdade", "tem gente aí?") não casam com lista de termos
 * nenhuma. Com o gate fechado, o contato pedia atendimento humano e o
 * agente ficava girando. Agora a tool pode afirmar o pedido.
 */

import { describe, expect, it } from "vitest";

import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { evaluateTransferGate } from "@/services/ai/transfer-gate";
import { userWantsHumanDistribution } from "@/services/ai/human-queue-policy";

const policy = normalizeInboxPolicy(
  { transferPolicy: "on_request_or_topic" },
  "academic",
);

const SEM_KEYWORD = [
  "me passa pra alguém",
  "quero uma pessoa de verdade",
  "tem gente aí?",
];

describe("R2 gate de transferência", () => {
  it("as variações do fixture não casam com keyword nenhuma", () => {
    for (const msg of SEM_KEYWORD) {
      expect(userWantsHumanDistribution(msg, { humanRequestKeywords: [] })).toBe(
        false,
      );
    }
  });

  it("gate fechado sem keyword e sem afirmação do modelo", () => {
    for (const msg of SEM_KEYWORD) {
      const state = evaluateTransferGate({
        verticalPack: "academic",
        userMessage: msg,
        inboxPolicy: policy,
      });
      expect(state.allows).toBe(false);
      expect(state.matchedBy).toBeNull();
    }
  });

  it("aceita com userExplicitlyAsked e marca model_assertion", () => {
    for (const msg of SEM_KEYWORD) {
      const state = evaluateTransferGate({
        verticalPack: "academic",
        userMessage: msg,
        inboxPolicy: policy,
        userExplicitlyAsked: true,
      });
      expect(state.allows).toBe(true);
      expect(state.askedForHuman).toBe(true);
      expect(state.matchedBy).toBe("model_assertion");
    }
  });

  it("keyword continua valendo e tem precedência no matchedBy", () => {
    const state = evaluateTransferGate({
      verticalPack: "academic",
      userMessage: "quero falar com um atendente",
      inboxPolicy: policy,
      userExplicitlyAsked: true,
    });
    expect(state.allows).toBe(true);
    expect(state.matchedBy).toBe("keyword");
  });

  it("userExplicitlyAsked falso não abre o gate", () => {
    const state = evaluateTransferGate({
      verticalPack: "academic",
      userMessage: "qual o horário da secretaria?",
      inboxPolicy: policy,
      userExplicitlyAsked: false,
    });
    expect(state.allows).toBe(false);
    expect(state.matchedBy).toBeNull();
  });

  it("keywords vêm da configuração: termo da org entra, recusa continua fora", () => {
    const orgPolicy = normalizeInboxPolicy(
      {
        transferPolicy: "on_request_or_topic",
        humanRequestKeywords: ["quero um ser humano de carne e osso"],
      },
      null,
    );
    expect(
      evaluateTransferGate({
        userMessage: "quero um ser humano de carne e osso",
        inboxPolicy: { ...orgPolicy, transferPolicy: "on_request_or_topic" },
      }).matchedBy,
    ).toBe("keyword");

    expect(
      userWantsHumanDistribution("não quero falar com atendente", {
        humanRequestKeywords: [],
      }),
    ).toBe(false);
  });
});
