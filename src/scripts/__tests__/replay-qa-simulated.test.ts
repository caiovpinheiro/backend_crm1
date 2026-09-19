/**
 * QA com distribuição simulada (sandbox do `--real-handoff`).
 *
 * No sandbox ninguém é atribuído de verdade — a distribuição só resolve
 * quem receberia. Se o QA exigisse atribuição real, os três casos r2 (o
 * pedido de humano sem keyword que motivou o R2) apareceriam como
 * HUMAN_REQUEST_IGNORED e o replay em sandbox ficaria inutilizável.
 */

import { describe, expect, it } from "vitest";

import lote2 from "@/scripts/fixtures/joseph-replay-lote2.json";
import {
  fixtureTurnInbound,
  scoreReplay,
  type ReplayQaCase,
  type ReplayQaTurn,
} from "@/scripts/replay-qa";

const r2Cases = (lote2 as { cases: ReplayQaCase[] }).cases.filter((c) =>
  c.id.startsWith("r2-"),
);

function turn(
  c: ReplayQaCase,
  turnIndex: number,
  extra: Partial<ReplayQaTurn> = {},
): ReplayQaTurn {
  return {
    caseId: c.id,
    turnIndex,
    inbound: fixtureTurnInbound(c.turns[turnIndex]!),
    agentName: "Agente Atendimento",
    text: "Oi! Como posso ajudar?",
    status: "COMPLETED",
    skipped: null,
    switchedTo: null,
    tools: [],
    ...extra,
  };
}

/** Turno em que a tool distribuiu: no sandbox, resolvido e não atribuído. */
function humanTurn(c: ReplayQaCase, simulated: boolean): ReplayQaTurn {
  return turn(c, 1, {
    text: "Já estou te conectando com a equipe.",
    tools: [{ name: "execute_distribution", args: {} }],
    distribution: {
      assignedTo: "Consultora Ana",
      departmentName: "Atendimento",
      simulated,
    },
  });
}

describe("QA com distribuição simulada", () => {
  it("as três fixtures r2 passam com distribuição apenas simulada", () => {
    const turns = r2Cases.flatMap((c) => [turn(c, 0), humanTurn(c, true)]);
    const score = scoreReplay(turns, r2Cases);
    expect(
      score.findings.filter((f) => f.code === "HUMAN_REQUEST_IGNORED"),
    ).toEqual([]);
    expect(score.fail).toBe(0);
  });

  it("registra o operador e o departamento que SERIAM escolhidos", () => {
    const t = humanTurn(r2Cases[0]!, true);
    expect(t.distribution).toEqual({
      assignedTo: "Consultora Ana",
      departmentName: "Atendimento",
      simulated: true,
    });
  });

  it("mesmo resultado com distribuição real: simulated não muda o veredito", () => {
    const turns = r2Cases.flatMap((c) => [turn(c, 0), humanTurn(c, false)]);
    expect(scoreReplay(turns, r2Cases).fail).toBe(0);
  });

  it("sem distribuição nenhuma o QA continua acusando o pedido ignorado", () => {
    const turns = r2Cases.flatMap((c) => [turn(c, 0), turn(c, 1)]);
    const score = scoreReplay(turns, r2Cases);
    expect(
      score.findings.filter((f) => f.code === "HUMAN_REQUEST_IGNORED"),
    ).toHaveLength(r2Cases.length);
  });

  it("recusa do assign em sandbox não vira erro de turno", () => {
    // `deals.ts` devolve cluster vazio em vez de lançar; o turno segue
    // COMPLETED e a distribuição resolvida é o que conta para o QA.
    const turns = r2Cases.flatMap((c) => [
      turn(c, 0),
      { ...humanTurn(c, true), status: "COMPLETED", skipped: null },
    ]);
    const score = scoreReplay(turns, r2Cases);
    expect(score.findings.map((f) => f.code)).not.toContain("EMPTY_COMPLETED");
    expect(score.fail).toBe(0);
  });
});
