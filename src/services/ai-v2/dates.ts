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

export function markPastDates(text: string, now: Date = new Date(), timezone = "America/Sao_Paulo"): string {
  if (!text) return text;
  const today = ymdInTz(now, timezone);
  const matches: Array<{ start: number; end: number; last: Ymd }> = [];
  const taken = (s: number, e: number) => matches.some((m) => s < m.end && e > m.start);
  const collect = (re: RegExp, toLast: (m: RegExpExecArray) => Ymd | null) => {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken(start, end)) continue;
      const last = toLast(m as RegExpExecArray);
      if (last && valid(last)) matches.push({ start, end, last });
    }
  };

  // "11 a 14 de setembro de 2026", "27 e 28 de janeiro"
  collect(new RegExp(`\\b(\\d{1,2})\\s*(?:a|e|-|–|até)\\s*(\\d{1,2})\\s+de\\s+${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?`, "gi"), (m) =>
    withYear(Number(m[2]), MONTHS[m[3].toLowerCase()], m[4] ? Number(m[4]) : undefined, today));
  // "30 de setembro a 2 de outubro de 2026"
  collect(new RegExp(`\\b(\\d{1,2})\\s+de\\s+${MONTH_RE}\\s*(?:a|até|-|–)\\s*(\\d{1,2})\\s+de\\s+${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?`, "gi"), (m) =>
    withYear(Number(m[3]), MONTHS[m[4].toLowerCase()], m[5] ? Number(m[5]) : undefined, today));
  // "5 de outubro de 2026"
  collect(new RegExp(`\\b(\\d{1,2})\\s+de\\s+${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?`, "gi"), (m) =>
    withYear(Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : undefined, today));
  // "11/09 a 14/09/2026"
  collect(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:a|até|-|–)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/gi, (m) =>
    withYear(Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : m[3] ? Number(m[3]) : undefined, today));
  // "14/09/2026", "14/09". Sem ano, só dd/mm com dois dígitos: "24/7" não é data.
  collect(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) =>
    !m[3] && (m[1].length < 2 || m[2].length < 2)
      ? null
      : withYear(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined, today));

  const past = matches.filter((m) => key(m.last) < key(today)).sort((a, b) => b.end - a.end);
  let out = text;
  for (const m of past) {
    if (out.slice(m.end, m.end + PAST_MARK.length) === PAST_MARK) continue;
    out = out.slice(0, m.end) + PAST_MARK + out.slice(m.end);
  }
  return out;
}
