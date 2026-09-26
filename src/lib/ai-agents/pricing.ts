/**
 * Preço estimado por modelo, em USD por 1M tokens.
 *
 * Tabela local (não consome API) usada pra:
 *  - estimar custo antes de chamar o provider
 *  - gravar `AIAgentRun.costUsd` após cada run
 *  - render do painel "Uso" na página do agente
 *
 * Atualizar quando a OpenAI mudar preços. Se um modelo não estiver
 * listado, assume fallback (gpt-4o-mini) — é seguro.
 */

import { V2_MODELS } from "@/lib/ai-v2/models";

export type ModelPricing = {
  /// USD por 1M tokens de INPUT.
  inputPer1M: number;
  /// USD por 1M tokens de OUTPUT.
  outputPer1M: number;
};

const PRICING: Record<string, ModelPricing> = {
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "text-embedding-3-small": { inputPer1M: 0.02, outputPer1M: 0 },
};

// Modelos do agente v2 (OpenAI e Anthropic) com preço de tabela.
for (const m of V2_MODELS) {
  if (!PRICING[m.id]) PRICING[m.id] = { inputPer1M: m.inputPer1M, outputPer1M: m.outputPer1M };
}

const FALLBACK = PRICING["gpt-4o-mini"];

export function getModelPricing(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK;
}

/**
 * Calcula custo estimado de uma run em USD.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getModelPricing(model);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return Number((inputCost + outputCost).toFixed(6));
}
