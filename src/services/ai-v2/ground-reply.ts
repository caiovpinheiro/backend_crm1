/**
 * Checagens da resposta contra as fontes (nomes, valores, palpites,
 * repetição). Nenhum assunto ou documento de cliente aqui.
 */

const GREETINGS = new Set([
  "oi", "ola", "bom", "dia", "boa", "tarde", "noite",
  "ok", "sim", "nao", "obrigado", "obrigada", "valeu",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ");
}

export function hasSearchableQuestion(message: string): boolean {
  return normalize(message)
    .split(/\s+/)
    .some((word) => word.length >= 4 && !GREETINGS.has(word));
}

export function knowledgeChunkTexts(
  toolCalls: Array<{ toolName: string; result: unknown }> | undefined,
): string[] {
  const texts: string[] = [];
  for (const call of toolCalls ?? []) {
    if (call.toolName !== "knowledge_search") continue;
    const result = call.result as { chunks?: unknown } | undefined;
    if (!result || !Array.isArray(result.chunks)) continue;
    for (const chunk of result.chunks) {
      if (!chunk || typeof chunk !== "object") continue;
      const content = (chunk as { content?: unknown }).content;
      if (typeof content === "string" && content.trim()) texts.push(content.trim());
    }
  }
  return texts;
}

/**
 * Nomes citados entre aspas na resposta (menu, botão, tela, opção) que não
 * aparecem em nenhuma fonte (material, instruções, conversa). É onde o
 * modelo mais inventa ao completar um passo a passo: "vá em \"Fale Conosco\"".
 */
export function unsupportedQuotedTerms(reply: string, sources: string[]): string[] {
  const haystack = ` ${normalize(sources.join(" ")).replace(/\s+/g, " ")} `;
  const lines = sourceLines(sources);
  const out = new Set<string>();
  for (const m of reply.matchAll(/["“”]([^"“”\n]{2,60})["“”]/g)) {
    const term = m[1].trim();
    const norm = normalize(term).replace(/\s+/g, " ").trim();
    if (!norm || !/[a-z]/.test(norm)) continue;
    if (haystack.includes(` ${norm} `)) continue;
    if (sameLineVariant(norm, lines)) continue;
    out.add(term);
  }
  return [...out];
}

const FILLER = new Set(["para", "como", "com", "uma", "que", "sua", "seu", "minha", "meu", "pelo", "pela", "esta", "este", "voce", "aqui"]);

function sourceLines(sources: string[]): string[][] {
  return sources
    .flatMap((s) => s.split(/\n+/))
    .map((line) => normalize(line).split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

/**
 * Mesmo nome escrito de outro jeito: todas as palavras principais do termo
 * (radical de 5 letras) numa mesma linha da fonte. Exigir o texto idêntico
 * transferia o cliente por "Esqueci a senha" quando o material diz
 * "Esqueci minha senha".
 */
function sameLineVariant(norm: string, lines: string[][]): boolean {
  const stems = norm.split(" ").filter((w) => w.length >= 4 && !FILLER.has(w)).map((w) => w.slice(0, 5));
  if (stems.length === 0) return false;
  return lines.some((words) => stems.every((stem) => words.some((w) => w.startsWith(stem))));
}

const HEDGES = ["geralmente", "normalmente", "costuma", "costumam", "em geral", "provavelmente", "possivelmente"];

/**
 * Palpite: "geralmente é pela opção X", "normalmente no valor da
 * mensalidade". Quando a palavra não vem da fonte, o modelo está
 * completando o que não sabe.
 */
export function unsupportedHedges(reply: string, sources: string[]): string[] {
  const text = ` ${normalize(reply).replace(/\s+/g, " ")} `;
  const haystack = ` ${normalize(sources.join(" ")).replace(/\s+/g, " ")} `;
  return HEDGES.filter((h) => text.includes(` ${h} `) && !haystack.includes(` ${h} `));
}

/**
 * Percentual e valor em dinheiro na resposta que não aparecem em nenhuma
 * fonte. O modelo completava com "juros de 1% ao mês", "R$ 50 de taxa".
 */
export function unsupportedFigures(reply: string, sources: string[]): string[] {
  const squash = (s: string) => s.replace(/\s+/g, "").replace(/\.(?=\d{3}\b)/g, "").toLowerCase();
  const haystack = squash(sources.join(" "));
  const out = new Set<string>();
  const patterns = [/\d+(?:[.,]\d+)?\s?%/g, /R\$\s?\d[\d.]*(?:,\d{1,2})?/gi];
  for (const re of patterns) {
    for (const m of reply.matchAll(re)) {
      // "R$ 50." no fim da frase: o ponto é da frase, não do valor.
      const token = m[0].trim().replace(/[.,;:!?]+$/, "");
      if (!haystack.includes(squash(token))) out.add(token);
    }
  }
  return [...out];
}

function tokensOf(s: string): string[] {
  return normalize(s).split(/\s+/).filter((w) => w.length > 1);
}

/** Resposta quase igual à anterior (o envio a barraria e o cliente ficaria sem nada). */
export function isNearDuplicateReply(a: string, b: string): boolean {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return false;
  if (ta.join(" ") === tb.join(" ")) return true;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.85;
}
