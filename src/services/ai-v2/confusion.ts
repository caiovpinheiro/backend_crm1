/**
 * Cliente que mostra que não entendeu ("?", "não entendi", "como assim")
 * logo depois de uma pergunta ou explicação do agente. Com "Quando não
 * souber › Cliente confuso" em "refazer" (padrão), o motor não transfere
 * por isso: refaz a última pergunta ou pede o que ficou confuso.
 * Nenhum domínio de cliente.
 */

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const CONFUSED = /^(?:nao entendi(?: nada)?|nao entendo|nao compreendi|nao ficou claro|como assim|hein|ha|que|oi)$/;

/** A mensagem inteira só mostra confusão (não traz pergunta nova). */
export function isConfusionMessage(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (/^[?¿]+$/.test(raw.replace(/\s+/g, ""))) return true;
  return CONFUSED.test(fold(raw).replace(/[?!.¿]+/g, "").trim());
}

/** Resposta que refaz a última pergunta do agente (ou pede o que ficou confuso). */
export function rephraseAfterConfusion(lastAgentMessage: string | null | undefined): string {
  const sentences = (lastAgentMessage ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const question = [...sentences].reverse().find((s) => s.endsWith("?"));
  return question
    ? `Desculpa, acho que não fui claro. ${question}`
    : "Desculpa, acho que não fui claro. O que ficou confuso? Me conta que eu explico de outro jeito.";
}

/** Linha do prompt quando o modo é refazer. */
export const CONFUSION_PROMPT =
  "Se o cliente mandar só \"?\" ou disser que não entendeu, explique de outro jeito ou refaça sua última pergunta de forma mais simples. Não transfira por isso.";
