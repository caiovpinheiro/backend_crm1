/**
 * Marca "(já passou)" nas datas de um texto que ficaram antes de hoje.
 * Modelo compara data mal: com um calendário nos trechos, listava um evento
 * do começo do mês como "próximo" no fim do mesmo mês. Marcando no texto, ele não
 * precisa calcular. Só português; nenhum domínio de cliente.
 */

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, "março": 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const MONTH_RE = "(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)";

export const PAST_MARK = " (já passou)";

type Ymd = { y: number; m: number; d: number };

function ymdInTz(now: Date, timezone: string): Ymd {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return { y: get("year"), m: get("month"), d: get("day") };
  } catch {
    return { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
  }
}

const key = (x: Ymd) => x.y * 10000 + x.m * 100 + x.d;

/** Sem ano: o ano que deixa a data mais perto de hoje (±6 meses). */
function withYear(d: number, m: number, y: number | undefined, today: Ymd): Ymd {
  if (y) return { y: y < 100 ? 2000 + y : y, m, d };
  const monthsFromToday = (m - today.m) + 0;
  if (monthsFromToday < -6) return { y: today.y + 1, m, d };
  if (monthsFromToday > 6) return { y: today.y - 1, m, d };
  return { y: today.y, m, d };
}

function valid(x: Ymd): boolean {
  return x.m >= 1 && x.m <= 12 && x.d >= 1 && x.d <= 31;
}

type DateSpan = { start: number; end: number; first: Ymd; last: Ymd };

/** Datas e períodos do texto, com o primeiro e o último dia de cada um. */
function collectDates(text: string, today: Ymd): DateSpan[] {
  const matches: DateSpan[] = [];
  const taken = (s: number, e: number) => matches.some((m) => s < m.end && e > m.start);
  const collect = (re: RegExp, toSpan: (m: RegExpExecArray) => { first: Ymd; last: Ymd } | null) => {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken(start, end)) continue;
      const span = toSpan(m as RegExpExecArray);
      if (span && valid(span.first) && valid(span.last)) matches.push({ start, end, ...span });
    }
  };
  const single = (x: Ymd | null) => (x ? { first: x, last: x } : null);

  // "11 a 14 de setembro de 2026", "27 e 28 de janeiro"
  collect(new RegExp(`\\b(\\d{1,2})\\s*(?:a|e|-|–|até)\\s*(\\d{1,2})\\s+de\\s+${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?`, "gi"), (m) => {
    const y = m[4] ? Number(m[4]) : undefined;
    const mo = MONTHS[m[3].toLowerCase()];
    return { first: withYear(Number(m[1]), mo, y, today), last: withYear(Number(m[2]), mo, y, today) };
  });
  // "30 de setembro a 2 de outubro de 2026"
  collect(new RegExp(`\\b(\\d{1,2})\\s+de\\s+${MONTH_RE}\\s*(?:a|até|-|–)\\s*(\\d{1,2})\\s+de\\s+${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?`, "gi"), (m) => {
    const y = m[5] ? Number(m[5]) : undefined;
    return { first: withYear(Number(m[1]), MONTHS[m[2].toLowerCase()], y, today), last: withYear(Number(m[3]), MONTHS[m[4].toLowerCase()], y, today) };
  });
  // "5 de outubro de 2026"
  collect(new RegExp(`\\b(\\d{1,2})\\s+de\\s+${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?`, "gi"), (m) =>
    single(withYear(Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : undefined, today)));
  // "11/09 a 14/09/2026"
  collect(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:a|até|-|–)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/gi, (m) => {
    const yLast = m[6] ? Number(m[6]) : m[3] ? Number(m[3]) : undefined;
    // Ano só no fim ("06/11 a 09/11/2026"): vale para o começo, salvo virada de ano.
    const yFirst = m[3] ? Number(m[3]) : yLast !== undefined && Number(m[2]) <= Number(m[5]) ? yLast : undefined;
    return { first: withYear(Number(m[1]), Number(m[2]), yFirst, today), last: withYear(Number(m[4]), Number(m[5]), yLast, today) };
  });
  // "14/09/2026", "14/09". Sem ano, só dd/mm com dois dígitos: "24/7" não é data.
  collect(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) =>
    !m[3] && (m[1].length < 2 || m[2].length < 2)
      ? null
      : single(withYear(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined, today)));
  return matches;
}

export function markPastDates(text: string, now: Date = new Date(), timezone = "America/Sao_Paulo"): string {
  if (!text) return text;
  const today = ymdInTz(now, timezone);
  const matches = collectDates(text, today);
  const past = matches.filter((m) => key(m.last) < key(today)).sort((a, b) => b.end - a.end);
  let out = text;
  for (const m of past) {
    if (out.slice(m.end, m.end + PAST_MARK.length) === PAST_MARK) continue;
    out = out.slice(0, m.end) + PAST_MARK + out.slice(m.end);
  }
  return out;
}

// ─── Tempo verbal x data ─────────────────────────────────────────────────

/** "foi realizada", "aconteceu", "já passou", "foram de 06/11 a…": o evento como já ocorrido. */
const PAST_OCCURRENCE =
  /\b(?:j[áa]\s+)?(?:(?:foi|foram)\s+(?:realizad|aplicad|feit|liberad|divulgad|encerrad|conclu[ií]d|finalizad|disponibilizad)\w*|aconteceu|aconteceram|ocorreu|ocorreram|encerrou|encerraram|terminou|terminaram|passou(?!\s+(?:a|para|por|pel[oa])\b)|passaram(?!\s+(?:a|para|por|pel[oa])\b)|(?:foi|foram)(?=\s+(?:de|em|no dia|nos dias|entre)\s+\d))(?![\p{L}])/giu;
/** "será realizada", "acontecerá", "vai ocorrer": o evento como ainda por vir. */
const FUTURE_OCCURRENCE =
  /\b(?:(?:ser[áa]|ser[ãa]o|vai ser|v[ãa]o ser)\s+(?:realizad|aplicad|feit|liberad|divulgad|encerrad|conclu[ií]d|finalizad|disponibilizad)\w*|acontecer[áa]|acontecer[ãa]o|ocorrer[áa]|ocorrer[ãa]o|vai acontecer|v[ãa]o acontecer|vai ocorrer|v[ãa]o ocorrer|(?:ser[áa]|ser[ãa]o)(?=\s+(?:de|em|no dia|nos dias|entre)\s+\d))(?![\p{L}])/giu;
/** Entre o verbo e a data há outra oração ("foi feita e a prova será…")? Então não estão ligados. */
const CLAUSE_BREAK = /[,;:()]|\b(?:e|mas|por[ée]m|que|se|quando|porque|pois|caso|ou)\b/iu;
const SENTENCE_SPLIT = /\r?\n|(?<=[.!?])\s+/;
const PAST_TO_FUTURE: Array<[RegExp, string]> = [
  [/\bj[áa]\s+(?=(?:foi|foram|aconteceu|aconteceram|ocorreu|ocorreram)\b)/iu, ""],
  [/\bforam\b/iu, "serão"], [/\bfoi\b/iu, "será"],
  [/\baconteceram\b/iu, "acontecem"], [/\baconteceu\b/iu, "acontece"],
  [/\bocorreram\b/iu, "ocorrem"], [/\bocorreu\b/iu, "ocorre"],
];
const FUTURE_TO_PAST: Array<[RegExp, string]> = [
  [/\bv[ãa]o ser\b/iu, "foram"], [/\bvai ser\b/iu, "foi"], [/\bser[ãa]o(?![\p{L}])/iu, "foram"], [/\bser[áa](?![\p{L}])/iu, "foi"],
  [/\bv[ãa]o acontecer\b/iu, "aconteceram"], [/\bvai acontecer\b/iu, "aconteceu"], [/\bacontecer[ãa]o(?![\p{L}])/iu, "aconteceram"], [/\bacontecer[áa](?![\p{L}])/iu, "aconteceu"],
  [/\bv[ãa]o ocorrer\b/iu, "ocorreram"], [/\bvai ocorrer\b/iu, "ocorreu"], [/\bocorrer[ãa]o(?![\p{L}])/iu, "ocorreram"], [/\bocorrer[áa](?![\p{L}])/iu, "ocorreu"],
];

/** Troca só o verbo ("já foram realizadas" → "serão realizadas"); null quando não há troca para ele. */
function fixVerb(verb: string, maps: Array<[RegExp, string]>): string | null {
  let out = verb;
  let changed = false;
  for (const [re, to] of maps) {
    if (!re.test(out)) continue;
    out = out.replace(re, to);
    changed = changed || to !== "";
  }
  return changed ? out : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmt = (x: Ymd) => `${pad2(x.d)}/${pad2(x.m)}/${x.y}`;

export type TenseMismatch = { sentence: string; fixed: string | null; why: string };

/**
 * Frase que põe no passado uma data que ainda vem ("as provas foram
 * realizadas de 06/11 a 09/11", hoje 09/10) ou no futuro uma que já passou
 * ("será aplicada em 06/09"). O modelo erra o tempo verbal mesmo com a
 * situação da data marcada. `fixed` é a frase com o verbo trocado quando a
 * troca é só o verbo; null quando não dá ("já passou") — aí a frase sai.
 */
export function tenseMismatches(reply: string, now: Date = new Date(), timezone = "America/Sao_Paulo"): TenseMismatch[] {
  const today = ymdInTz(now, timezone);
  const out: TenseMismatch[] = [];
  for (const raw of reply.split(SENTENCE_SPLIT)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const dates = collectDates(sentence, today);
    if (dates.length === 0) continue;
    const check = (verbRe: RegExp, wrong: (d: DateSpan) => boolean, maps: Array<[RegExp, string]>, state: string): boolean => {
      for (const m of sentence.matchAll(verbRe)) {
        const vStart = m.index ?? 0;
        const vEnd = vStart + m[0].length;
        // A data mais perto do verbo, sem outra oração no meio.
        const tied = dates
          .filter((d) => !CLAUSE_BREAK.test(d.start >= vEnd ? sentence.slice(vEnd, d.start) : sentence.slice(d.end, vStart)))
          .sort((x, y) => Math.abs(x.start - vEnd) - Math.abs(y.start - vEnd))[0];
        if (!tied || !wrong(tied)) continue;
        const when = key(tied.first) === key(tied.last) ? fmt(tied.first) : `${fmt(tied.first)} a ${fmt(tied.last)}`;
        const fixedVerb = fixVerb(m[0], maps);
        out.push({
          sentence,
          fixed: fixedVerb ? `${sentence.slice(0, vStart)}${fixedVerb}${sentence.slice(vEnd)}` : null,
          why: `${when} ${state} (hoje é ${fmt(today)}) e a frase dizia "${m[0]}"`,
        });
        return true;
      }
      return false;
    };
    if (check(PAST_OCCURRENCE, (d) => key(d.first) > key(today), PAST_TO_FUTURE, "ainda vem")) continue;
    check(FUTURE_OCCURRENCE, (d) => key(d.last) < key(today), FUTURE_TO_PAST, "já passou");
  }
  return out;
}
