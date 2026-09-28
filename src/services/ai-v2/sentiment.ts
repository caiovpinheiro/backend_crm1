/**
 * Detecção de humor do cliente (SPEC 3.20).
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Sentiment } from "@/lib/ai-v2/types";

const ANGRY_WORDS = [
  "idiota", "burro", "inútil", "merda", "porra", "caralho", "desgraça", "inferno",
  "péssimo", "horrível", "terrível", "nojo", "ódio", "raiva", "puto", "puta", "revoltado",
];

// Pedido de cancelamento é assunto, não humor: "quero cancelar" transferia
// quem só pedia informação. "Demora" sozinha também ("quanto tempo demora a
// entrega?"); vale a queixa ("está demorando", "que demora").
const DISSATISFIED_WORDS = [
  "ruim", "péssimo", "horrível", "terrível", "decepcionado", "decepcionada", "frustrado", "frustrada",
  "insatisfeito", "insatisfeita", "problema", "erro", "falha", "lento", "não resolveu", "não resolve",
  "não funciona", "quero reclamar", "reclamação", "demorando", "que demora", "muita demora",
  "demorou muito", "demora demais", "absurdo", "descaso",
];

/** "Sem problema", "nenhum problema": o cliente diz que está tudo bem. */
const NOT_A_COMPLAINT = /\b(?:sem|nenhum|nao tem|nao ha|nao teve) problemas?\b/g;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Palavra ou expressão inteira: por trecho, "computador" contava como
 * xingamento e "cancelaria" como reclamação.
 */
function scoreWords(message: string, words: string[]): number {
  const nm = ` ${normalize(message).replace(NOT_A_COMPLAINT, " ")} `;
  return words.reduce((acc, w) => (nm.includes(` ${normalize(w)} `) ? acc + 1 : acc), 0);
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
