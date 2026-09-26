/**
 * Réguas de similaridade como opções prontas — quem configura escolhe um
 * comportamento com nome, não um número. Os números vivem só aqui.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";

export type V2ThemeRecognitionPreset = "strict" | "balanced" | "loose";
export type V2KnowledgeSearchPreset = "all" | "related" | "close";

export type ThemeThresholds = {
  /** Similaridade mínima para escolher um assunto pelo sentido. */
  minSimilarity: number;
  /** Similaridade mínima para trocar o assunto atual por outro. */
  switchSimilarity: number;
  /** Quanto o outro assunto precisa ficar acima do atual para trocar. */
  switchMargin: number;
  /** Mensagem com menos palavras que isto mantém o assunto atual. */
  shortMessageWords: number;
};

function envSimilarity(name: string, fallback: number): number {
  const raw = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : fallback;
}

/**
 * Reconhecimento de assunto:
 *  - "strict" (rígido): só escolhe quando a mensagem é bem parecida e
 *    raramente troca de assunto no meio da conversa;
 *  - "balanced" (equilibrado, padrão): o comportamento de sempre;
 *  - "loose" (flexível): reconhece mais e troca com mais facilidade.
 */
export function themeThresholdsFor(preset: V2ThemeRecognitionPreset | undefined): ThemeThresholds {
  switch (preset) {
    case "strict":
      return { minSimilarity: 0.5, switchSimilarity: 0.6, switchMargin: 0.08, shortMessageWords: 3 };
    case "loose":
      return { minSimilarity: 0.35, switchSimilarity: 0.45, switchMargin: 0.03, shortMessageWords: 2 };
    default:
      return {
        minSimilarity: envSimilarity("AI_V2_THEME_MIN_SIMILARITY", 0.4),
        switchSimilarity: envSimilarity("AI_V2_THEME_SWITCH_SIMILARITY", 0.5),
        switchMargin: 0.05,
        shortMessageWords: 2,
      };
  }
}

/**
 * Trechos dos materiais que vão ao modelo:
 *  - "all" (padrão): todos os encontrados;
 *  - "related": corta os pouco parecidos com a pergunta;
 *  - "close": só os muito parecidos.
 */
export function knowledgeMinSimilarity(config: Pick<V2AgentConfig, "knowledgeSearch">): number {
  switch (config.knowledgeSearch?.preset) {
    case "related":
      return 0.45;
    case "close":
      return 0.55;
    default:
      return 0;
  }
}
