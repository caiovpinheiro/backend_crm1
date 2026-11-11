import { describe, expect, it } from "vitest";

import { pickDealSendConversation } from "@/lib/deal-send-conversation";

const cand = { id: "conv-cand", channelId: "ch-candidaturas" };
const emp = { id: "conv-emp", channelId: "ch-empresas" };

describe("pickDealSendConversation", () => {
  it("canal pedido: garante a conversa nesse canal", () => {
    expect(pickDealSendConversation({ channelId: "ch-candidaturas", active: [emp] })).toEqual({
      action: "ensure",
      channelId: "ch-candidaturas",
    });
  });

  it("sem canal: reusa a conversa aberta mais recente do contato (DNAWORK #81090)", () => {
    // Nota do n8n abria ticket novo no canal padrão (Empresas) com o
    // candidato falando no Candidaturas — ticket vazio e sem responsável.
    expect(pickDealSendConversation({ channelId: null, active: [cand, emp] })).toEqual({
      action: "reuse",
      conversationId: "conv-cand",
    });
  });

  it("sem canal e sem conversa aberta: cai no canal padrão", () => {
    expect(pickDealSendConversation({ channelId: "  ", active: [] })).toEqual({
      action: "ensure",
      channelId: null,
    });
  });

  it("ignora conversa sem canal (órfã) na reutilização", () => {
    expect(
      pickDealSendConversation({ channelId: null, active: [{ id: "orf", channelId: null }] }),
    ).toEqual({ action: "ensure", channelId: null });
  });
});
