/**
 * Horário de funcionamento (dias e faixas por fuso): leitura tolerante da
 * configuração e teste "está dentro do horário agora?". Usado pela política
 * de fila de pessoas e pela distribuição. Nenhum domínio de cliente.
 */

export type BusinessHoursSlot = {
  /// 0=Dom, 1=Seg, … 6=Sáb (alinhado com JS Date.getDay()).
  day: number;
  /// "HH:mm" 24h.
  start: string;
  end: string;
};

export type BusinessHoursConfig = {
  enabled: boolean;
  /// IANA timezone, ex.: "America/Sao_Paulo". Default pt-BR.
  timezone: string;
  /// Slots permitidos. Se o dia não tem slot, está fora do expediente.
  weekdays: BusinessHoursSlot[];
  /// Mensagem enviada automaticamente fora do expediente (opcional).
  offHoursMessage?: string;
};

export function normalizeBusinessHours(
  v: unknown,
): BusinessHoursConfig | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const enabled = Boolean(r.enabled);
  const timezone =
    typeof r.timezone === "string" && r.timezone.trim()
      ? r.timezone.trim()
      : "America/Sao_Paulo";
  const weekdays: BusinessHoursSlot[] = [];
  if (Array.isArray(r.weekdays)) {
    for (const raw of r.weekdays) {
      if (!raw || typeof raw !== "object") continue;
      const rr = raw as Record<string, unknown>;
      const day = Number(rr.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;
      const start =
        typeof rr.start === "string" && /^\d{1,2}:\d{2}$/.test(rr.start)
          ? padTime(rr.start)
          : null;
      const end =
        typeof rr.end === "string" && /^\d{1,2}:\d{2}$/.test(rr.end)
          ? padTime(rr.end)
          : null;
      if (!start || !end) continue;
      weekdays.push({ day, start, end });
    }
  }
  const offHoursMessage =
    typeof r.offHoursMessage === "string" && r.offHoursMessage.trim()
      ? r.offHoursMessage.trim()
      : undefined;
  return { enabled, timezone, weekdays, offHoursMessage };
}

function padTime(v: string): string {
  const [h, m] = v.split(":");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

/**
 * Retorna true se `now` (default=agora) cai dentro de pelo menos um
 * slot da configuração. Se `enabled=false`, sempre true (= aberto
 * 24/7). Conversão pra timezone configurada é feita via Intl.
 */
export function isWithinBusinessHours(
  config: BusinessHoursConfig | null,
  now: Date = new Date(),
): boolean {
  if (!config || !config.enabled) return true;
  if (config.weekdays.length === 0) return false; // enabled sem slots => sempre off
  const { day, hhmm } = getLocalDayAndTime(now, config.timezone);
  return config.weekdays.some(
    (s) => s.day === day && hhmm >= s.start && hhmm < s.end,
  );
}

function getLocalDayAndTime(
  date: Date,
  timezone: string,
): { day: number; hhmm: string } {
  try {
    // en-US nos garante ordem consistente de weekday/hora.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(date);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    const dayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return {
      day: dayMap[weekday] ?? 0,
      hhmm: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
    };
  } catch {
    // Timezone inválida — fallback local.
    return {
      day: date.getDay(),
      hhmm: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
    };
  }
}

// ── Keyword matching ─────────────────────────────────────────

/**
 * Retorna a keyword encontrada (lowercased) ou null. Match por
 * substring, case-insensitive, normalizando acentos. A lista
 * recebida pode ter espaços e pontuação — a gente só ignora vazias.
 */
