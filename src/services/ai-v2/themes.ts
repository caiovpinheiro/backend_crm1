/**
 * Seleção de tema ativo para o turno v2.
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Theme } from "@/lib/ai-v2/types";

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ");
}

/**
 * Mesma palavra com outra flexão ("cadastro"/"cadastrei",
 * "renovação"/"renovar"): prefixo comum de 5+ letras cobrindo 70% da
 * palavra menor. Só substring não bastava — "cadastrei" não contém
 * "cadastro" e o assunto não era escolhido.
 */
/** Finais que só mudam número ou gênero (sem acento: "ões" vira "oes"). */
const PLURAL_GENDER_ENDINGS = new Set(["s", "es", "a", "o", "as", "os", "is", "ns", "oes", "aes"]);

export function sameWordStem(a: string, b: string): boolean {
  if (a === b) return true;
  // Plural/gênero: uma é a outra + final de plural ou gênero. Só por
  // prefixo — "estar dentro" fazia "um" casar "documento". E só esses
  // finais: com "+ até 3 letras quaisquer", "está" (esta) casava "estágio"
  // (esta + gio) e a mensagem ia para um assunto sem relação com ela.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short) && PLURAL_GENDER_ENDINGS.has(long.slice(short.length))) return true;
  const shorter = short.length;
  if (shorter < 5) return false;
  let i = 0;
  while (i < shorter && a[i] === b[i]) i += 1;
  return i >= 5 && i >= shorter * 0.7;
}

const NEGATION_WORDS = new Set(["nao", "n", "nunca", "nem", "sem", "jamais", "tampouco"]);

/** A palavra na posição `i` vem logo depois de uma negação ("que não é cancelar", "não quero cancelar"). */
function negatedAt(words: string[], i: number): boolean {
  return words.slice(Math.max(0, i - 3), i).some((w) => NEGATION_WORDS.has(w));
}

/**
 * O gatilho aparece na mensagem só negado: "que não é cancelar", "não quero
 * cancelar". A frase diz o contrário do assunto — o gatilho não casa e o
 * sentido/modelo decidem. Com a palavra também afirmada em outro ponto,
 * casa normalmente.
 */
export function triggerOnlyNegated(words: string[], phraseWords: string[]): boolean {
  const anchor = phraseWords.find((w) => w.length > 2) ?? phraseWords[0];
  if (!anchor) return false;
  const positions = words.map((w, i) => (sameWordStem(w, anchor) ? i : -1)).filter((i) => i >= 0);
  return positions.length > 0 && positions.every((i) => negatedAt(words, i));
}

/** Pontos do assunto para a mensagem e o que casou (palavras e exemplos). */
export function matchV2Theme(theme: V2Theme, message: string): { score: number; matched: string[] } {
  const nm = normalize(message);
  const words = nm.split(/\s+/).filter(Boolean);
  let score = 0;
  const matched: string[] = [];
  for (const phrase of theme.when) {
    const np = normalize(phrase);
    if (!np) continue;
    const phraseWords = np.split(/\s+/).filter(Boolean);
    // Palavras de 1-2 letras ("de", "a") não identificam assunto.
    const keyWords = phraseWords.filter((w) => w.length > 2);
    if (
      ` ${words.join(" ")} `.includes(` ${phraseWords.join(" ")} `) ||
      (keyWords.length > 0 && keyWords.every((w) => words.some((hw) => sameWordStem(hw, w))))
    ) {
      if (triggerOnlyNegated(words, phraseWords)) continue;
      score += 2 + phraseWords.length;
      matched.push(phrase);
    }
  }
  for (const example of theme.examples) {
    const ne = normalize(example);
    if (ne && nm.includes(ne)) {
      score += 1;
      matched.push(example);
    }
  }
  return { score, matched };
}

function scoreTheme(theme: V2Theme, message: string): number {
  return matchV2Theme(theme, message).score;
}

export function selectV2Theme(
  config: V2AgentConfig,
  message: string,
  currentThemeId?: string,
): V2Theme | null {
  if (config.themes.length === 0) return null;

  // Se o tema atual já foi definido e a mensagem não indica mudança, mantém.
  if (currentThemeId) {
    const current = config.themes.find((t) => t.id === currentThemeId);
    if (current) {
      const currentScore = scoreTheme(current, message);
      const bestOther = config.themes.reduce((max, t) => {
        if (t.id === current.id) return max;
        return Math.max(max, scoreTheme(t, message));
      }, 0);
      // Mantém o assunto atual. Troca quando outro casa melhor e passa do mínimo.
      if (bestOther < 2 || bestOther <= currentScore) return current;
    }
  }

  // Empate: vence o gatilho mais específico (mais letras casadas) — antes
  // vencia a ordem da lista ("desmarcar a consulta" caía em "Marcar").
  let best: V2Theme | null = null;
  let bestScore = 0;
  let bestLength = 0;
  for (const theme of config.themes) {
    const m = matchV2Theme(theme, message);
    const length = m.matched.reduce((n, t) => n + t.length, 0);
    if (m.score > bestScore || (m.score > 0 && m.score === bestScore && length > bestLength)) {
      bestScore = m.score;
      bestLength = length;
      best = theme;
    }
  }
  return bestScore >= 1 ? best : null;
}

/**
 * Materiais consultáveis no turno: os do assunto ativo SOMADOS aos globais.
 * Antes a lista do assunto substituía a global: ao escolher um assunto
 * com lista própria, o agente perdia os materiais globais — muitas vezes
 * justamente o que respondia a pergunta. A tela descreve a lista global
 * como válida "em qualquer assunto".
 */
export function knowledgeDocIdsFor(config: V2AgentConfig, theme: V2Theme | null | undefined): string[] {
  const ids = [
    ...(theme?.allowedKnowledgeDocIds ?? []),
    ...(theme?.knowledgeDocIds ?? []),
    ...(config.allowedKnowledgeDocIds ?? []),
  ];
  return [...new Set(ids.filter(Boolean))];
}

export function getV2ThemeById(config: V2AgentConfig, themeId?: string): V2Theme | null {
  if (!themeId) return null;
  return config.themes.find((t) => t.id === themeId) ?? null;
}
