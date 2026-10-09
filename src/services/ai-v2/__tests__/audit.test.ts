import { describe, expect, it } from "vitest";

import { auditFromData, type AuditConversation, type AuditMessage, type AuditTurn } from "../audit";

const at = (s: string) => new Date(`2026-10-09T${s}:00.000Z`);

function turn(over: Partial<AuditTurn> & { conversationId: string; createdAt: Date }): AuditTurn {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-1",
    inboundText: "oi",
    reply: null,
    handoff: false,
    error: null,
    closed: null,
    executedActions: [],
    discardedActions: [],
    trace: [],
    ...over,
  };
}
function msg(over: Partial<AuditMessage> & { conversationId: string; createdAt: Date; content: string }): AuditMessage {
  return { id: `m-${Math.random().toString(36).slice(2, 8)}`, direction: "out", authorType: "bot", senderName: "Agente", messageType: "text", channelId: "ch-1", aiAgentUserId: "u-ai", isPrivate: false, ...over };
}
const conv = (id: string, over: Partial<AuditConversation> = {}): AuditConversation => ({ id, number: 1, contactId: "ct-1", contactName: "Cliente", channelId: "ch-1", createdAt: at("17:00"), closedAt: null, hasHumanReply: false, ...over });

describe("auditoria do motor — defeitos objetivos por conversa", () => {
  it("conversa limpa: índice 100", () => {
    const out = auditFromData({
      agentId: "agent-1",
      turns: [turn({ conversationId: "c1", createdAt: at("17:01"), reply: "A segunda via sai pelo portal.", trace: [{ step: "resposta", detail: 'Enviada: "A segunda via…"' }] })],
      messages: [msg({ conversationId: "c1", createdAt: at("17:01"), content: "A segunda via sai pelo portal." })],
      conversations: [conv("c1")],
    });
    expect(out.engineIndex).toBe(100);
    expect(out.items).toEqual([]);
  });

  it("transferência sem aviso (barrado como repetido) e apresentação depois de transferência", () => {
    const out = auditFromData({
      agentId: "agent-1",
      turns: [
        turn({ conversationId: "c1", createdAt: at("17:01"), handoff: true, reply: "Explico: o valor muda pela data.", trace: [{ step: "resposta", detail: 'Enviada: "Explico…"' }, { step: "resposta", detail: 'NÃO enviada (near_duplicate): "Vou te passar…"' }, { step: "transferência", detail: "Transferido para department (d1)" }] }),
        turn({ conversationId: "c2", createdAt: at("17:05"), reply: "Olá! Sou seu assistente virtual. Confirmo que estou falando com você.", trace: [{ step: "agente", detail: "Conversa recebida de outro agente de IA → este agente assume" }, { step: "entrada", detail: "Primeira mensagem só com cumprimento → boas-vindas configuradas" }] }),
      ],
      messages: [],
      conversations: [conv("c1"), conv("c2", { number: 2 })],
    });
    expect(out.byFlag.transferencia_muda).toBe(1);
    expect(out.byFlag.apresentacao_apos_transferencia).toBe(1);
    expect(out.engineIndex).toBe(0);
  });

  it("cadeia e ping-pong entre agentes (turnos de outros agentes na mesma conversa)", () => {
    const a = turn({ conversationId: "c1", createdAt: at("17:00"), agentId: "agent-0", handoff: true, trace: [{ step: "resposta", detail: 'Enviada: "Vou te passar…"' }, { step: "transferência", detail: "Transferido para ai_agent (agent-1)" }] });
    const b = turn({ conversationId: "c1", createdAt: at("17:01"), agentId: "agent-1", handoff: true, trace: [{ step: "transferência", detail: "Transferido para ai_agent (agent-0)" }, { step: "transferência", detail: "Transferência em cadeia logo após receber a conversa: o aviso do agente anterior já cobriu → sem novo aviso" }] });
    const out = auditFromData({ agentId: "agent-1", turns: [b], allTurns: [a, b], messages: [], conversations: [conv("c1")] });
    expect(out.byFlag.transferencia_em_cadeia).toBe(1);
    expect(out.byFlag.ping_pong).toBe(1);
    expect(out.byFlag.transferencia_muda).toBeUndefined();
  });

  it("resposta duplicada, pergunta repetida, fluxo em cima do agente e canal errado", () => {
    const messages = [
      msg({ conversationId: "c1", createdAt: at("17:00"), content: "A prova de setembro já passou; a próxima é em dezembro." }),
      msg({ conversationId: "c1", createdAt: at("17:01"), content: "A prova de setembro já passou, a próxima é em dezembro!" }),
      msg({ conversationId: "c1", createdAt: at("17:02"), direction: "in", authorType: "human", aiAgentUserId: null, content: "Destravar" }),
      msg({ conversationId: "c1", createdAt: at("17:03"), content: "Me conta, por favor, o que você precisa resolver?" }),
      msg({ conversationId: "c1", createdAt: at("17:04"), direction: "in", authorType: "human", aiAgentUserId: null, content: "Reativar" }),
      msg({ conversationId: "c1", createdAt: at("17:05"), content: "Me conta por favor o que você precisa resolver?" }),
      msg({ conversationId: "c1", createdAt: at("17:06"), senderName: "Aguardando Resposta", aiAgentUserId: null, content: "Essa conversa está sendo encerrada por falta de interação." }),
      msg({ conversationId: "c1", createdAt: at("17:07"), channelId: "ch-2", content: "Mensagem por outro número." }),
    ];
    const out = auditFromData({ agentId: "agent-1", turns: [turn({ conversationId: "c1", createdAt: at("17:00"), reply: "x", trace: [{ step: "resposta", detail: "Enviada: x" }] })], messages, conversations: [conv("c1")] });
    expect(out.byFlag.resposta_duplicada).toBe(1);
    expect(out.byFlag.pergunta_repetida).toBe(1);
    expect(out.byFlag.fluxo_em_cima_do_agente).toBe(1);
    expect(out.byFlag.canal_errado).toBe(1);
  });

  it("sem resposta só quando o motivo não é legítimo; IA depois de pessoa; erro no turno", () => {
    const out = auditFromData({
      agentId: "agent-1",
      turns: [
        turn({ conversationId: "c1", createdAt: at("17:01"), inboundText: "Já fiz o processo", discardedActions: [{ type: "no_reply", reason: "human owner" }] }),
        turn({ conversationId: "c2", createdAt: at("17:02"), inboundText: "Preciso de ajuda", discardedActions: [{ type: "no_reply", reason: "queued" }] }),
        turn({ conversationId: "c3", createdAt: at("17:03"), inboundText: "E a segunda via?", discardedActions: [{ type: "no_reply", reason: "superseded" }] }),
        turn({ conversationId: "c4", createdAt: at("17:04"), inboundText: "oi", error: "TypeError: boom" }),
      ],
      messages: [],
      conversations: [conv("c1"), conv("c2", { number: 2 }), conv("c3", { number: 3, contactId: "ct-3", createdAt: at("17:03") }), conv("c4", { number: 4 })],
      priorHuman: [{ contactId: "ct-3", closedAt: at("16:50"), conversationId: "c-old" }],
    });
    expect(out.byFlag.sem_resposta).toBe(1);
    expect(out.byFlag.ia_apos_pessoa).toBe(1);
    expect(out.byFlag.erro_no_turno).toBe(1);
    expect(out.items.find((i) => i.conversationId === "c3")?.findings.map((f) => f.flag).sort()).toEqual(["ia_apos_pessoa", "sem_resposta"]);
    expect(out.conversations).toBe(4);
    expect(out.withDefects).toBe(2);
    expect(out.engineIndex).toBe(50);
  });
});
