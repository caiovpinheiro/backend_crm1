/**
 * Desfecho do run derivado do ESTADO FINAL observado.
 *
 * Sintoma que originou isto: sete runs da Julia gravados como HANDOFF com a
 * conversa ainda atribuída a ela. O código antigo olhava só o NOME da tool
 * chamada (`result.toolCalls.some(...)`), nunca o resultado — e
 * `transfer_to_department` devolve `ok: true` só por rotear o departamento.
 * A métrica reportava transferência onde houve loop.
 *
 * Agora: só é HANDOFF_COMPLETED se a atribuição da conversa mudou de fato.
 */

import type { AIAgentRunOutcome } from "@prisma/client";

import { EFFECT_TOOLS, effectToolSucceeded } from "@/services/ai/effect-claims";

export type RunOutcome = AIAgentRunOutcome;

const TRANSFER_TOOLS = new Set([
  "transfer_to_human",
  "transfer_to_department",
  "execute_distribution",
]);

/** A tool recusou por causa do gate (mensagem vem de `academicDistributionAllowed`). */
function refusedByGate(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (r.ok !== false) return false;
  return (
    typeof r.error === "string" && r.error.startsWith("Não distribua:")
  );
}

export type OutcomeInput = {
  toolCalls: Array<{ toolName: string; result?: unknown }>;
  /// Tipo do assignee da conversa DEPOIS do turno. null = sem conversa
  /// (playground) ou sem assignee.
  finalAssigneeType?: string | null;
  /// O tool-loop parou por teto de passos ou de chamadas.
  limitReached: boolean;
  /// A recuperação não trouxe nenhum trecho relevante.
  noRetrievalContext: boolean;
};

/**
 * Ordem de precedência pensada para não esconder problema atrás de sucesso:
 * transferência confirmada > gate > falha de tool > teto > falta de base.
 */
export function deriveRunOutcome(input: OutcomeInput): RunOutcome {
  const transferLeftTheAi =
    input.finalAssigneeType !== "AI" &&
    input.toolCalls.some((c) => TRANSFER_TOOLS.has(c.toolName));
  if (transferLeftTheAi) return "HANDOFF_COMPLETED";

  if (input.toolCalls.some((c) => refusedByGate(c.result))) {
    return "HANDOFF_BLOCKED_BY_GATE";
  }

  const effectFailed = input.toolCalls.some(
    (c) =>
      EFFECT_TOOLS[c.toolName] && !effectToolSucceeded(c.toolName, c.result),
  );
  if (effectFailed) return "TOOL_FAILED";

  if (input.limitReached) return "STEP_LIMIT_REACHED";
  if (input.noRetrievalContext) return "NO_CONTEXT";
  return "ANSWERED";
}

/** `status` legado a partir do outcome — mantém os consumidores atuais. */
export function statusForOutcome(
  outcome: RunOutcome,
): "COMPLETED" | "HANDOFF" {
  return outcome === "HANDOFF_COMPLETED" ? "HANDOFF" : "COMPLETED";
}
