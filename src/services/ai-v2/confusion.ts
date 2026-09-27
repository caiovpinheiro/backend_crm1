/**
 * Cliente que mostra que não entendeu ("?", "não entendi", "como assim")
 * logo depois de uma pergunta ou explicação do agente. Com "Quando não
 * souber › Cliente confuso" em "refazer" (padrão), o motor não transfere
 * por isso: refaz a última pergunta ou pede o que ficou confuso.
 * Nenhum domínio de cliente.
 */

import { systemMessage, type SystemMessages } from "@/lib/ai-v2/system-messages";

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const CONFUSED = /^(?:nao entendi(?: nada)?|nao entendo|nao compreendi|nao ficou claro|como assim|hein|ha|que|oi)$/;

/**
 * Estado de confusão dito pelo cliente: "estou confusa", "fiquei super
 * perdido no app", "não estou entendendo". Pode vir com desculpa antes.
 */
const CONFUSED_STATE =
  /^(?:(?:desculp[ae]|perdao|ai|ah|nossa)[, ]*)?(?:eu )?(?:(?:estou|to|tou|fiquei|fico|me sinto|t[oô] meio)\s+(?:meio |muito |bem |super |um pouco |totalmente )?(?:confus[ao]s?|perdid[ao]s?)(?:\s+(?:no|na|nos|nas|com|aqui|nisso|nessa|nesse)(?:\s+[a-z]+){0,3})?|nao (?:estou|to|tou) entendendo(?: nada)?)$/;

/**
 * A mensagem inteira só mostra confusão (não traz pergunta nova).
 * `includeState: false` deixa de fora "estou confusa"/"fiquei perdida"
 * (só "?", "não entendi", "como assim").
 */
export function isConfusionMessage(text: string, opts: { includeState?: boolean } = {}): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (/^[?¿]+$/.test(raw.replace(/\s+/g, ""))) return true;
  const folded = fold(raw).replace(/[?!.¿,]+/g, " ").replace(/\s+/g, " ").trim();
  if (CONFUSED.test(folded)) return true;
  return opts.includeState !== false && CONFUSED_STATE.test(folded);
}

/** Resposta que refaz a última pergunta do agente (ou pede o que ficou confuso). */
export function rephraseAfterConfusion(
  lastAgentMessage: string | null | undefined,
  config?: { systemMessages?: SystemMessages | null } | null,
): string {
  const sentences = (lastAgentMessage ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const question = [...sentences].reverse().find((s) => s.endsWith("?"));
  return question ? systemMessage(config, "confusionRephrase", { pergunta: question }) : systemMessage(config, "confusionAsk");
}

/** Linha do prompt quando o modo é refazer. */
export const CONFUSION_PROMPT =
  "Se o cliente mandar só \"?\", disser que não entendeu ou que está confuso/perdido, explique de outro jeito, mais simples e em passos curtos, ou refaça sua última pergunta. Não transfira por isso.";
