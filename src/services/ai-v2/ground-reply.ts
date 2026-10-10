/**
 * Checagens da resposta contra as fontes (nomes, valores, palpites,
 * repetição). Nenhum assunto ou documento de cliente aqui.
 */

import { systemMessage, type SystemMessages } from "@/lib/ai-v2/system-messages";

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
 * Resultado das consultas do modelo que não são a base (produtos, registros
 * do CRM, mensagens prontas): vale como fonte. Sem isso, o preço que veio da
 * busca de produtos era tratado como invenção e o cliente era transferido.
 */
export function lookupResultTexts(
  toolCalls: Array<{ toolName: string; result: unknown }> | undefined,
): string[] {
  const texts: string[] = [];
  const leaves = (v: unknown, out: string[], depth: number) => {
    if (depth > 6 || out.length > 400) return;
    if (typeof v === "string") {
      if (v.trim()) out.push(v.trim());
    } else if (typeof v === "number") {
      out.push(String(v));
    } else if (Array.isArray(v)) {
      for (const x of v) leaves(x, out, depth + 1);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) leaves(x, out, depth + 1);
    }
  };
  for (const call of toolCalls ?? []) {
    if (call.toolName === "knowledge_search") continue;
    const result = call.result;
    if (!result || typeof result !== "object" || "error" in (result as Record<string, unknown>)) continue;
    const out: string[] = [];
    leaves(result, out, 0);
    if (out.length > 0) texts.push(out.join(" · ").slice(0, 8000));
  }
  return texts;
}

/**
 * Nomes citados entre aspas na resposta (menu, botão, tela, opção) que não
 * aparecem em nenhuma fonte (material, instruções, conversa). É onde o
 * modelo mais inventa ao completar um passo a passo: "vá em \"Fale Conosco\"".
 */
export function unsupportedQuotedTerms(reply: string, sources: string[], variantSources: string[] = sources): string[] {
  const haystack = ` ${normalize(sources.join(" ")).replace(/\s+/g, " ")} `;
  const lines = sourceLines(variantSources);
  const out = new Set<string>();
  for (const m of reply.matchAll(/["“”]([^"“”\n]{2,60})["“”]/g)) {
    const term = m[1].trim();
    if (!termSupported(term, haystack, lines)) out.add(term);
  }
  return [...out];
}

/** Nome igual numa fonte, ou variante nas fontes de fato (`lines`). */
function termSupported(term: string, haystack: string, lines: string[][]): boolean {
  const norm = normalize(term).replace(/\s+/g, " ").trim();
  if (!norm || !/[a-z]/.test(norm)) return true;
  if (haystack.includes(` ${norm} `)) return true;
  return sameLineVariant(norm, lines);
}

const PATH_VERB = /^(?:\d+[.)]\s*)?(?:acesse|abra|v[aá] (?:em|at[eé]|para)|entre em|clique em|toque em|selecione|escolha)\s+(?:(?:o|a|os|as|no|na|em)\s+)?/i;

/**
 * Caminho de tela sem aspas ("Configurações > Integrações > Planilhas"):
 * cada parte com inicial maiúscula precisa estar nas fontes, como os nomes
 * entre aspas. Antes só o que vinha entre aspas era conferido.
 */
export function unsupportedMenuPaths(reply: string, sources: string[], variantSources: string[] = sources): string[] {
  const haystack = ` ${normalize(sources.join(" ")).replace(/\s+/g, " ")} `;
  const lines = sourceLines(variantSources);
  const out = new Set<string>();
  for (const line of reply.split(/\n+/)) {
    if (!/\S\s*[>→»]\s*\S/.test(line)) continue;
    const parts = line.split(/\s*[>→»]\s*/);
    parts.forEach((raw, i) => {
      let part = raw.replace(/["“”*_]/g, "").trim();
      // Primeira parte: tira o verbo ("Acesse o app e toque em Minha conta" → "Minha conta").
      if (i === 0) part = part.split(/\s+(?:em|no|na)\s+/i).pop()!.replace(PATH_VERB, "");
      part = part.replace(/[.,;:!?)]+$/, "").trim();
      const words = part.split(/\s+/).filter(Boolean);
      if (words.length === 0 || words.length > 5 || !/^\p{Lu}/u.test(part)) return;
      if (!termSupported(part, haystack, lines)) out.add(part);
    });
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
  // Radical de 6 letras: com 5, "Configurações" passava por "confirme".
  const stems = norm.split(" ").filter((w) => w.length >= 4 && !FILLER.has(w)).map((w) => w.slice(0, 6));
  if (stems.length === 0) return false;
  return lines.some((words) => stems.every((stem) => words.some((w) => w.startsWith(stem))));
}

const HEDGES = ["geralmente", "normalmente", "costuma", "costumam", "em geral", "provavelmente", "possivelmente"];

/** A decisão do modelo diz que o material não traz o procedimento pedido. */
/**
 * A decisão admite que o material não cobre o que o cliente pediu: "não
 * informa o procedimento", "a possibilidade de X não está especificada",
 * "não há informação sobre isso", "sem orientação", "o material não trata
 * disso". Só formas que falam da cobertura do material — "não consta no
 * cadastro", "não foi encontrado no portal" e "não está previsto" são fatos
 * da situação do cliente ou do próprio material, não admissão.
 */
const ADMITS_MISSING = [
  /\bn[aã]o (?:informa|traz|descreve|detalha|explica|mostra|cont[eé]m|apresenta|menciona|cita|cobre|aborda|especifica|esclarece|contempla|diz)\b[^.;]{0,40}?\b(?:procedimento|passo|caminho|como|possibilidade|op[cç][aã]o|forma|detalhe|informa[cç][aã]o|orienta[cç][aã]o|instru[cç][aã]o|men[cç][aã]o|nada)(?!\p{L})/iu,
  /\bn[aã]o (?:est[aá]|é|foi|vem|aparece|se encontra)(?!\p{L})[^.;]{0,20}?\b(?:especificad|descrit|documentad|detalhad|mencionad|citad|abordad|cobert|esclarecid|explicad|contemplad|tratad)/iu,
  /\bn[aã]o (?:h[aá]|existe|existem|encontrei|localizei|achei|tenho|temos)(?!\p{L})[^.;]{0,25}?\b(?:informa[cç]|material|men[cç][aã]o|orienta[cç]|detalhe|procedimento|conte[uú]do|base|fonte|refer[eê]ncia|instru[cç]|trecho|documento|nada)/iu,
  /\bsem (?:informa[cç][aã]o|material|orienta[cç][aã]o|procedimento|passo a passo|refer[eê]ncia|instru[cç][aã]o|men[cç][aã]o|detalhe|conte[uú]do)(?!\p{L})/iu,
  /\b(?:materia(?:l|is)|base|documentos?|fontes?|trechos?|conte[uú]do|orienta[cç][oõ]es|instru[cç][oõ]es)\b[^.;]{0,40}?\bn[aã]o (?:fala|trata|cobre|aborda|menciona|cita|informa|traz|descreve|especifica|prev[eê]|define|esclarece|confirma|indica|contempla|detalha|explica|mostra|responde|diz|tem)(?!\p{L})/iu,
  /\b(?:fora|n[aã]o (?:consta|est[aá]|aparece|existe|encontrei|localizei|foi encontrad[oa]|cobert[oa]|respaldad[oa]|sustentad[oa])) (?:d|n|pel)(?:o|os|a|as) (?:materia(?:l|is)|base|documentos?|fontes?|trechos?|conte[uú]do|escopo)(?!\p{L})/iu,
];
/** Instrução de como fazer algo (verbo de ação no imperativo). */
const INSTRUCTION =
  /\b(?:selecione|clique|acesse|escolha|inclua|anexe|toque|preencha|abra|digite|localize|navegue|cadastre|gere|emita|baixe|instale|marque|desmarque|dirija-se|compare[cç]a|v[aá] (?:em|at[eé]|para)|entre (?:em|no|na|nos|nas)|(?:solicite|consulte|verifique|confira|procure) (?:em|no|na|nos|nas|pel[oa]s?|a (?:op[cç][aã]o|aba|se[cç][aã]o)|o (?:menu|item|bot[aã]o)))(?!\p{L})/iu;
/** Palavras da admissão que são o vocabulário dela, não o assunto. */
const ADMISSION_VOCAB = new Set([
  "informa", "informacao", "informacoes", "informado", "informada", "material", "materiais", "base", "documento", "documentos", "fonte", "fontes", "trecho", "trechos",
  "conteudo", "procedimento", "procedimentos", "passo", "passos", "caminho", "orientacao", "orientacoes", "instrucao", "instrucoes", "mencao", "detalhe", "detalhes",
  "referencia", "nada", "isso", "esse", "essa", "este", "esta", "disso", "sobre", "escopo", "possibilidade", "opcao", "forma",
  "especificado", "especificada", "especifica", "descrito", "descrita", "descreve", "documentado", "documentada", "detalhado", "detalhada", "detalha", "mencionado",
  "mencionada", "menciona", "citado", "citada", "cita", "abordado", "abordada", "aborda", "coberto", "coberta", "cobre", "esclarecido", "esclarecida", "esclarece",
  "explicado", "explicada", "explica", "contemplado", "contemplada", "contempla", "tratado", "tratada", "trata", "mostra", "traz", "apresenta", "define", "indica",
  "confirma", "responde", "fala", "existe", "existem", "encontrei", "localizei", "achei", "tenho", "temos", "consta", "aparece", "encontrado", "encontrada",
  "respaldado", "respaldada", "sustentado", "sustentada",
  "cliente", "usuario", "decisao", "resposta", "modelo", "agente", "equipe", "setor", "pessoa", "humano", "atendente", "atendimento", "transferencia", "transferir",
  "transfiro", "encaminhar", "encaminho", "encaminhamento", "encaminhei", "verificar", "verificacao", "confirmar", "confirmacao", "analise", "analisar", "depende",
  "necessario", "necessaria", "precisa", "preciso", "portanto", "entao", "assim", "para", "pelo", "pela", "como", "pois", "porque", "ainda", "apenas", "somente",
  "possivel", "pode", "podem", "deve", "devem", "caso", "situacao", "pedido", "duvida", "pergunta", "questao", "solicitacao", "geral",
]);

/** Oração da decisão que faz a admissão (antes de ", mas…", "; " ou "."). */
function admissionClause(reason: string): string | null {
  const parts = reason.split(/[.;:\n]+|,?\s+(?:mas|por[eé]m|contudo|entretanto|no entanto|embora|apesar)(?!\p{L})/iu);
  return parts.find((p) => ADMITS_MISSING.some((re) => re.test(p))) ?? null;
}

/** O assunto da admissão: as palavras dela fora do vocabulário de admitir. */
function subjectWords(clause: string): string[] {
  return normalize(clause).split(/\s+/).filter((w) => w.length >= 4 && !ADMISSION_VOCAB.has(w));
}

/** Mesma palavra ou mesmo radical ("parcelamento"/"parcelar", "financeiro"/"financeira"). */
function sameSubject(a: string, b: string): boolean {
  return a === b || (a.length >= 6 && b.length >= 6 && a.slice(0, 5) === b.slice(0, 5));
}

/**
 * Frases de instrução que a própria decisão desautoriza: a decisão admite
 * que o material não cobre o pedido e a resposta, mesmo assim, manda o
 * cliente acessar, selecionar, anexar… sobre esse mesmo pedido ("a
 * possibilidade de parcelamento não está especificada" + "acesse o portal
 * e confira a opção de parcelamento"). É procedimento montado — de outro
 * serviço, de uma imagem ou do que pareceu óbvio. Quando a admissão não
 * nomeia o assunto ("não há informação sobre isso"), toda instrução conta.
 * Instrução sobre outro assunto fica: o material pode cobrir esse.
 */
export function admittedMissingInstructions(reply: string, reason: string | undefined): string[] {
  const clause = reason ? admissionClause(reason) : null;
  if (!clause) return [];
  const sentences = reply
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && INSTRUCTION.test(s));
  const subject = subjectWords(clause);
  if (subject.length === 0) return sentences;
  return sentences.filter((s) => normalize(s).split(/\s+/).some((w) => w.length >= 4 && subject.some((x) => sameSubject(w, x))));
}

/** Há instrução que a decisão desautoriza (ver `admittedMissingInstructions`). */
export function procedureAdmittedMissing(reply: string, reason: string | undefined): boolean {
  return admittedMissingInstructions(reply, reason).length > 0;
}

/**
 * Palpite: "geralmente é pela opção X", "normalmente no valor da
 * parcela". Quando a palavra não vem da fonte, o modelo está
 * completando o que não sabe.
 */
export function unsupportedHedges(reply: string, sources: string[]): string[] {
  const text = ` ${normalize(reply).replace(/\s+/g, " ")} `;
  const haystack = ` ${normalize(sources.join(" ")).replace(/\s+/g, " ")} `;
  // Fonte que já fala em "normalmente": "costuma"/"geralmente" na resposta é
  // paráfrase dela, não palpite (o cliente era transferido por sinônimo).
  if (HEDGES.some((h) => haystack.includes(` ${h} `))) return [];
  return HEDGES.filter((h) => text.includes(` ${h} `) && !haystack.includes(` ${h} `));
}

/**
 * Percentual e valor em dinheiro na resposta que não aparecem em nenhuma
 * fonte. O modelo completava com "juros de 1% ao mês", "R$ 50 de taxa".
 */
export function unsupportedFigures(reply: string, sources: string[], clientTexts: string[] = []): string[] {
  const squash = (s: string) => s.replace(/\s+/g, "").replace(/\.(?=\d{3}\b)/g, "").toLowerCase();
  const haystack = squash(sources.join(" "));
  // Valor que o cliente escreveu sem "R$" ("falaram de 129 mas veio 1000"):
  // repetir como "R$ 129" é citar o cliente, não inventar.
  const clientValues = new Set([...clientTexts.join(" ").matchAll(/\d[\d.]*(?:,\d{1,2})?/g)].map((m) => moneyValue(m[0])).filter((v): v is number => v !== null));
  const out = new Set<string>();
  const patterns = [/\d+(?:[.,]\d+)?\s?%/g, /R\$\s?\d[\d.]*(?:,\d{1,2})?/gi];
  for (const re of patterns) {
    for (const m of reply.matchAll(re)) {
      // "R$ 50." no fim da frase: o ponto é da frase, não do valor.
      const token = m[0].trim().replace(/[.,;:!?]+$/, "");
      if (haystack.includes(squash(token))) continue;
      const value = /^R\$/i.test(token) ? moneyValue(token.replace(/^R\$\s?/i, "")) : null;
      if (value !== null && clientValues.has(value)) continue;
      out.add(token);
    }
  }
  // Por extenso: "50 por cento", "cinquenta por cento" (vale se a fonte
  // traz o mesmo número com % ou a mesma frase).
  const plain = normalize(sources.join(" ")).replace(/\s+/g, " ");
  for (const m of reply.matchAll(/\b(\d+(?:[.,]\d+)?|[a-zà-ú]+)\s+por\s*cento\b/gi)) {
    const token = m[0].trim();
    const asPercent = /^\d/.test(m[1]) ? squash(`${m[1]}%`) : "";
    if (!haystack.includes(squash(token)) && !(asPercent && haystack.includes(asPercent)) && !plain.includes(normalize(token))) out.add(token);
  }
  // "metade do valor/da parcela": proporção de dinheiro sem fonte.
  for (const m of reply.matchAll(/\bmetade\s+d[oa]s?\s+(?:valor|pre[cç]o|parcela|pagamento|cobran[cç]a|taxa|fatura)\b/gi)) {
    if (!/metade|50\s?%|cinquenta por cento/.test(sources.join(" ").toLowerCase())) out.add(m[0].trim());
  }
  return [...out];
}

/** "1.000", "1000", "129,90" → número; formato brasileiro. */
function moneyValue(raw: string): number | null {
  const s = raw.trim().replace(/[.,]$/, "");
  if (!/^\d/.test(s)) return null;
  const n = Number(s.replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const FACT_PATTERNS: Array<{ kind: "date" | "amount" | "phone" | "email"; re: RegExp }> = [
  { kind: "date", re: /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g },
  { kind: "amount", re: /\b\d+(?:[.,]\d+)?\s*(?:dias?(?:\s+[úu]teis)?|horas?|minutos?|semanas?|meses|m[êe]s|anos?)\b/gi },
  { kind: "phone", re: /(?:\+?55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b|\b0[38]00[\s-]?\d{3}[\s-]?\d{4}\b/g },
  { kind: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
];

/** "05/10", "5/10/2026" e "2026-10-05" viram "5/10" e "5/10/2026". */
function dateKeys(sources: string): Set<string> {
  const keys = new Set<string>();
  for (const m of sources.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    keys.add(`${+m[3]}/${+m[2]}`);
    keys.add(`${+m[3]}/${+m[2]}/${m[1]}`);
  }
  for (const m of sources.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    keys.add(`${+m[1]}/${+m[2]}`);
    if (m[3]) keys.add(`${+m[1]}/${+m[2]}/${m[3].length === 2 ? `20${m[3]}` : m[3]}`);
  }
  return keys;
}

/**
 * Data, prazo/quantidade ("15 dias úteis", "6 horas"), telefone e e-mail na
 * resposta que não aparecem em nenhuma fonte. Antes só R$ e % eram
 * conferidos e o resto chegava ao cliente.
 */
export function unsupportedFacts(reply: string, sources: string[], clientTexts: string[] = []): string[] {
  // Número que o cliente escreveu ("enviei nessa de 10 a 14"): repetir como
  // "14 horas" é citar o cliente, não inventar prazo.
  const clientNumbers = new Set([...clientTexts.join(" ").matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(",", ".")));
  // "120h", "40 hs", "30min" nas fontes valem como "120 horas", "30 minutos".
  const joined = sources
    .join(" ")
    .replace(/\b(\d+)\s*(?:h|hs|hrs?)\b/gi, "$1 horas")
    .replace(/\b(\d+)\s*min\b/gi, "$1 minutos");
  const squash = (s: string) => normalize(s).replace(/\s+/g, "");
  const haystack = squash(joined);
  const digits = joined.replace(/\D/g, "");
  const dates = dateKeys(joined);
  const out = new Set<string>();
  for (const { kind, re } of FACT_PATTERNS) {
    for (const m of reply.matchAll(re)) {
      const token = m[0].trim().replace(/[.,;:!?]+$/, "");
      if (kind === "date") {
        const [d, mo, y] = token.split("/");
        const key = y ? `${+d}/${+mo}/${y.length === 2 ? `20${y}` : y}` : `${+d}/${+mo}`;
        if (!dates.has(key)) out.add(token);
      } else if (kind === "phone") {
        const own = token.replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
        if (!digits.includes(own)) out.add(token);
      } else if (kind === "email") {
        if (!joined.toLowerCase().includes(token.toLowerCase())) out.add(token);
      } else if (!haystack.includes(squash(token))) {
        const n = token.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(",", ".");
        if (kind === "amount" && n && clientNumbers.has(n)) continue;
        out.add(token);
      }
    }
  }
  return [...out];
}

const MONTHS = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Datas por extenso ("6 de novembro") na resposta que não estão nas fontes (nem como 6/11). */
export function unsupportedLongDates(reply: string, sources: string[]): string[] {
  const joined = sources.join(" ");
  const keys = dateKeys(joined);
  const plain = normalize(joined).replace(/\s+/g, " ");
  const out = new Set<string>();
  for (const m of normalize(reply).matchAll(/\b(\d{1,2})\s+de\s+([a-z]+)\b/g)) {
    const month = MONTHS.indexOf(m[2]) + 1;
    if (month === 0) continue;
    if (!keys.has(`${+m[1]}/${month}`) && !plain.includes(`${+m[1]} de ${m[2]}`)) out.add(m[0]);
  }
  return [...out];
}

/** Data, período, valor, percentual ou quantidade na frase. */
export const FACT_IN_SENTENCE = /\d{1,2}\s*\/\s*\d{1,2}|\b\d{1,2}(?:\s*(?:a|e|até)\s*\d{1,2})?\s+de\s+[a-zç]{3,}|R\$\s?\d|\d+(?:[.,]\d+)?\s?%|\b\d+\s*(?:dias?|horas?|meses|semanas?|pontos?)\b/i;

/**
 * Nome que só o cliente usou (não está em nenhuma fonte nem nos dados dele)
 * e que a resposta trata como coisa real, ligando-o a data, valor ou prazo:
 * "o evento <nome> será de 6 a 9/11". A mensagem do cliente não é fonte
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

/**
 * Saída quando a resposta repetiria a anterior e não houve outra forma.
 * "Ficou alguma dúvida sobre o que te passei?" só cabe depois de uma
 * explicação; depois de cumprimento ou pergunta curta ("Tudo bem?" logo
 * após o "Oi") soava como se o agente tivesse explicado algo.
 */
export function repeatFallback(
  lastAgentMessage: string | null | undefined,
  config?: { systemMessages?: SystemMessages | null } | null,
): string {
  return systemMessage(config, tokensOf(lastAgentMessage ?? "").length >= 20 ? "repeatAfterAnswer" : "stillHere");
}
