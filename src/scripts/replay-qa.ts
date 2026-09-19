/**
 * QA determinístico do replay: o JSON do harness passa ou falha.
 * Não usa LLM. Se este relatório passar e o operador ainda vir ASK em
 * "Financeiro", o deploy não inclui o código — não é "parece ok no log".
 */
import {
  NONSENSE_ASK_ONCE,
  NONSENSE_STOP,
  isIdleOrchestrationMessage,
  nonsenseGuardReply,
} from "@/services/ai/transfer-gate";

export type ReplayQaTurn = {
  caseId: string;
  turnIndex: number;
  inbound: string;
  agentName: string;
  text: string;
  status: string | null;
  skipped: string | null;
  switchedTo: string | null;
  tools: Array<{ name: string; args?: unknown }>;
};

export type ReplayQaCase = { id: string; turns: string[] };

export type QaFinding = {
  caseId: string;
  turnIndex: number;
  code:
    | "FALSE_NONSENSE"
    | "EMPTY_COMPLETED"
    | "RULE_SKIP"
    | "SELF_TRANSFER"
    | "INBOUND_MISMATCH"
    | "MISSING_TURN"
    | "PING_PONG";
  severity: "fail" | "warn";
  detail: string;
};

function foldName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function isCannedNonsense(text: string): boolean {
  const t = (text ?? "").trim();
  return t === NONSENSE_ASK_ONCE || t === NONSENSE_STOP || t.startsWith("Não entendi essa mensagem.") || t.startsWith("Quando tiver um pedido objetivo");
}

function toolDestName(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  return String(a.name ?? a.agentName ?? a.agentUserId ?? "").trim();
}

function selfTransfer(turn: ReplayQaTurn): boolean {
  const me = foldName(turn.agentName);
  if (turn.switchedTo && foldName(turn.switchedTo) === me) return true;
  return turn.tools.some((t) => {
    if (t.name !== "transfer_to_ai_agent" && t.name !== "transfer_conversation") {
      return false;
    }
    const dest = foldName(toolDestName(t.args));
    return dest.length > 0 && dest === me;
  });
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
    const priors: string[] = [];
    let switches = 0;
    let prevAgent = rec[0]?.agentName ?? "";
    for (const t of rec) {
      const expected = fx.turns[t.turnIndex];
      if (expected != null && expected !== t.inbound) {
        findings.push({
          caseId: t.caseId,
          turnIndex: t.turnIndex,
          code: "INBOUND_MISMATCH",
          severity: "fail",
          detail: `esperado ${JSON.stringify(expected).slice(0, 80)}`,
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
      if (isCannedNonsense(t.text)) {
        const allowed = nonsenseGuardReply(t.inbound, priors);
        if (!allowed) {
          findings.push({
            caseId: t.caseId,
            turnIndex: t.turnIndex,
            code: "FALSE_NONSENSE",
            severity: "fail",
            detail: isIdleOrchestrationMessage(t.inbound)
              ? "saudação/ack tratada como lixo"
              : `ASK/STOP em pedido real: ${t.inbound.slice(0, 80)}`,
          });
        }
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
      priors.push(t.inbound);
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
