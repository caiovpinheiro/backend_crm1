/**
 * Escolha de assunto pelo SIGNIFICADO da mensagem.
 *
 * A seleção por gatilhos (`selectV2Theme`) compara palavras: só acerta
 * quando o cliente usa um termo cadastrado. Aqui cada assunto vira um
 * vetor (nome + gatilhos + exemplos + começo das instruções) e a mensagem
 * é comparada por similaridade — "preciso de um comprovante de X" chega
 * perto de um assunto descrito como "emitir documento de X" sem ninguém
 * cadastrar o sinônimo.
 *
 * Gatilhos continuam valendo primeiro (sinal explícito do operador); o
 * significado entra quando nenhum gatilho casou.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Theme } from "@/lib/ai-v2/types";
import { embedTexts } from "@/services/ai/provider";
import { matchV2Theme, selectV2Theme } from "./themes";

/** Mesma régua da busca na base: similaridade de cosseno >= 0,4. */
/**
 * Para TROCAR o assunto atual da conversa por outro, pelo significado: o
 * outro precisa passar deste mínimo e ficar SWITCH_MARGIN acima do atual.
 * Um acompanhamento ("a nota não apareceu") empatava com outro assunto e a
 * conversa pulava de assunto por 0,05 de diferença.
 */
function switchSimilarity(): number {
  const raw = Number.parseFloat(process.env.AI_V2_THEME_SWITCH_SIMILARITY ?? "");
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.5;
}
const SWITCH_MARGIN = 0.05;

function minSimilarity(): number {
  const raw = Number.parseFloat(process.env.AI_V2_THEME_MIN_SIMILARITY ?? "");
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.4;
}

/** Texto que representa o assunto no espaço de embeddings. */
export function themeEmbeddingText(theme: V2Theme): string {
  const parts = [
    theme.name,
    (theme.when ?? []).join(", "),
    (theme.examples ?? []).join(" | "),
    (theme.instructions ?? "").slice(0, 300),
  ];
  return parts.map((p) => p.trim()).filter(Boolean).join("\n");
}

// Vetor por texto do assunto: muda só quando a config publicada muda.
const themeVectorCache = new Map<string, number[]>();
const MAX_CACHE = 500;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function themeVectors(themes: V2Theme[], apiKey: string): Promise<number[][]> {
  const texts = themes.map(themeEmbeddingText);
  const missing = [...new Set(texts.filter((t) => !themeVectorCache.has(t)))];
  if (missing.length > 0) {
    const { embeddings } = await embedTexts(missing, apiKey);
    if (themeVectorCache.size + missing.length > MAX_CACHE) themeVectorCache.clear();
    missing.forEach((t, i) => themeVectorCache.set(t, embeddings[i]));
  }
  return texts.map((t) => themeVectorCache.get(t) ?? []);
}

function contentWordCount(text: string): number {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4).length;
}

export type V2ThemeSelection = {
  theme: V2Theme | null;
  method: "trigger" | "semantic" | "kept" | "none";
  similarity?: number;
};

/**
 * Ordem: gatilho casado na mensagem > assunto mais próximo em significado
 * (acima do mínimo) > assunto atual da conversa. Falha de embedding não
 * derruba o turno — cai no assunto atual (ou nenhum), como antes.
 */
export async function selectV2ThemeSemantic(args: {
  config: V2AgentConfig;
  message: string;
  currentThemeId?: string;
  apiKey: string | null;
}): Promise<V2ThemeSelection> {
  // Sem o assunto atual: `selectV2Theme` o mantém sempre que nenhum outro
  // gatilho casa, o que impediria o significado de trocar de assunto.
  const byTrigger = selectV2Theme(args.config, args.message);
  const themes = args.config.themes ?? [];
  if (byTrigger) {
    // Palavra solta da lista ("empresa") levava "a empresa pediu um
    // comprovante" para o assunto que tinha essa palavra no gatilho. Com frase de verdade, confere
    // o sentido: se outro assunto é claramente mais próximo, ele vence.
    if (!args.apiKey || contentWordCount(args.message) < 4) return { theme: byTrigger, method: "trigger" };
    try {
      const [{ embeddings }, vectors] = await Promise.all([embedTexts([args.message.trim()], args.apiKey), themeVectors(themes, args.apiKey)]);
      const mv = embeddings[0] ?? [];
      let best: V2Theme | null = null;
      let bestSim = -1;
      let triggerSim = -1;
      themes.forEach((t, i) => {
        const sim = cosine(mv, vectors[i] ?? []);
        if (t.id === byTrigger.id) triggerSim = sim;
        if (sim > bestSim) {
          bestSim = sim;
          best = t;
        }
      });
      if (best && (best as V2Theme).id !== byTrigger.id && bestSim >= switchSimilarity() && bestSim >= triggerSim + 0.08) {
        return { theme: best, method: "semantic", similarity: bestSim };
      }
    } catch (err) {
      console.warn("[ai-v2] conferência semântica do gatilho falhou:", err instanceof Error ? err.message : err);
    }
    return { theme: byTrigger, method: "trigger" };
  }

  const current = args.currentThemeId ? themes.find((t) => t.id === args.currentThemeId) ?? null : null;
  const fallback = (similarity?: number): V2ThemeSelection =>
    current ? { theme: current, method: "kept", similarity } : { theme: null, method: "none", similarity };

  const text = args.message.trim();
  if (themes.length === 0 || !text || !args.apiKey) return fallback();
  // Acompanhamento curto ("ok", "consegue me enviar?") continua no assunto
  // da conversa; pouco texto dá similaridade instável.
  if (current && contentWordCount(text) < 3) return fallback();

  try {
    const [{ embeddings }, vectors] = await Promise.all([
      embedTexts([text], args.apiKey),
      themeVectors(themes, args.apiKey),
    ]);
    const messageVector = embeddings[0] ?? [];
    let best: V2Theme | null = null;
    let bestSim = -1;
    let currentSim = -1;
    themes.forEach((theme, i) => {
      const sim = cosine(messageVector, vectors[i] ?? []);
      if (current && theme.id === current.id) currentSim = sim;
      if (sim > bestSim) {
        bestSim = sim;
        best = theme;
      }
    });
    const switching = !!current && best !== null && (best as V2Theme).id !== current.id;
    if (switching && (bestSim < switchSimilarity() || bestSim < currentSim + SWITCH_MARGIN)) {
      return fallback(bestSim);
    }
    if (best && bestSim >= minSimilarity()) {
      return { theme: best, method: "semantic", similarity: bestSim };
    }
    return fallback(bestSim);
  } catch (err) {
    console.warn("[ai-v2] seleção semântica de assunto falhou:", err instanceof Error ? err.message : err);
    return fallback();
  }
}

export type V2ThemeRecognition = {
  selection: V2ThemeSelection;
  /** Todos os assuntos, do mais provável ao menos. */
  ranking: Array<{ id: string; name: string; matched: string[]; similarity: number | null }>;
  minSimilarity: number;
};

/**
 * "Testar reconhecimento": qual assunto uma primeira mensagem pegaria, e por
 * quê (palavras que casaram e proximidade de sentido de cada assunto).
 * Usa a mesma escolha do atendimento, sem assunto anterior.
 */
export async function explainV2ThemeRecognition(args: {
  config: V2AgentConfig;
  message: string;
  apiKey: string | null;
}): Promise<V2ThemeRecognition> {
  const themes = args.config.themes ?? [];
  const selection = await selectV2ThemeSemantic({ config: args.config, message: args.message, apiKey: args.apiKey });
  let sims: number[] | null = null;
  if (args.apiKey && themes.length > 0 && args.message.trim()) {
    try {
      const [{ embeddings }, vectors] = await Promise.all([embedTexts([args.message.trim()], args.apiKey), themeVectors(themes, args.apiKey)]);
      sims = themes.map((_, i) => cosine(embeddings[0] ?? [], vectors[i] ?? []));
    } catch (err) {
      console.warn("[ai-v2] similaridade dos assuntos falhou:", err instanceof Error ? err.message : err);
    }
  }
  const ranking = themes
    .map((t, i) => {
      const m = matchV2Theme(t, args.message);
      return { id: t.id, name: t.name, matched: m.matched, score: m.score, similarity: sims ? sims[i] : null };
    })
    .sort((a, b) => {
      if (a.id === selection.theme?.id) return -1;
      if (b.id === selection.theme?.id) return 1;
      return b.score - a.score || (b.similarity ?? 0) - (a.similarity ?? 0);
    })
    .map(({ score: _score, ...rest }) => rest);
  return { selection, ranking, minSimilarity: minSimilarity() };
}

/** Limpa o cache (testes). */
export function clearThemeVectorCache(): void {
  themeVectorCache.clear();
}
