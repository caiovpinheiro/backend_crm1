export type V2ResponseBehavior = "objective" | "balanced" | "natural" | "creative";

export interface V2ResponseBehaviorPreset {
  key: V2ResponseBehavior;
  temperature: number;
  label: string;
  description: string;
}

export const V2_RESPONSE_BEHAVIOR_PRESETS: V2ResponseBehaviorPreset[] = [
  {
    key: "objective",
    temperature: 0.2,
    label: "Mais objetivo",
    description: "Respostas diretas, consistentes e sem muita variação.",
  },
  {
    key: "balanced",
    temperature: 0.4,
    label: "Equilibrado",
    description: "Respostas naturais, mantendo consistência e objetividade.",
  },
  {
    key: "natural",
    temperature: 0.6,
    label: "Mais natural",
    description: "Conversa mais espontânea, com maior variedade na forma de responder.",
  },
  {
    key: "creative",
    temperature: 0.8,
    label: "Mais criativo",
    description: "Respostas mais variadas e flexíveis, com maior liberdade na comunicação.",
  },
];

export function behaviorToTemperature(behavior: string): number {
  const preset = V2_RESPONSE_BEHAVIOR_PRESETS.find((p) => p.key === behavior);
  return preset?.temperature ?? 0.4;
}

export function temperatureToBehavior(temperature: number | null | undefined): V2ResponseBehavior {
  if (temperature == null) return "balanced";
  const closest = V2_RESPONSE_BEHAVIOR_PRESETS.reduce((best, preset) => {
    return Math.abs(preset.temperature - temperature) < Math.abs(best.temperature - temperature)
      ? preset
      : best;
  });
  // Se não casar exatamente, mantém behavior legado? Aqui usamos o mais próximo.
  return closest.key;
}
