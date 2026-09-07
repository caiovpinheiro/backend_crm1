/**
 * Sintoma original (Julia, DEV): `execute_distribution` devolveu
 * `assigned: false` e o texto enviado ao aluno afirmou "já iniciei a conexão
 * com um consultor do Atendimento". Sete runs seguidos prometeram
 * transferência sem transferir.
 */

import { describe, expect, it } from "vitest";

import {
  auditEffectClaims,
  effectToolSucceeded,
} from "@/services/ai/effect-claims";

describe("effectToolSucceeded", () => {
  it("execute_distribution com ok mas sem atribuição não é sucesso", () => {
    expect(
      effectToolSucceeded("execute_distribution", {
        ok: true,
        assigned: false,
        reason: "NO_ELIGIBLE_RESPONSIBLE",
      }),
    ).toBe(false);
  });

  it("execute_distribution com atribuição é sucesso", () => {
    expect(
      effectToolSucceeded("execute_distribution", {
        ok: true,
        assigned: true,
        assignedTo: "Ana",
      }),
    ).toBe(true);
  });

  it("transfer_to_department só roteia — não satisfaz promessa de transferência", () => {
    expect(
      effectToolSucceeded("transfer_to_department", {
        ok: true,
        departmentId: "d1",
        departmentName: "Atendimento",
      }),
    ).toBe(false);
  });

  it("fila real conta: o handoff rodou e a conversa saiu da IA", () => {
    expect(
      effectToolSucceeded("transfer_to_human", {
        ok: true,
        transferred: true,
        assigned: false,
        queuedWaiting: true,
      }),
    ).toBe(true);
  });

  it("tool que falhou nunca conta", () => {
    expect(
      effectToolSucceeded("transfer_to_human", { ok: false, error: "gate" }),
    ).toBe(false);
    expect(effectToolSucceeded("create_deal", null)).toBe(false);
  });
});

describe("auditEffectClaims", () => {
  it("bloqueia a promessa de transferência quando a distribuição falhou", () => {
    const audit = auditEffectClaims({
      text: "Marcelo, já iniciei a conexão com um consultor do Atendimento para te ajudar.",
      toolCalls: [
        {
          toolName: "execute_distribution",
          result: { ok: true, assigned: false, reason: "NO_ELIGIBLE_RESPONSIBLE" },
        },
      ],
    });
    expect(audit.blocked).toBe(true);
    expect(audit.unsupported).toContain("transfer");
  });

  it("bloqueia quando o modelo promete transferir sem chamar tool nenhuma", () => {
    const audit = auditEffectClaims({
      text: "Vou te transferir para um consultor agora mesmo.",
      toolCalls: [],
    });
    expect(audit.blocked).toBe(true);
  });

  it("libera quando a transferência realmente aconteceu", () => {
    const audit = auditEffectClaims({
      text: "Já te passei para um consultor, ele continua daqui.",
      toolCalls: [
        {
          toolName: "transfer_to_human",
          result: { ok: true, transferred: true, assigned: true, assignedTo: "Ana" },
        },
      ],
    });
    expect(audit.blocked).toBe(false);
    expect(audit.achieved).toContain("transfer");
  });

  it("caso real de 14:51 — transfer_to_department ok + execute_distribution recusado", () => {
    const audit = auditEffectClaims({
      text: "Marcelo, já iniciei a conexão com um consultor do Atendimento para te ajudar.",
      toolCalls: [
        {
          toolName: "transfer_to_department",
          result: { ok: true, departmentId: "d1", departmentName: "Atendimento - SAC" },
        },
        {
          toolName: "execute_distribution",
          result: {
            ok: false,
            error:
              "Não distribua: o contato não pediu humano e o tema ainda é atendimento da IA. Responda a dúvida.",
          },
        },
      ],
    });
    expect(audit.blocked).toBe(true);
    expect(audit.achieved).toHaveLength(0);
  });

  it("resposta comum sem promessa de efeito passa direto", () => {
    const audit = auditEffectClaims({
      text: "Para acessar o Portal do Aluno, use seu RGM como usuário e a data de nascimento como senha.",
      toolCalls: [],
    });
    expect(audit.blocked).toBe(false);
    expect(audit.unsupported).toHaveLength(0);
  });

  it("bloqueia encerramento anunciado sem close_conversation bem-sucedido", () => {
    const audit = auditEffectClaims({
      text: "OK, vou encerrar o atendimento por aqui.",
      toolCalls: [
        { toolName: "close_conversation", result: { ok: false, error: "NOT_AI_ASSIGNEE" } },
      ],
    });
    expect(audit.blocked).toBe(true);
    expect(audit.unsupported).toContain("conversation_closed");
  });
});
