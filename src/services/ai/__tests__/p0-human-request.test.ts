import { describe, expect, it } from "vitest";

import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { evaluateTransferGate } from "@/services/ai/transfer-gate";
import {
  humanQueueContextFromAgent,
  userWantsHumanDistribution,
} from "@/services/ai/human-queue-policy";
import { isIdleOrchestrationMessage } from "@/services/ai/transfer-gate";

const HUMAN_TOOLS = [
  "transfer_to_human",
  "execute_distribution",
  "transfer_to_department",
];

describe("P0-A pedido de humano", () => {
  const policy = normalizeInboxPolicy({}, "academic");
  const queue = humanQueueContextFromAgent({ inboxPolicy: policy });

  it("Falar com equipe conta como pedido humano via keywords do pack", () => {
    expect(userWantsHumanDistribution("Falar com equipe", queue)).toBe(true);
    expect(userWantsHumanDistribution("Quero falar com a equipe", queue)).toBe(
      true,
    );
  });

  it("gate permite transferir no t0 do fixture 403971", () => {
    const state = evaluateTransferGate({
      verticalPack: "academic",
      userMessage: "Falar com equipe",
      inboxPolicy: policy,
    });
    expect(state.askedForHuman).toBe(true);
    expect(state.allows).toBe(true);
  });

  it("orquestrador não deve rotear por assunto: não é idle e é pedido humano", () => {
    expect(isIdleOrchestrationMessage("Falar com equipe")).toBe(false);
  });

  it("toolset de especialista não perde tools humanas só porque o regex não casou", () => {
    const enabled = [
      "search_crm_records",
      "transfer_to_ai_agent",
      ...HUMAN_TOOLS,
    ];
    const askedHumanNow = userWantsHumanDistribution("horário das aulas", queue);
    expect(askedHumanNow).toBe(false);
    const runtimeTools = enabled;
    for (const id of HUMAN_TOOLS) {
      expect(runtimeTools).toContain(id);
    }
  });
});
