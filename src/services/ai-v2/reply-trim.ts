/**
 * Corte de frase sem fonte. Quando a checagem marca uma afirmação que não
 * está nos materiais, o caminho era pedir ao modelo outra resposta — que
 * parafraseava a mesma afirmação e acabava em transferência, com o cliente
 * sem a parte da resposta que estava certa. Aqui só o que foi marcado sai e
 * o resto segue, sem nova chamada ao modelo, desde que o que sobra ainda
 * responda e não fique mutilado (sem abertura, sem o link, começando por
 * "Se aparecer…"). Passo de lista sai inteiro, nunca pela metade, e só
 * quando a lista fica com dois passos ou mais; os que sobram são
 * renumerados (antes o passo inventado levava a resposta inteira embora e o
 * cliente era transferido). Nenhum domínio de cliente.
 */

export type TrimResult = { reply: string; removed: string[] };

/** Começo de frase que é só cortesia (não conta como conteúdo). */
const COURTESY = /^(?:oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|obrigad|de nada|por nada|fico [àa] disposi|qualquer (?:d[úu]vida|coisa)|estou por aqui|[ée] s[óo] (?:me )?chamar|posso (?:te )?ajudar|precisa de (?:mais )?alguma coisa|se precisar|conte comigo|espero ter ajudado|disponha|entendi|entendo|perfeito|combinado|claro|certo)\b/i;
/** Conector que fica órfão quando a frase anterior sai. */
const ORPHAN_CONNECTOR = /^(?:al[ée]m disso|por isso|assim|dessa forma|desse modo|ou seja|tamb[ée]m|ent[ãa]o|por esse motivo|isso significa que|no entanto|mas|por[ée]m|e|sendo assim|nesse caso|com isso)[,:]?\s+/i;
/** Resposta que começa no meio: condição ou continuação sem o que veio antes. */
const CONTINUATION_START = /^(?:se|caso|depois|em seguida|ent[ãa]o|assim|tamb[ée]m|al[ée]m disso|por fim|agora|na sequ[êe]ncia|quando|feito isso|ap[óo]s|a[ií])\b/i;
// Passo numerado: "1.", "1)", "1️⃣", "Passo 1:", marcador ou emoji de lista.
const LIST_ITEM = /^\s*(?:\d+[.)]|\d️?⃣|(?:passo|etapa)\s+\d+\s*[:.)-]|[-•*▪➡👉✅📌]️?)\s*/iu;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
/** Fim de frase, ou link seguido de espaço e maiúscula (link não termina com ponto). */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+|(?<=https?:\/\/[^\s]+)\s+(?=\p{Lu})/u;
/** Oração de causa no começo ("Como ele é necessário para seguir, …"). */
const CAUSAL_START = /^(?:como|j[áa] que|uma vez que|visto que|dado que|pois|porque)\s+/i;
/** Oração que sozinha não é frase: finalidade, condição, tempo ("Para o primeiro acesso, …"). */
const DEPENDENT_START = /^(?:para|pra|se|caso|quando|assim que|antes de|depois de|ap[óo]s|at[ée] que|enquanto|embora|mesmo que|apesar de|conforme)\s/i;

/**
 * O que sobra de uma frase depois de tirar a oração principal (o aviso de
 * transferência, o trecho sem fonte) precisa ficar de pé. Sem vírgula
 * dentro, o que sobrou é só a oração que abria a frase: a de causa perde o
 * conector ("Como ele é necessário." → "Ele é necessário."); a de
 * finalidade, condição ou tempo sai ("Para o primeiro acesso." não diz
 * nada). Vazio quando não sobra frase.
 */
export function standaloneClause(clause: string): string {
  const s = clause.trim();
  if (s.includes(",")) return s;
  const causal = s.match(CAUSAL_START);
  if (causal) {
    const rest = s.slice(causal[0].length);
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return DEPENDENT_START.test(s) ? "" : s;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[*_~`"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function contentWords(s: string): string[] {
  return norm(s).split(/[^\p{L}\p{N}$%/]+/u).filter((w) => w.length >= 4 || /\d/.test(w));
}

type Unit = { text: string; line: number; listItem: boolean };

/** Frases da resposta: por linha e, dentro da linha, por ponto/!/? (link também separa). */
export function splitReplyUnits(reply: string): Unit[] {
  const units: Unit[] = [];
  reply.split(/\r?\n/).forEach((line, i) => {
    const listItem = LIST_ITEM.test(line);
    const parts = listItem ? [line] : line.split(SENTENCE_BOUNDARY);
    for (const p of parts) if (p.trim()) units.push({ text: p, line: i, listItem });
  });
  return units;
}

/** A frase contém a marcação: literal (começo dela) ou a maior parte das palavras dela. */
function unitMatches(unitNorm: string, flagged: string): boolean {
  const f = norm(flagged);
  if (!f) return false;
  if (unitNorm.includes(f.slice(0, 40))) return true;
  const words = contentWords(flagged);
  if (words.length < 2) return false;
  const vocab = new Set(contentWords(unitNorm));
  return words.filter((w) => vocab.has(w)).length / words.length >= 0.7;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Texto dobrado (minúsculas, sem acento, sem marcação) com o índice original de cada caractere. */
function foldChars(s: string): { folded: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (/[*_~`"“”]/.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (out.length > 0 && out[out.length - 1] === " ") continue;
      out.push(" ");
      map.push(i);
      continue;
    }
    for (const c of ch.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")) {
      out.push(c);
      map.push(i);
    }
  }
  return { folded: out.join(""), map };
}

/**
 * Tira só o trecho marcado de dentro da frase (a frase que trazia o link e
 * o passo 1 saía inteira por causa de uma oração sem fonte). Vale quando a
 * marcação é uma oração (4+ palavras) achada literalmente e sobra frase.
 */
function removeSpan(unitText: string, flagged: string): string | null {
  const f = norm(flagged);
  if (contentWords(flagged).length < 4) return null;
  const { folded, map } = foldChars(unitText);
  const idx = folded.indexOf(f);
  if (idx < 0) return null;
  const start = map[idx];
  const end = map[idx + f.length - 1] + 1;
  let rest = `${unitText.slice(0, start)} ${unitText.slice(end)}`;
  rest = rest
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[,;:]\s*([.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/(?:^|\s)(?:e|ou|mas)\s*([.!?])?\s*$/i, "$1")
    .trim();
  // Marcação no fim da frase: o que sobra é o começo dela, que precisa ficar de pé.
  if (!/\p{L}/u.test(unitText.slice(end))) {
    const head = standaloneClause(rest.replace(/[,;:.!?\s]+$/, ""));
    if (!head) return null;
    rest = head;
  }
  if (wordCount(rest.replace(URL_RE, "link")) < 4 && !URL_RE.test(rest)) return null;
  if (!/[.!?]$/.test(rest) && /[.!?]$/.test(unitText.trim())) rest = `${rest}.`;
  return rest;
}

/** O que sobrou ainda responde: tamanho mínimo e ao menos uma frase de conteúdo. */
function stillAnswers(units: Unit[]): boolean {
  const text = units.map((u) => u.text).join(" ");
  if (wordCount(text) < 12) return false;
  return units.some((u) => wordCount(u.text) >= 8 && !COURTESY.test(u.text.trim()) && !/\?\s*$/.test(u.text.trim()));
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * A versão cortada ficou mutilada: começa por condição/continuação que o
 * original não tinha, começa por passo de lista sem a abertura, ou perdeu um
 * link que não estava marcado. Aí não sai assim.
 */
export function isMutilated(original: string, trimmed: string, flagged: string[] = []): boolean {
  const first = firstLine(trimmed);
  const firstOriginal = firstLine(original);
  if (CONTINUATION_START.test(first) && !CONTINUATION_START.test(firstOriginal)) return true;
  if (LIST_ITEM.test(first) && !LIST_ITEM.test(firstOriginal)) return true;
  const flaggedUrls = new Set(flagged.flatMap((f) => f.match(URL_RE) ?? []));
  const kept = new Set(trimmed.match(URL_RE) ?? []);
  for (const url of original.match(URL_RE) ?? []) if (!flaggedUrls.has(url) && !kept.has(url)) return true;
  return false;
}

/**
 * Tira da resposta o que foi marcado: só o trecho, quando a marcação é uma
 * oração dentro de uma frase maior; a frase inteira quando ela é a própria
 * marcação; o passo de lista inteiro, com os outros renumerados. `null`
 * quando o corte não se aplica: marcação não localizada, lista que ficaria
 * com menos de dois passos, resposta mutilada ou o que sobra não responde
 * mais (aí vale a reescrita pelo modelo).
 */
export function trimUnsupportedSentences(reply: string, flagged: string[]): TrimResult | null {
  const texts = flagged.map((f) => f.trim()).filter(Boolean);
  if (texts.length === 0) return null;
  const units = splitReplyUnits(reply);
  const drop = new Set<number>();
  const replaced = new Map<number, string>();
  for (const f of texts) {
    let found = false;
    units.forEach((u, i) => {
      if (!unitMatches(norm(u.text), f)) return;
      found = true;
      const rest = u.listItem ? null : removeSpan(replaced.get(i) ?? u.text, f);
      if (rest !== null) replaced.set(i, rest);
      else drop.add(i);
    });
    if (!found) return null;
  }
  for (const i of replaced.keys()) if (drop.has(i)) replaced.delete(i);
  const droppedSteps = [...drop].filter((i) => units[i].listItem).length;
  if (droppedSteps > 0 && units.filter((u, i) => u.listItem && !drop.has(i)).length < 2) return null;
  if (drop.size + replaced.size === 0 || drop.size === units.length) return null;

  const kept: Unit[] = [];
  units.forEach((u, i) => {
    if (drop.has(i)) return;
    let text = replaced.get(i) ?? u.text;
    // Frase logo depois de uma cortada: o conector fica sem antecedente.
    if (i > 0 && drop.has(i - 1) && ORPHAN_CONNECTOR.test(text.trim())) {
      const rest = text.trim().replace(ORPHAN_CONNECTOR, "");
      text = rest.charAt(0).toUpperCase() + rest.slice(1);
    }
    kept.push({ ...u, text });
  });
  if (!stillAnswers(kept)) return null;

  // Remonta por linha; linhas em branco que separavam parágrafos ficam como uma só.
  const original = reply.split(/\r?\n/);
  const out: string[] = [];
  let lastLine = -1;
  for (const u of kept) {
    if (u.line === lastLine) {
      out[out.length - 1] = `${out[out.length - 1]} ${u.text.trim()}`;
      continue;
    }
    const gap = lastLine >= 0 && original.slice(lastLine + 1, u.line).some((l) => !l.trim());
    if (gap && out.length > 0) out.push("");
    out.push(u.text.trim());
    lastLine = u.line;
  }
  const joined = out.join("\n").trim();
  const result = droppedSteps > 0 ? renumberSteps(joined) : joined;
  if (isMutilated(reply, result, texts)) return null;
  const removed = [...drop].sort((a, b) => a - b).map((i) => units[i].text.trim());
  for (const [i, rest] of replaced) removed.push(`${units[i].text.trim()} → ${rest}`);
  return { reply: result, removed };
}

/**
 * A reescrita só tirou frases: toda frase dela já estava na resposta
 * original (fora das cortadas). Nada novo a conferir — a checagem por
 * modelo já passou por essas frases.
 */
export function onlyKeptSentences(rewritten: string, original: string, removed: string[]): boolean {
  // Sem o número do passo: tirar um passo renumera os seguintes.
  const clean = (t: string) => norm(t).replace(/^(?:\d+[.)]|[-•*])\s*/, "");
  const removedNorm = removed.map(clean).filter(Boolean);
  const keptNorm = splitReplyUnits(original)
    .map((u) => clean(u.text))
    .filter((t) => t && !removedNorm.some((r) => t === r || t.includes(r) || r.includes(t)));
  if (keptNorm.length === 0) return false;
  const newUnits = splitReplyUnits(rewritten).map((u) => clean(u.text)).filter(Boolean);
  if (newUnits.length === 0) return false;
  const sameSentence = (a: string, b: string) => {
    if (a === b || b.includes(a)) return true;
    const wa = new Set(contentWords(a));
    const wb = new Set(contentWords(b));
    if (wa.size === 0 || wb.size === 0) return false;
    let inter = 0;
    for (const w of wa) if (wb.has(w)) inter += 1;
    return inter / (wa.size + wb.size - inter) >= 0.85;
  };
  return newUnits.every((n) => keptNorm.some((k) => sameSentence(n, k)));
}

/** Número do passo: "1.", "1)", "Passo 1:" ou o emoji "1️⃣". */
const STEP_NUMBER = /^(\s*(?:(?:passo|etapa)\s+)?)(\d{1,2})(\uFE0F?\u20E3|\s*[.):-])/i;

/**
 * Renumera cada lista numerada depois de um passo retirado ("1, 3, 4" vira
 * "1, 2, 3"), mantendo o estilo do número. Linha de texto entre passos
 * começa outra lista; linha em branco não.
 */
export function renumberSteps(text: string): string {
  let n = 0;
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(STEP_NUMBER);
      if (!m) {
        if (line.trim()) n = 0;
        return line;
      }
      n += 1;
      const keycap = m[3].includes("\u20E3");
      const mark = keycap ? (n <= 9 ? `${n}\uFE0F\u20E3` : `${n}.`) : `${n}${m[3]}`;
      return `${m[1]}${mark}${line.slice(m[0].length)}`;
    })
    .join("\n");
}

