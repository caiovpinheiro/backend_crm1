/**
 * Abstração de “comportamento das respostas” sobre o valor técnico de
 * `temperature` do LLM.
 *
 * A UI trabalha com presets (objective, balanced, natural, creative). O
 * banco pode armazenar tanto o preset (`responseBehavior`) quanto o valor
 * técnico (`temperature`), garantindo compatibilidade com agentes legados.
 */

export const AGENT_RESPONSE_BEHAVIOR_PRESETS = {
  objective: {
    temperature: 0.2,
    label: "Mais objetivo",
    description: "Respostas diretas, consistentes e sem muita variação.",
  },
  balanced: {
    temperature: 0.4,
    label: "Equilibrado",
    description: "Respostas naturais, mantendo consistência e objetividade.",
  },
  natural: {
    temperature: 0.6,
    label: "Mais natural",
    description: "Conversa mais espontânea, com maior variedade na forma de responder.",
  },
  creative: {
    temperature: 0.8,
    label: "Mais criativo",
    description: "Respostas mais variadas e flexíveis, com maior liberdade na comunicação.",
  },
} as const;

export type AgentResponseBehavior = keyof typeof AGENT_RESPONSE_BEHAVIOR_PRESETS;

const PRESET_TEMPERATURES = Object.entries(AGENT_RESPONSE_BEHAVIOR_PRESETS).map(
  ([id, p]) => ({ id: id as AgentResponseBehavior, temperature: p.temperature }),
);

export function isAgentResponseBehavior(value: string): value is AgentResponseBehavior {
  return Object.prototype.hasOwnProperty.call(AGENT_RESPONSE_BEHAVIOR_PRESETS, value);
}

export function behaviorToTemperature(behavior: AgentResponseBehavior): number {
  return AGENT_RESPONSE_BEHAVIOR_PRESETS[behavior].temperature;
}

/**
 * Converte uma temperatura numérica legada no behavior mais próximo.
 * Em empate (ex.: 0.5), escolhe o preset mais objetivo/menor temperatura
 * para evitar surpreender o usuário com comportamento mais criativo.
 */
export function temperatureToBehavior(temperature: number): AgentResponseBehavior {
  let best: AgentResponseBehavior = "balanced";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const { id, temperature: t } of PRESET_TEMPERATURES) {
    const diff = Math.abs(temperature - t);
    if (diff < bestDiff || (diff === bestDiff && t < behaviorToTemperature(best))) {
      best = id;
      bestDiff = diff;
    }
  }
  return best;
}

export function normalizeResponseBehavior(
  behavior: string | null | undefined,
  fallbackTemperature?: number | null,
): AgentResponseBehavior {
  if (behavior && isAgentResponseBehavior(behavior)) return behavior;
  if (fallbackTemperature != null && Number.isFinite(fallbackTemperature)) {
    return temperatureToBehavior(fallbackTemperature);
  }
  return "balanced";
}

export function resolveAgentTemperature(
  behavior: string | null | undefined,
  legacyTemperature?: number | null,
): number {
  if (behavior && isAgentResponseBehavior(behavior)) {
    return behaviorToTemperature(behavior);
  }
  if (legacyTemperature != null && Number.isFinite(legacyTemperature)) {
    return legacyTemperature;
  }
  return behaviorToTemperature("balanced");
}
