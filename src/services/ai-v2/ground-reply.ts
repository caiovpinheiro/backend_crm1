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

/** A decisão do modelo diz que o material não traz o procedimento pedido. */
const ADMITS_NO_PROCEDURE =
  /\bn[aã]o (?:informa|traz|descreve|detalha|explica|mostra|cont[eé]m|tem|apresenta)\b[^.]{0,40}?\b(?:procedimento|passo|caminho|como)\b|\bsem (?:procedimento|passo a passo|orienta[cç][aã]o)\b/i;
/** Instrução de como fazer algo (verbo de ação no imperativo). */
const INSTRUCTION = /\b(?:selecione|clique|acesse|escolha|inclua|anexe|toque|preencha|abra|digite|localize|v[aá] (?:em|at[eé]|para))\b/i;

/**
 * Passo a passo que o próprio modelo admite não estar no material: a
 * decisão diz "a base não informa o procedimento" e a resposta, mesmo
 * assim, manda selecionar, clicar, anexar. É procedimento montado a partir
 * de outro serviço ou do que aparece numa imagem.
 */
export function procedureAdmittedMissing(reply: string, reason: string | undefined): boolean {
  return !!reason && ADMITS_NO_PROCEDURE.test(reason) && INSTRUCTION.test(reply);
}

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

/** Data, período, valor, percentual ou quantidade na frase. */
const FACT_IN_SENTENCE = /\d{1,2}\s*\/\s*\d{1,2}|\b\d{1,2}(?:\s*(?:a|e|até)\s*\d{1,2})?\s+de\s+[a-zç]{3,}|R\$\s?\d|\d+(?:[.,]\d+)?\s?%|\b\d+\s*(?:dias?|horas?|meses|semanas?|pontos?)\b/i;

/**
 * Nome que só o cliente usou (não está em nenhuma fonte nem nos dados dele)
 * e que a resposta trata como coisa real, ligando-o a data, valor ou prazo:
 * "a prova de <nome> será de 6 a 9/11". A mensagem do cliente não é fonte
 * de fato — sem esta checagem, qualquer nome inventado pelo cliente passava.
 * Nome = palavra com inicial maiúscula no meio da frase da resposta.
 */
export function clientNamesBoundToFacts(reply: string, clientTexts: string[], factSources: string[]): string[] {
  const factWords = new Set(normalize(factSources.join(" ")).split(/\s+/).filter((w) => w.length >= 4));
  const factStems = new Set([...factWords].map((w) => w.slice(0, 6)));
  const clientOnly = new Set(
    normalize(clientTexts.join(" "))
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !FILLER.has(w) && !factWords.has(w) && !factStems.has(w.slice(0, 6))),
  );
  if (clientOnly.size === 0) return [];
  const out = new Set<string>();
  for (const sentence of reply.split(/(?<=[.!?])\s+|\n+/)) {
    if (!FACT_IN_SENTENCE.test(sentence)) continue;
    const words = sentence.trim().split(/\s+/);
    words.forEach((raw, i) => {
      const word = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (i === 0 || !/^\p{Lu}/u.test(word)) return;
      if (clientOnly.has(normalize(word).trim())) out.add(word);
    });
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
