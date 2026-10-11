/**
 * Feriados nacionais do Brasil e dias sem expediente bancário (Carnaval,
 * Sexta-feira Santa, Corpus Christi), para calcular "próximo dia útil".
 * Sem isso o modelo contava só sábado e domingo e mandava pagar num
 * feriado. Datas por ano: fixas + as que dependem da Páscoa.
 */

const FIXED: Array<[string, string]> = [
  ["01-01", "Confraternização Universal"],
  ["04-21", "Tiradentes"],
  ["05-01", "Dia do Trabalho"],
  ["09-07", "Independência"],
  ["10-12", "Nossa Senhora Aparecida"],
  ["11-02", "Finados"],
  ["11-15", "Proclamação da República"],
  ["11-20", "Dia da Consciência Negra"],
  ["12-25", "Natal"],
];

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), em UTC. */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

const cache = new Map<number, Map<string, string>>();

/** Feriados e dias sem expediente bancário do ano: "AAAA-MM-DD" → nome. */
export function brHolidays(year: number): Map<string, string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const out = new Map<string, string>(FIXED.map(([md, name]) => [`${year}-${md}`, name]));
  const easter = easterSunday(year);
  out.set(iso(addDays(easter, -48)), "Carnaval");
  out.set(iso(addDays(easter, -47)), "Carnaval");
  out.set(iso(addDays(easter, -2)), "Sexta-feira Santa");
  out.set(iso(addDays(easter, 60)), "Corpus Christi");
  cache.set(year, out);
  return out;
}

export function brHolidayName(isoDate: string): string | null {
  return brHolidays(Number(isoDate.slice(0, 4))).get(isoDate) ?? null;
}

/** Dia útil: não é sábado, domingo nem feriado/dia sem expediente bancário. */
export function isBrBusinessDay(isoDate: string): boolean {
  const dow = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !brHolidayName(isoDate);
}

/** Próximo dia útil depois de `isoDate` (não conta o próprio dia). */
export function nextBrBusinessDay(isoDate: string): string {
  let d = new Date(`${isoDate}T12:00:00Z`);
  for (let i = 0; i < 15; i += 1) {
    d = addDays(d, 1);
    if (isBrBusinessDay(iso(d))) return iso(d);
  }
  return iso(d);
}

/** Fusos do Brasil (IANA). Fora deles, o motor não fala de feriado. */
export function isBrazilTimezone(tz: string | undefined): boolean {
  return !!tz && /^America\/(?:Sao_Paulo|Rio_Branco|Manaus|Porto_Velho|Boa_Vista|Cuiaba|Campo_Grande|Belem|Santarem|Araguaina|Fortaleza|Recife|Maceio|Bahia|Noronha|Eirunepe)$/.test(tz);
}
