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

import {
  EFFECT_TOOLS,
  effectToolSucceeded,
  isSimulatedEffectResult,
} from "@/services/ai/effect-claims";

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

/**
 * A distribuição rodou e o pedido ficou em fila: `distribution_pending`
 * PENDING com `NO_ELIGIBLE_RESPONSIBLE` / `NO_DEPARTMENT`, que as tools de
 * transferência já devolvem como `queuedWaiting`. A conversa volta para a IA
 * (`inbox-handler`), então nunca virava HANDOFF_COMPLETED — e caía em
 * ANSWERED ou TOOL_FAILED, escondendo a única transferência real.
 */
function transferQueuedWaiting(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (r.ok === false) return false;
  return r.queuedWaiting === true;
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
  /// Texto final que o chamador vai (tentar) entregar. Quando informado,
  /// texto vazio nunca vira ANSWERED. `undefined` = não observado.
  responseText?: string | null;
  /// A resposta foi barrada antes de sair (guardrail de efeito, dedupe,
  /// autorização perdida, falha de envio).
  responseDiscarded?: boolean;
};

/**
 * Ordem de precedência pensada para não esconder problema atrás de sucesso:
 * transferência confirmada > fila > gate > falha de tool > teto >
 * resposta não entregue > falta de base.
 */
export function deriveRunOutcome(input: OutcomeInput): RunOutcome {
  const transferLeftTheAi =
    input.finalAssigneeType !== "AI" &&
    input.toolCalls.some((c) => TRANSFER_TOOLS.has(c.toolName));
  if (transferLeftTheAi) return "HANDOFF_COMPLETED";

  const queued = input.toolCalls.some(
    (c) => TRANSFER_TOOLS.has(c.toolName) && transferQueuedWaiting(c.result),
  );
  if (queued) return "HANDOFF_QUEUED";

  if (input.toolCalls.some((c) => refusedByGate(c.result))) {
    return "HANDOFF_BLOCKED_BY_GATE";
  }

  // Chamada simulada (modo de teste) não é tool que falhou: ela foi
  // deliberadamente não executada. Sem esta exceção todo run de teste sairia
  // como TOOL_FAILED e o desfecho gravado seria mentira.
  const effectFailed = input.toolCalls.some(
    (c) =>
      EFFECT_TOOLS[c.toolName] &&
      !isSimulatedEffectResult(c.result) &&
      !effectToolSucceeded(c.toolName, c.result),
  );
  if (effectFailed) return "TOOL_FAILED";

  if (input.limitReached) return "STEP_LIMIT_REACHED";

  // ANSWERED exigia apenas "não deu erro". Um run com responsePreview cheio e
  // nenhuma outbound ficava como respondido.
  if (input.responseDiscarded) return "RESPONSE_DISCARDED";
  if (typeof input.responseText === "string" && !input.responseText.trim()) {
    return "RESPONSE_DISCARDED";
  }

  if (input.noRetrievalContext) return "NO_CONTEXT";
  return "ANSWERED";
}

/** `status` legado a partir do outcome — mantém os consumidores atuais. */
export function statusForOutcome(
  outcome: RunOutcome,
): "COMPLETED" | "HANDOFF" {
  return outcome === "HANDOFF_COMPLETED" || outcome === "HANDOFF_QUEUED"
    ? "HANDOFF"
    : "COMPLETED";
}
