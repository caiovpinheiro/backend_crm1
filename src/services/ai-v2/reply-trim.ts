/**
 * Corte de frase sem fonte. Quando a checagem marca uma afirmação que não
 * está nos materiais, o caminho era pedir ao modelo outra resposta — que
 * parafraseava a mesma afirmação e acabava em transferência, com o cliente
 * sem a parte da resposta que estava certa. Aqui a frase marcada é tirada
 * e o resto segue, sem nova chamada ao modelo, desde que o que sobra ainda
 * responda. Passo de lista numerada não é cortado (quebraria o
 * procedimento): nesse caso o corte não se aplica. Nenhum domínio de cliente.
 */

export type TrimResult = { reply: string; removed: string[] };

/** Começo de frase que é só cortesia (não conta como conteúdo). */
const COURTESY = /^(?:oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|obrigad|de nada|por nada|fico [àa] disposi|qualquer (?:d[úu]vida|coisa)|estou por aqui|[ée] s[óo] (?:me )?chamar|posso (?:te )?ajudar|precisa de (?:mais )?alguma coisa|se precisar|conte comigo|espero ter ajudado|disponha|entendi|entendo|perfeito|combinado|claro|certo)\b/i;
/** Conector que fica órfão quando a frase anterior sai. */
const ORPHAN_CONNECTOR = /^(?:al[ée]m disso|por isso|assim|dessa forma|desse modo|ou seja|tamb[ée]m|ent[ãa]o|por esse motivo|isso significa que|no entanto|mas|por[ée]m|e|sendo assim|nesse caso|com isso)[,:]?\s+/i;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-•*])\s+/;

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

/** Frases da resposta: por linha e, dentro da linha, por ponto/!/?. */
export function splitReplyUnits(reply: string): Unit[] {
  const units: Unit[] = [];
  reply.split(/\r?\n/).forEach((line, i) => {
    const listItem = LIST_ITEM.test(line);
    const parts = listItem ? [line] : line.split(/(?<=[.!?])\s+/);
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

/** O que sobrou ainda responde: tamanho mínimo e ao menos uma frase de conteúdo. */
function stillAnswers(units: Unit[]): boolean {
  const text = units.map((u) => u.text).join(" ");
  if (wordCount(text) < 12) return false;
  return units.some((u) => wordCount(u.text) >= 8 && !COURTESY.test(u.text.trim()) && !/\?\s*$/.test(u.text.trim()));
}

/**
 * Tira da resposta as frases que contêm as marcações. `null` quando o corte
 * não se aplica: marcação não localizada, marcação num passo de lista, ou o
 * que sobra não responde mais (aí vale a reescrita pelo modelo).
 */
export function trimUnsupportedSentences(reply: string, flagged: string[]): TrimResult | null {
  const texts = flagged.map((f) => f.trim()).filter(Boolean);
  if (texts.length === 0) return null;
  const units = splitReplyUnits(reply);
  const drop = new Set<number>();
  for (const f of texts) {
    let found = false;
    units.forEach((u, i) => {
      if (!unitMatches(norm(u.text), f)) return;
      found = true;
      drop.add(i);
    });
    if (!found) return null;
  }
  if ([...drop].some((i) => units[i].listItem)) return null;
  if (drop.size === 0 || drop.size === units.length) return null;

  const kept: Unit[] = [];
  units.forEach((u, i) => {
    if (drop.has(i)) return;
    let text = u.text;
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
  return { reply: out.join("\n").trim(), removed: [...drop].sort((a, b) => a - b).map((i) => units[i].text.trim()) };
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
