/**
 * Preço oficial dos modelos, lido da página de preços de cada provedor
 * (a API de modelos não informa preço). As duas páginas servem markdown
 * com tabelas `| modelo | $entrada | $saída | … |`:
 *  - OpenAI: tabela por id (`gpt-6.1-terra`), tarifa Standard primeiro;
 *  - Anthropic: tabela por nome (`Claude Opus 5.5`), convertido em id.
 * Funções puras (sem rede). Nenhum domínio de cliente.
 */

import type { V2ModelProvider } from "./models";

export const OFFICIAL_PRICING_URL: Record<V2ModelProvider, string> = {
  openai: "https://developers.openai.com/api/docs/pricing.md",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing.md",
};

export type OfficialPrice = { inputPer1M: number; outputPer1M: number };

/** "$1.25", "$4 / MTok", "$0.20 / MTok<sup>2</sup>" → número; "-" ou vazio → null. */
export function parseUsd(cell: string): number | null {
  const m = /\$\s*([0-9]+(?:[.,][0-9]+)?)/.exec(cell);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : null;
}

function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function isSeparator(row: string[]): boolean {
  return row.every((c) => /^:?-{2,}:?$/.test(c) || c === "");
}

type Table = { header: string[]; rows: string[][]; heading: string };

/** Tabelas markdown na ordem da página, com o último título acima de cada uma. */
export function markdownTables(md: string): Table[] {
  const out: Table[] = [];
  let heading = "";
  let current: Table | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (h) heading = h[1].trim();
    const row = cells(line);
    if (!row) {
      current = null;
      continue;
    }
    if (!current) {
      current = { header: row, rows: [], heading };
      out.push(current);
      continue;
    }
    if (isSeparator(row)) continue;
    current.rows.push(row);
  }
  return out;
}

/** Índices das colunas de entrada e saída (a primeira de cada, sem "cached"/"cache"/"write"). */
function priceColumns(header: string[]): { input: number; output: number } | null {
  const norm = header.map((h) => h.toLowerCase());
  const input = norm.findIndex((h, i) => i > 0 && /input/.test(h) && !/cache|write|hit/.test(h));
  const output = norm.findIndex((h, i) => i > 0 && /output/.test(h));
  return input > 0 && output > 0 ? { input, output } : null;
}

const SKIP_HEADING = /(batch|flex|fast|priority|realtime|audio|image|video|fine[- ]?tun|embedding|tool|search|transcri|speech|moderation|legacy|regional|data residency)/i;

/**
 * Página da OpenAI: primeira ocorrência de cada id em tabelas de texto com
 * colunas de entrada/saída (a tarifa Standard vem antes das outras). Pula
 * seções de batch, flex, áudio, imagem etc. Id com sufixo "(<272K context
 * length)" usa o preço de contexto curto.
 */
export function parseOpenAiPricing(md: string): Map<string, OfficialPrice> {
  const out = new Map<string, OfficialPrice>();
  const tables = markdownTables(md);
  // Tabelas sob "Standard pricing data"; se a página mudar o título, cai
  // na varredura geral (pulando batch, flex, fast, áudio, imagem…).
  const standard = tables.filter((t) => /standard/i.test(t.heading));
  for (const t of standard.length > 0 ? standard : tables) {
    if (SKIP_HEADING.test(t.heading)) continue;
    if (!/model/i.test(t.header[0] ?? "")) continue;
    const cols = priceColumns(t.header);
    if (!cols) continue;
    for (const r of t.rows) {
      const id = (r[0] ?? "").split("(")[0].replace(/`/g, "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9.\-]*$/.test(id) || out.has(id)) continue;
      const input = parseUsd(r[cols.input] ?? "");
      const output = parseUsd(r[cols.output] ?? "");
      if (input === null || output === null) continue;
      out.set(id, { inputPer1M: input, outputPer1M: output });
    }
  }
  return out;
}

/** "Claude Opus 5.5" → claude-opus-5-5; "Claude Haiku 5.5 (for prompts up to …)" → claude-haiku-5-5. */
export function anthropicNameToId(name: string): string | null {
  const base = name.replace(/<[^>]+>/g, "").split("(")[0].trim().toLowerCase();
  if (!/^claude\s+[a-z]+\s+\d+(\.\d+)?$/.test(base)) return null;
  return base.replace(/\s+/g, "-").replace(/\./g, "-");
}

/**
 * Página da Anthropic: tabela "Model pricing" (nome, entrada base, …, saída).
 * Linha repetida do mesmo modelo (Haiku 5.5 por tamanho de prompt): fica a
 * primeira (a de prompts menores, a usada no atendimento).
 */
export function parseAnthropicPricing(md: string): Map<string, OfficialPrice> {
  const out = new Map<string, OfficialPrice>();
  const tables = markdownTables(md);
  const main = tables.filter((t) => /^model pricing$/i.test(t.heading));
  for (const t of main.length > 0 ? main : tables) {
    if (!/model/i.test(t.header[0] ?? "")) continue;
    const norm = t.header.map((h) => h.toLowerCase());
    const input = norm.findIndex((h, i) => i > 0 && /input/.test(h) && !/cache|write|hit/.test(h));
    const output = norm.findIndex((h, i) => i > 0 && /output/.test(h));
    if (input <= 0 || output <= 0) continue;
    for (const r of t.rows) {
      const id = anthropicNameToId(r[0] ?? "");
      if (!id || out.has(id)) continue;
      const i = parseUsd(r[input] ?? "");
      const o = parseUsd(r[output] ?? "");
      if (i === null || o === null) continue;
      out.set(id, { inputPer1M: i, outputPer1M: o });
    }
    if (out.size > 0) break;
  }
  return out;
}

export function parseOfficialPricing(provider: V2ModelProvider, md: string): Map<string, OfficialPrice> {
  return provider === "openai" ? parseOpenAiPricing(md) : parseAnthropicPricing(md);
}
