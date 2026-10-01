import { describe, expect, it } from "vitest";

import {
  aiAgentDestinationGate,
  excludeSelfFromAgentNames,
  formatAiHandoffDestinations,
  SELF_AI_HANDOFF_ERROR,
  selfAiDestinationError,
} from "@/services/ai/agent-handoff";
import { buildToolSet } from "@/services/ai/tools";

const SELF = "Agente Atendimento";
const PEERS = ["Joseph", "Agente Acolhi", "Agente Retenção"];

describe("P0-B auto-transferência", () => {
  it("exclui o agente atual da lista de destinos", () => {
    expect(excludeSelfFromAgentNames([...PEERS, SELF], SELF)).toEqual(PEERS);
    expect(excludeSelfFromAgentNames(["agente atendimento"], SELF)).toEqual([]);
  });

  it("nameGate bloqueia destino == self mesmo com lista vazia (tudo liberado)", () => {
    const err = aiAgentDestinationGate({
      allowedAgentNames: [],
      name: SELF,
      fromAgentName: SELF,
    });
    expect(err).toBeTruthy();
    expect(err).toMatch(/bloqueado/i);
  });

  it("nameGate permite um peer", () => {
    expect(
      aiAgentDestinationGate({
        allowedAgentNames: PEERS,
        name: "Joseph",
        fromAgentName: SELF,
      }),
    ).toBeNull();
  });

  it("toolset de especialista não lista a si mesmo como destino", () => {
    const set = buildToolSet(
      {
        agentUserId: "user-atendimento",
        agentName: SELF,
        peerAiAgentNames: PEERS,
      },
      ["transfer_to_ai_agent", "transfer_conversation"],
    );
    const aiDesc = String(set.transfer_to_ai_agent.description ?? "");
    const convDesc = String(set.transfer_conversation.description ?? "");
    expect(aiDesc).toContain("Joseph");
    expect(aiDesc).toContain("Agente Acolhi");
    expect(aiDesc).not.toContain(SELF);
    expect(convDesc).not.toContain(SELF);
    expect(formatAiHandoffDestinations(PEERS)).toContain("Joseph");
    expect(formatAiHandoffDestinations(PEERS)).not.toContain(SELF);
  });

  it("execute com destino == self falha sem reatribuir", async () => {
    const set = buildToolSet(
      {
        agentUserId: "user-atendimento",
        agentName: SELF,
        peerAiAgentNames: PEERS,
      },
      ["transfer_to_ai_agent", "transfer_conversation"],
    );
    const ai = await set.transfer_to_ai_agent.execute!(
      { agentName: SELF, reason: "loop" },
      { toolCallId: "t1", messages: [] },
    );
    expect(ai).toMatchObject({
      ok: false,
      reason: "self_transfer",
      error: SELF_AI_HANDOFF_ERROR,
    });

    const conv = await set.transfer_conversation.execute!(
      { target: "ai_agent", name: SELF },
      { toolCallId: "t2", messages: [] },
    );
    expect(conv).toMatchObject({
      ok: false,
      reason: "self_transfer",
    });
  });

  it("selfAiDestinationError casa nome e id", () => {
    expect(
      selfAiDestinationError({
        wanted: SELF,
        selfName: SELF,
        selfUserId: "u1",
      }),
    ).toBe(SELF_AI_HANDOFF_ERROR);
    expect(
      selfAiDestinationError({
        wanted: "Joseph",
        selfName: SELF,
        selfUserId: "u1",
        destUserId: "u1",
      }),
    ).toBe(SELF_AI_HANDOFF_ERROR);
    expect(
      selfAiDestinationError({
        wanted: "Joseph",
        selfName: SELF,
        selfUserId: "u1",
        destUserId: "u2",
      }),
    ).toBeNull();
  });
});
