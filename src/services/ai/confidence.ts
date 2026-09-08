/**
 * Confiança auto-declarada pelo LLM (paridade DataCrazy).
 * Marcador oculto: [CONFIANCA:X.X] — removido antes do envio ao aluno.
 *
 * Handoff runtime no antigo: confidence < 0.40.
 * CONFIDENCE_THRESHOLD config (0.5) era só referência de prompt.
 */

export const AI_CONFIDENCE_HANDOFF_THRESHOLD = 0.4;

/** @deprecated Prefer buildHumanUnavailableOfferMessage() — mantido só por imports. */
export const LOW_CONFIDENCE_HANDOFF_MESSAGE =
  "Combinado — já pedi para a equipe te atender. Assim que um(a) consultor(a) puder, continua com você por aqui. Enquanto isso, se quiser tirar alguma dúvida, *estou aqui* contigo 💛";

const CONFIDENCE_RE =
  /\[CONFIANCA\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*\]/gi;

/**
 * Índice de trecho da base (`[1]`, `[2][3]`) que o modelo às vezes copia do
 * bloco de referências para a resposta. É numeração interna do retrieval —
 * no WhatsApp do aluno não significa nada. Só casa colchete com dígitos, para
 * não comer `[1]` de uma citação legítima com texto dentro.
 */
const SOURCE_MARKER_RE = /\s*\[\d{1,2}\](?=\s|$|[.,;:!?])/g;

export type ParsedAgentConfidence = {
  /** Texto sem os marcadores internos (e sem linhas vazias extras no fim). */
  text: string;
  /** Score 0–1, ou null se o modelo não enviou o marcador. */
  confidence: number | null;
};

export function parseAgentConfidence(raw: string): ParsedAgentConfidence {
  let confidence: number | null = null;
  let text = raw ?? "";
  const matches = [...text.matchAll(CONFIDENCE_RE)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const n = Number.parseFloat(last[1] ?? "");
    if (Number.isFinite(n)) {
      confidence = Math.max(0, Math.min(1, n));
    }
  }
  text = text
    .replace(CONFIDENCE_RE, "")
    .replace(SOURCE_MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, confidence };
}

/**
 * true = deve handoff automático (baixa confiança explícita).
 * Sem marcador: não força handoff (evita falso positivo se o modelo esquecer).
 */
export function shouldHandoffOnLowConfidence(
  confidence: number | null,
  threshold: number = AI_CONFIDENCE_HANDOFF_THRESHOLD,
): boolean {
  if (confidence === null) return false;
  return confidence < threshold;
}
