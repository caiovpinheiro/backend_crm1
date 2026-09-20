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

function scoreTheme(theme: V2Theme, message: string): number {
  const nm = normalize(message);
  const words = nm.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const phrase of theme.when) {
    const np = normalize(phrase);
    if (!np) continue;
    if (nm.includes(np)) score += 2;
    else if (np.split(/\s+/).every((w) => words.some((hw) => hw.includes(w) || w.includes(hw)))) score += 1;
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
      const bestScore = config.themes.reduce((max, t) => Math.max(max, scoreTheme(t, message)), 0);
      // Só muda se outro tema tiver score maior com margem.
      if (currentScore > 0 || bestScore < 2) return current;
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
