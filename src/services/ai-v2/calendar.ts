/**
 * Calendário do agente: datas e prazos como dado estruturado, fora dos
 * materiais. O motor calcula a situação de cada evento em relação a hoje
 * (já passou / hoje / em andamento / próximo) e entrega pronto ao modelo,
 * que não precisa comparar datas. Serve para qualquer agenda (prazos,
 * eventos, escala). Nenhum domínio de cliente.
 */

import type { V2CalendarEvent } from "@/lib/ai-v2/types";

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, "março": 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const MONTH_RE = "(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)";

export const CALENDAR_LIMITS = { maxEvents: 500, pastDays: 30, futureDays: 365, maxInPrompt: 80 };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const fullYear = (y: string | undefined, fallback: number) => (!y ? fallback : y.length <= 2 ? 2000 + Number(y) : Number(y));

function validIso(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3]);
}

export function formatBr(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

// ─── Leitura de texto ────────────────────────────────────────────────────

/**
 * Lê linhas "data – evento". Aceita "dd/mm/aaaa", "dd/mm", "dd/mm/aaaa a
 * dd/mm/aaaa", "dd a dd/mm/aaaa", "dd de mês de aaaa", "dd a dd de mês".
 * O que não tem data vira continuação do evento anterior ou fica em
 * `unparsed` para a pessoa revisar.
 */
export function parseCalendarText(text: string, defaultYear: number): { events: V2CalendarEvent[]; unparsed: string[] } {
  const events: V2CalendarEvent[] = [];
  const unparsed: string[] = [];
  const sep = String.raw`\s*(?:[–—:-]\s*|\s)`;
  const patterns: Array<{ re: RegExp; build: (m: RegExpExecArray) => { start: string; end?: string } | null }> = [
    { // 02/10/2026 a 05/10/2026, 11/12/2026 e 12/12/2026
      re: new RegExp(String.raw`^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:a|e|até|-|–)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?${sep}(.+)$`, "i"),
      build: (m) => {
        const y2 = fullYear(m[6], defaultYear);
        const y1 = m[3] ? fullYear(m[3], defaultYear) : Number(m[2]) > Number(m[5]) ? y2 - 1 : y2;
        return { start: iso(y1, Number(m[2]), Number(m[1])), end: iso(y2, Number(m[5]), Number(m[4])) };
      },
    },
    { // 02 a 05/10/2026, 11 e 12/12
      re: new RegExp(String.raw`^(\d{1,2})\s*(?:a|e|até|-|–)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?${sep}(.+)$`, "i"),
      build: (m) => {
        const y = fullYear(m[4], defaultYear);
        return { start: iso(y, Number(m[3]), Number(m[1])), end: iso(y, Number(m[3]), Number(m[2])) };
      },
    },
    { // 19/10/2026
      re: new RegExp(String.raw`^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?${sep}(.+)$`, "i"),
      build: (m) => ({ start: iso(fullYear(m[3], defaultYear), Number(m[2]), Number(m[1])) }),
    },
    { // 02 a 05 de outubro de 2026
      re: new RegExp(String.raw`^(\d{1,2})\s*(?:a|e|até|-|–)\s*(\d{1,2})\s+de\s+${MONTH_RE}(?:\s+de\s+(\d{4}))?${sep}(.+)$`, "i"),
      build: (m) => {
        const mo = MONTHS[m[3].toLowerCase()];
        const y = fullYear(m[4], defaultYear);
        return { start: iso(y, mo, Number(m[1])), end: iso(y, mo, Number(m[2])) };
      },
    },
    { // 19 de outubro de 2026
      re: new RegExp(String.raw`^(\d{1,2})\s+de\s+${MONTH_RE}(?:\s+de\s+(\d{4}))?${sep}(.+)$`, "i"),
      build: (m) => ({ start: iso(fullYear(m[3], defaultYear), MONTHS[m[2].toLowerCase()], Number(m[1])) }),
    },
  ];

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim().replace(/^[-•*]\s+/, "");
    if (!line) continue;
    let matched = false;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (!m) continue;
      const dates = p.build(m);
      const title = m[m.length - 1].trim().replace(/^[–—:-]\s*/, "");
      if (dates && validIso(dates.start) && (!dates.end || validIso(dates.end)) && title) {
        events.push({
          id: `ev_${events.length + 1}_${dates.start}`,
          start: dates.start,
          ...(dates.end && dates.end !== dates.start ? { end: dates.end } : {}),
          title,
        });
        matched = true;
      }
      break;
    }
    if (matched) continue;
    // Linha sem data logo depois de um evento: continuação da descrição.
    if (events.length > 0 && /^[a-zà-ú(*]/i.test(line) && !/^={2,}/.test(line)) {
      const last = events[events.length - 1];
      last.title = `${last.title} ${line}`;
      continue;
    }
    if (!/^={2,}.*={2,}$/.test(line)) unparsed.push(line);
  }
  return { events, unparsed };
}

// ─── Situação em relação a hoje ──────────────────────────────────────────

export type EventStatus = "past" | "today" | "ongoing" | "upcoming";

function todayIso(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function eventStatus(ev: V2CalendarEvent, today: string): EventStatus {
  const end = ev.end ?? ev.start;
  if (end < today) return "past";
  if (ev.start === today && end === today) return "today";
  if (ev.start <= today) return "ongoing";
  return "upcoming";
}

const STATUS_LABEL: Record<EventStatus, string> = {
  past: "já passou",
  today: "hoje",
  ongoing: "em andamento",
  upcoming: "próximo",
};

/**
 * Seção do prompt: eventos do último mês e do próximo ano, em ordem, com a
 * situação já calculada. Vazio quando o agente não tem calendário.
 */
export function calendarPromptSection(
  events: V2CalendarEvent[] | undefined,
  now: Date = new Date(),
  timezone = "America/Sao_Paulo",
): string {
  if (!events || events.length === 0) return "";
  const today = todayIso(now, timezone);
  const from = addDays(today, -CALENDAR_LIMITS.pastDays);
  const to = addDays(today, CALENDAR_LIMITS.futureDays);
  const inWindow = events
    .filter((e) => (e.end ?? e.start) >= from && e.start <= to)
    .sort((a, b) => a.start.localeCompare(b.start));
  // Cheio demais: fica o que está mais perto de hoje (passado recente + próximos).
  const past = inWindow.filter((e) => eventStatus(e, today) === "past").slice(-10);
  const rest = inWindow.filter((e) => eventStatus(e, today) !== "past").slice(0, CALENDAR_LIMITS.maxInPrompt - past.length);
  const lines = [...past, ...rest].map((e) => {
    const when = e.end ? `${formatBr(e.start)} a ${formatBr(e.end)}` : formatBr(e.start);
    return `- ${when} — ${e.title} (${STATUS_LABEL[eventStatus(e, today)]})`;
  });
  return [
    "# Calendário (datas e prazos)",
    // As regras de uso das datas ficam em "# Data de hoje", junto com as
    // datas marcadas nos trechos: um marcador e uma regra só.
    "Datas oficiais cadastradas pela empresa; a situação entre parênteses já está calculada em relação a hoje. Para \"próximo\", \"quando é\" ou \"ainda dá tempo\", responda com a data daqui.",
    ...lines,
  ].join("\n");
}
