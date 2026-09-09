/**
 * Conversão "data que o operador digitou" → instante UTC, no fuso informado.
 *
 * O operador escolhe um DIA (`2026-12-21`), não um instante. Guardar isso como
 * meia-noite UTC faria o documento vencer às 21h do próprio dia em BRT — cedo
 * exatamente no dia que importa. Aqui o dia é ancorado no fuso do agente
 * (o mesmo resolvido por `resolveAgentTimezone`).
 *
 * Sem dependência nova: o offset sai do `Intl` renderizando o instante no fuso
 * e reinterpretando o resultado como UTC. Duas passadas resolvem a borda de
 * horário de verão.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour === 24 ? 0 : hour,
    get("minute"),
    get("second"),
  );
  // O `Intl` não devolve milissegundos: compara segundo cheio com segundo
  // cheio, senão um instante com `.999` deslocaria o offset em 1 segundo.
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

function instantFromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const first = offsetMs(new Date(guess), timeZone);
  const second_ = offsetMs(new Date(guess - first), timeZone);
  return new Date(guess - second_);
}

function parseDay(
  value: string,
): { year: number; month: number; day: number } | null {
  const m = DATE_ONLY.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** `2026-12-21` → instante das 00:00:00.000 daquele dia no fuso. */
export function resolveZonedDayStart(
  value: string,
  timeZone: string,
): Date | null {
  const d = parseDay(value);
  if (!d) return null;
  return instantFromWallClock(d.year, d.month, d.day, 0, 0, 0, 0, timeZone);
}

/** `2026-12-21` → instante das 23:59:59.999 daquele dia no fuso. */
export function resolveZonedDayEnd(
  value: string,
  timeZone: string,
): Date | null {
  const d = parseDay(value);
  if (!d) return null;
  return instantFromWallClock(
    d.year,
    d.month,
    d.day,
    23,
    59,
    59,
    999,
    timeZone,
  );
}

/**
 * Início da janela do Tabulador: mensagens de hoje no fuso.
 * Sábado inclui sexta (D-1). Domingo inclui sexta (D-2).
 * Dias úteis não puxam o histórico de ontem.
 */
export function tabulationHistoryWindowStart(
  now: Date,
  timeZone: string,
): Date {
  const today = formatZonedDay(now, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(now);
  const daysBack = weekday === "Sat" ? 1 : weekday === "Sun" ? 2 : 0;
  const [y, m, d] = today.split("-").map(Number);
  const ymd = new Date(Date.UTC(y!, m! - 1, d! - daysBack))
    .toISOString()
    .slice(0, 10);
  return resolveZonedDayStart(ymd, timeZone) ?? new Date(now);
}

/** `2026-12-21` no fuso, para devolver ao formulário sem deslocar o dia. */
export function formatZonedDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
