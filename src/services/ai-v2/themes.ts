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
 * Mesma palavra com outra flexão ("matrícula"/"matriculei",
 * "declaração"/"declarar"): prefixo comum de 5+ letras cobrindo 70% da
 * palavra menor. Só substring não bastava — "matriculei" não contém
 * "matricula" e o assunto não era escolhido.
 */
function sameWordStem(a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 5) return false;
  let i = 0;
  while (i < shorter && a[i] === b[i]) i += 1;
  return i >= 5 && i >= shorter * 0.7;
}

function scoreTheme(theme: V2Theme, message: string): number {
  const nm = normalize(message);
  const words = nm.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const phrase of theme.when) {
    const np = normalize(phrase);
    if (!np) continue;
    const phraseWords = np.split(/\s+/).filter(Boolean);
    if (nm.includes(np)) score += 2 + phraseWords.length;
    else if (phraseWords.every((w) => words.some((hw) => sameWordStem(hw, w)))) score += 2 + phraseWords.length;
  }
  for (const example of theme.examples) {
    const ne = normalize(example);
    if (ne && nm.includes(ne)) score += 1;
  }
  return score;
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

  let best: V2Theme | null = null;
  let bestScore = 0;
  for (const theme of config.themes) {
    const s = scoreTheme(theme, message);
    if (s > bestScore) {
      bestScore = s;
      best = theme;
    }
  }
  return bestScore >= 1 ? best : null;
}

export function getV2ThemeById(config: V2AgentConfig, themeId?: string): V2Theme | null {
  if (!themeId) return null;
  return config.themes.find((t) => t.id === themeId) ?? null;
}
