/**
 * QA determinístico do replay: o JSON do harness passa ou falha.
 * Não usa LLM. Guard disparado vira WARN com o inbound; fixture pode
 * declarar `expect.guard` (dado, não recalcular a função do runtime).
 */
export type ReplayQaTurn = {
  caseId: string;
  turnIndex: number;
  inbound: string;
  agentName: string;
  text: string;
  status: string | null;
  skipped: string | null;
  switchedTo: string | null;
  handoff?: {
    fromAgentId: string;
    toAgentId: string;
    by?: string;
  } | null;
  tools: Array<{ name: string; args?: unknown }>;
};

export type ReplayQaTurnExpect = {
  guard?: boolean;
  human?: boolean;
};

export type ReplayQaFixtureTurn =
  | string
  | { inbound: string; expect?: ReplayQaTurnExpect };

export type ReplayQaCase = {
  id: string;
  turns: ReplayQaFixtureTurn[];
};

export type QaFinding = {
  caseId: string;
  turnIndex: number;
  code:
    | "GUARD_FIRED"
    | "EMPTY_COMPLETED"
    | "RULE_SKIP"
    | "SELF_TRANSFER"
    | "INBOUND_MISMATCH"
    | "MISSING_TURN"
    | "PING_PONG";
  severity: "fail" | "warn";
  detail: string;
};

export function fixtureTurnInbound(turn: ReplayQaFixtureTurn): string {
  return typeof turn === "string" ? turn : turn.inbound;
}

export function fixtureTurnExpect(
  turn: ReplayQaFixtureTurn | undefined,
): ReplayQaTurnExpect {
  if (!turn || typeof turn === "string") return {};
  return turn.expect ?? {};
}

function looksLikeNonsenseGuard(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return (
    t.startsWith("Não entendi essa mensagem.") ||
    t.startsWith("Quando tiver um pedido objetivo")
  );
}

function selfTransfer(turn: ReplayQaTurn): boolean {
  const h = turn.handoff;
  if (!h?.fromAgentId || !h?.toAgentId) return false;
  return h.fromAgentId === h.toAgentId;
}

export function scoreReplay(
  turns: ReplayQaTurn[],
  fixtures: ReplayQaCase[],
): { findings: QaFinding[]; fail: number; warn: number } {
  const findings: QaFinding[] = [];
  const byCase = new Map<string, ReplayQaTurn[]>();
  for (const t of turns) {
    const list = byCase.get(t.caseId) ?? [];
    list.push(t);
    byCase.set(t.caseId, list);
  }

  for (const fx of fixtures) {
    const rec = (byCase.get(fx.id) ?? []).sort((a, b) => a.turnIndex - b.turnIndex);
    if (rec.length !== fx.turns.length) {
      findings.push({
        caseId: fx.id,
        turnIndex: -1,
        code: "MISSING_TURN",
        severity: "fail",
        detail: `fixture ${fx.turns.length} inbound, replay ${rec.length}`,
      });
    }
    let switches = 0;
    let prevAgent = rec[0]?.agentName ?? "";
    for (const t of rec) {
      const fxTurn = fx.turns[t.turnIndex];
      const expectedInbound =
        fxTurn != null ? fixtureTurnInbound(fxTurn) : undefined;
      const expect = fixtureTurnExpect(fxTurn);
      if (expectedInbound != null && expectedInbound !== t.inbound) {
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "INBOUND_MISMATCH",
          severity: "fail",
          detail: `esperado ${JSON.stringify(expectedInbound).slice(0, 80)}`,
        });
      }
      if (t.agentName !== prevAgent) {
        switches += 1;
        prevAgent = t.agentName;
      }
      if (t.skipped?.startsWith("rule_human") || t.skipped?.startsWith("tool_human")) {
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "RULE_SKIP",
          severity: "fail",
          detail: t.skipped,
        });
      } else if (t.skipped?.startsWith("rule_department")) {
        const desk = /atend|sac/i.test(t.skipped);
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "RULE_SKIP",
          severity: desk ? "warn" : "fail",
          detail: desk
            ? `${t.skipped} — regra de produto (Atendimento). Harness não deve abortar o ticket.`
            : t.skipped,
        });
      }
      if (
        !t.skipped &&
        t.status !== "RULE" &&
        !(t.text ?? "").trim() &&
        t.tools.length === 0
      ) {
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "EMPTY_COMPLETED",
          severity: "fail",
          detail: "COMPLETED sem texto e sem tool",
        });
      }
      if (!t.skipped && !(t.text ?? "").trim() && t.tools.length > 0) {
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "EMPTY_COMPLETED",
          severity: "warn",
          detail: "handoff/tool sem fala no mesmo turno",
        });
      }
      const guardFired = looksLikeNonsenseGuard(t.text);
      if (guardFired) {
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "GUARD_FIRED",
          severity: expect.guard === false ? "fail" : "warn",
          detail: `inbound=${JSON.stringify(t.inbound).slice(0, 80)}`,
        });
      } else if (expect.guard === true) {
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "GUARD_FIRED",
          severity: "fail",
          detail: `fixture esperava guard; inbound=${JSON.stringify(t.inbound).slice(0, 80)}`,
        });
      }
      if (selfTransfer(t)) {
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "SELF_TRANSFER",
          severity: "warn",
          detail: `${t.agentName} transfer_to_ai_agent para si`,
        });
      }
    }
    if (switches >= 3) {
      findings.push({
        caseId: fx.id,
        turnIndex: -1,
        code: "PING_PONG",
        severity: "warn",
        detail: `${switches} trocas de agente no caso`,
      });
    }
  }

  return {
    findings,
    fail: findings.filter((f) => f.severity === "fail").length,
    warn: findings.filter((f) => f.severity === "warn").length,
  };
}

export function formatQaReport(score: {
  findings: QaFinding[];
  fail: number;
  warn: number;
}): string {
  const lines = [
    "",
    "===== QA REPLAY =====",
    score.fail === 0
      ? `PASS  fail=0  warn=${score.warn}`
      : `FAIL  fail=${score.fail}  warn=${score.warn}`,
  ];
  for (const f of score.findings) {
    const t = f.turnIndex >= 0 ? ` t${f.turnIndex}` : "";
    lines.push(`${f.severity.toUpperCase()} ${f.caseId}${t} ${f.code} — ${f.detail}`);
  }
  lines.push("===== FIM QA =====");
  lines.push("");
  return lines.join("\n");
}
