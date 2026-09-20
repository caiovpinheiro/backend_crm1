/**
 * Detecção de humor do cliente (SPEC 3.20).
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Sentiment } from "@/lib/ai-v2/types";

const ANGRY_WORDS = [
  "idiota", "burro", "inútil", "merda", "porra", "caralho", "desgraça", "inferno",
  "péssimo", "horrível", "terrível", "nojo", "ódio", "raiva", "puto", "puta", "revoltado",
];

const DISSATISFIED_WORDS = [
  "ruim", "péssimo", "horrível", "terrível", "decepcionado", "frustrado", "insatisfeito",
  "problema", "erro", "falha", "demora", "lento", "não resolveu", "não funciona",
  "quero cancelar", "quero reclamar", "reclamação", "cancelar",
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ");
}

function scoreWords(message: string, words: string[]): number {
  const nm = normalize(message);
  return words.reduce((acc, w) => (nm.includes(normalize(w)) ? acc + 1 : acc), 0);
}

export function detectV2Sentiment(
  config: V2AgentConfig,
  message: string,
): V2Sentiment {
  if (!config.sentiment.enabled) return "neutral";
  const angryScore = scoreWords(message, ANGRY_WORDS);
  const dissatisfiedScore = scoreWords(message, DISSATISFIED_WORDS);

  if (angryScore > 0) return "angry";
  if (dissatisfiedScore > 0) return "dissatisfied";
  return "neutral";
}

export function shouldActOnSentiment(config: V2AgentConfig, sentiment: V2Sentiment): boolean {
  if (!config.sentiment.enabled) return false;
  const threshold = config.sentiment.threshold;
  if (threshold === "any") return sentiment !== "neutral";
  if (threshold === "dissatisfied") return sentiment === "dissatisfied" || sentiment === "angry";
  if (threshold === "angry") return sentiment === "angry";
  return false;
}
