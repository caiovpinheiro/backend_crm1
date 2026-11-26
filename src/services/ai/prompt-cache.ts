/**
 * Separa, no prompt de sistema, a parte estável (tom, regras, guias — igual
 * em todo turno do agente) da parte do turno (data, cliente, trechos). Quem
 * monta o prompt põe este marcador entre as duas.
 *
 * Claude: a parte estável vai num bloco com `cache_control` (cache de prompt
 * da Anthropic, 5 min) — as regras deixam de ser relidas inteiras a cada
 * turno. Abaixo do mínimo de tokens do modelo a API só não guarda; não dá
 * erro. Outros modelos: o marcador some (a OpenAI guarda o prefixo sozinha,
 * e o prefixo estável no começo ajuda também). `AI_ANTHROPIC_PROMPT_CACHE=0`
 * desliga.
 */
export const SYSTEM_CACHE_BREAK = "\n\n\u2063\n\n";

/** Prompt de sistema sem o marcador (para log e para quem não usa cache). */
export function stripSystemCacheBreak(system: string): string {
  return system.split(SYSTEM_CACHE_BREAK).join("\n\n");
}
