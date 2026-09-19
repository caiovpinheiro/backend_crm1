import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { aIAgentRun: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

import {
  loadConversationPeerHistory,
  peerAlreadyAttended,
} from "@/services/ai/conversation-peers";
import { RETRIEVAL_SESSION_GAP_MS } from "@/services/ai/retrieval-query";

function run(minutesAgo: number, agentId: string, name: string) {
  return {
    agentId,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
    agent: { user: { name } },
  };
}

beforeEach(() => {
  findMany.mockReset();
});

describe("quem já atendeu a conversa", () => {
  // O caso do print: Retenção mandou para Atendimento, o contato repetiu
  // "quero cancelar" e o escopo casou com Retenção de novo.
  it("reconhece o agente que já atendeu neste atendimento", async () => {
    findMany.mockResolvedValue([
      run(1, "cfg-atendimento", "Atendimento"),
      run(3, "cfg-retencao", "Retenção"),
    ]);

    const history = await loadConversationPeerHistory("conv-1");

    expect(peerAlreadyAttended(history, { id: "cfg-retencao" })).toBe(true);
    expect(peerAlreadyAttended(history, { name: "Retenção" })).toBe(true);
    expect(peerAlreadyAttended(history, { name: "Financeiro" })).toBe(false);
  });

  it("casa o nome sem depender de acento ou caixa", async () => {
    findMany.mockResolvedValue([run(1, "cfg-retencao", "Retenção")]);
    const history = await loadConversationPeerHistory("conv-1");
    expect(peerAlreadyAttended(history, { name: "RETENCAO" })).toBe(true);
  });

  // Sem o recorte, um contato de meses ficaria sem nenhum destino válido.
  it("meia hora de silêncio começa um atendimento novo", async () => {
    const gapMinutes = RETRIEVAL_SESSION_GAP_MS / 60_000;
    findMany.mockResolvedValue([
      run(1, "cfg-atendimento", "Atendimento"),
      run(2 + gapMinutes, "cfg-retencao", "Retenção"),
    ]);

    const history = await loadConversationPeerHistory("conv-1");

    expect(peerAlreadyAttended(history, { id: "cfg-atendimento" })).toBe(true);
    expect(peerAlreadyAttended(history, { id: "cfg-retencao" })).toBe(false);
  });

  it("sem conversa não consulta o banco", async () => {
    const history = await loadConversationPeerHistory(null);
    expect(history.agentIds.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
