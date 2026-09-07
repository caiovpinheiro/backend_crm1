/**
 * Política quando não há consultor humano elegível.
 *
 * Fonte de verdade: configuração do agente — `inboxPolicy`
 * (`humanAttendanceHours`, `queueMessage`, …) e, na falta dela, o
 * `businessHours` da Pilotagem. Sem nada configurado, cai no default do
 * código (seg–sex 8h–19h, sáb 9h–16h, pausa 30 min antes do fim,
 * America/Sao_Paulo) — o texto e o horário que já estavam em produção.
 */

import {
  isWithinBusinessHours,
  normalizeBusinessHours,
  type BusinessHoursConfig,
} from "@/lib/ai-agents/piloting";
import type { InboxPolicy } from "@/lib/ai-agents/steering";

export type HumanQueueContext = {
  businessHours?: BusinessHoursConfig | null;
  /// Texto fixo de fila (Pilotagem). Se preenchido, vale em qualquer horário.
  handoffMessage?: string | null;
  /// Texto só quando o expediente humano está fechado.
  offHoursMessage?: string | null;
  /// Horário em que há atendente humano (tem prioridade sobre `businessHours`).
  humanHours?: BusinessHoursConfig | null;
  /// Minutos antes do fim em que a fila para de oferecer consultor.
  preEndMinutes?: number | null;
  /// Texto de "você está na fila". `null` = padrão.
  queueMessage?: string | null;
  /// Texto de "já tem consultor responsável". `null` = padrão.
  assignedConsultantMessage?: string | null;
  /// Texto do aviso de áudio que dispara transferência. `null` = padrão.
  audioHandoffMessage?: string | null;
  /// Termos extras que contam como pedido de atendente humano.
  humanRequestKeywords?: string[];
};

/** Monta o contexto de fila a partir da configuração do agente. */
export function humanQueueContextFromAgent(input: {
  inboxPolicy?: InboxPolicy | null;
  businessHours?: unknown;
}): HumanQueueContext {
  const p = input.inboxPolicy ?? null;
  return {
    businessHours: normalizeBusinessHours(input.businessHours ?? null),
    handoffMessage: p?.handoffMessage ?? null,
    humanHours: p?.humanAttendanceHours ?? null,
    preEndMinutes: p?.humanAttendancePreEndMinutes ?? null,
    queueMessage: p?.queueMessage ?? null,
    assignedConsultantMessage: p?.assignedConsultantMessage ?? null,
    audioHandoffMessage: p?.audioHandoffMessage ?? null,
    humanRequestKeywords: p?.humanRequestKeywords ?? [],
  };
}

/** Fuso default quando o agente não configura horário. */
export const HUMAN_ATTENDANCE_DEFAULT_TZ = "America/Sao_Paulo";

/** Fim oficial do expediente em dias úteis (hora cheia). */
export const HUMAN_ATTENDANCE_END_HOUR = 19;
/** Fim oficial do expediente no sábado (hora cheia). */
export const HUMAN_ATTENDANCE_SATURDAY_END_HOUR = 16;
/** Minutos de pausa na fila antes da saída (não oferece lead perto do fim). */
export const HUMAN_ATTENDANCE_PRE_END_MINUTES = 30;

const HOURS_FOOTER_TEXT =
  "segunda a sexta das 8h às 19h e sábado das 9h às 16h";

/** Aceita o `businessHours` cru (compatibilidade) ou o contexto completo. */
type HoursArg = BusinessHoursConfig | HumanQueueContext | null | undefined;

function asContext(arg: HoursArg): HumanQueueContext {
  if (!arg) return {};
  // `BusinessHoursConfig` tem `enabled`; o contexto de fila, não.
  if ("enabled" in arg) return { businessHours: arg };
  return arg;
}

type DaySlot = { startMin: number; endMin: number };

type Schedule = {
  timezone: string;
  /// Índice = dia da semana (0=Dom). Dia sem slot = fechado.
  days: DaySlot[][];
  preEndMinutes: number;
  /// `true` quando ninguém configurou nada e vale o texto legado.
  isDefault: boolean;
};

function hhmmToMin(v: string): number {
  const [h, m] = v.split(":");
  return Number(h) * 60 + Number(m);
}

const DEFAULT_DAYS: DaySlot[][] = [
  [],
  [{ startMin: 8 * 60, endMin: HUMAN_ATTENDANCE_END_HOUR * 60 }],
  [{ startMin: 8 * 60, endMin: HUMAN_ATTENDANCE_END_HOUR * 60 }],
  [{ startMin: 8 * 60, endMin: HUMAN_ATTENDANCE_END_HOUR * 60 }],
  [{ startMin: 8 * 60, endMin: HUMAN_ATTENDANCE_END_HOUR * 60 }],
  [{ startMin: 8 * 60, endMin: HUMAN_ATTENDANCE_END_HOUR * 60 }],
  [{ startMin: 9 * 60, endMin: HUMAN_ATTENDANCE_SATURDAY_END_HOUR * 60 }],
];

/**
 * Horário efetivo do atendente humano.
 *
 * Precedência: `inboxPolicy.humanAttendanceHours` → `businessHours` do
 * agente → default do código. A pausa pré-fim só se aplica por conta
 * própria no default (com horário configurado, o fim é o que o operador
 * escreveu) — configurar `preEndMinutes` liga a pausa em qualquer caso.
 */
function resolveSchedule(ctx: HumanQueueContext): Schedule {
  const configured =
    (ctx.humanHours?.enabled ? ctx.humanHours : null) ??
    (normalizeBusinessHours(ctx.businessHours ?? null)?.enabled
      ? normalizeBusinessHours(ctx.businessHours ?? null)
      : null);

  if (!configured) {
    return {
      timezone: HUMAN_ATTENDANCE_DEFAULT_TZ,
      days: DEFAULT_DAYS,
      preEndMinutes: ctx.preEndMinutes ?? HUMAN_ATTENDANCE_PRE_END_MINUTES,
      isDefault: true,
    };
  }

  const days: DaySlot[][] = [[], [], [], [], [], [], []];
  for (const slot of configured.weekdays) {
    days[slot.day]?.push({
      startMin: hhmmToMin(slot.start),
      endMin: hhmmToMin(slot.end),
    });
  }
  for (const list of days) list.sort((a, b) => a.startMin - b.startMin);
  return {
    timezone: configured.timezone || HUMAN_ATTENDANCE_DEFAULT_TZ,
    days,
    preEndMinutes: ctx.preEndMinutes ?? 0,
    isDefault: false,
  };
}

function normalizeMsg(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const WEEKDAY_LABEL_PT = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

function clockIn(
  timezone: string,
  now = new Date(),
): { day: number; hour: number; minute: number } {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(now);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return {
    day: WEEKDAY_INDEX[weekday] ?? 0,
    hour: hour === 24 ? 0 : hour,
    minute,
  };
}

/** Minuto-do-dia em que a janela fecha (fim − pausa pré-fim). */
export function humanAttendanceEffectiveEndMinutes(
  now = new Date(),
  hours?: HoursArg,
): number {
  const schedule = resolveSchedule(asContext(hours));
  const { day } = clockIn(schedule.timezone, now);
  const slots = schedule.days[day] ?? [];
  if (slots.length === 0) return 0;
  const last = slots[slots.length - 1];
  return last.endMin - schedule.preEndMinutes;
}

function formatStartLabel(startMin: number): string {
  const h = Math.floor(startMin / 60);
  const m = startMin % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

/**
 * Próximo horário de início do atendimento humano.
 * Considera manhã (ainda não abriu) e noite (já fechou / pausa pré-fim).
 */
export function humanAttendanceStartHint(
  now = new Date(),
  hours?: HoursArg,
): {
  startHour: number;
  startLabel: string;
  dayLabel: string;
} {
  const schedule = resolveSchedule(asContext(hours));
  const { day, hour, minute } = clockIn(schedule.timezone, now);
  const mins = hour * 60 + minute;
  const todaySlots = schedule.days[day] ?? [];
  const todayHasWindow = todaySlots.length > 0;

  const todayLabel = day === 6 ? "hoje (sábado)" : "hoje";

  // Sem horário configurado vale o texto legado, inclusive a sexta-feira
  // que aponta para segunda em vez de sábado. Trocar isso mudaria a frase
  // que o cliente lê hoje em produção sem ninguém ter pedido.
  if (schedule.isDefault) {
    const endMins = humanAttendanceEffectiveEndMinutes(now, hours);
    if (day === 0) {
      return { startHour: 8, startLabel: "8h", dayLabel: "segunda-feira" };
    }
    if (day === 6) {
      if (mins < 9 * 60 || mins < endMins) {
        return { startHour: 9, startLabel: "9h", dayLabel: "hoje (sábado)" };
      }
      return { startHour: 8, startLabel: "8h", dayLabel: "segunda-feira" };
    }
    if (mins < 8 * 60) {
      return { startHour: 8, startLabel: "8h", dayLabel: "hoje" };
    }
    if (mins >= endMins) {
      return {
        startHour: 8,
        startLabel: "8h",
        dayLabel: day === 5 ? "segunda-feira" : "amanhã",
      };
    }
    return { startHour: 8, startLabel: "8h", dayLabel: "hoje" };
  }

  if (todayHasWindow) {
    const first = todaySlots[0];
    const effectiveEnd =
      todaySlots[todaySlots.length - 1].endMin - schedule.preEndMinutes;
    if (mins < first.startMin || mins < effectiveEnd) {
      return {
        startHour: Math.floor(first.startMin / 60),
        startLabel: formatStartLabel(first.startMin),
        dayLabel: todayLabel,
      };
    }
  }

  for (let step = 1; step <= 7; step++) {
    const idx = (day + step) % 7;
    const slots = schedule.days[idx] ?? [];
    if (slots.length === 0) continue;
    // Domingo (dia sem expediente) sempre nomeia o dia — "amanhã" só vale
    // quando hoje é dia de atendimento e ele já terminou.
    const label =
      step === 1 && todayHasWindow ? "amanhã" : WEEKDAY_LABEL_PT[idx];
    return {
      startHour: Math.floor(slots[0].startMin / 60),
      startLabel: formatStartLabel(slots[0].startMin),
      dayLabel: label,
    };
  }

  // Horário configurado sem nenhum slot: não há retomada para prometer.
  return { startHour: 0, startLabel: "0h", dayLabel: todayLabel };
}

/**
 * True se o expediente humano está aberto.
 * Com horário configurado no agente, usa os slots dele.
 */
export function isHumanAttendanceWindowOpen(
  now = new Date(),
  hours?: HoursArg,
): boolean {
  const ctx = asContext(hours);
  const schedule = resolveSchedule(ctx);
  if (!schedule.isDefault && schedule.preEndMinutes === 0) {
    // Sem pausa pré-fim, `isWithinBusinessHours` é a fonte única (mesma
    // semântica que o wizard mostra ao operador).
    const configured =
      (ctx.humanHours?.enabled ? ctx.humanHours : null) ??
      normalizeBusinessHours(ctx.businessHours ?? null);
    return isWithinBusinessHours(configured ?? null, now);
  }
  const { day, hour, minute } = clockIn(schedule.timezone, now);
  const slots = schedule.days[day] ?? [];
  if (slots.length === 0) return false;
  const mins = hour * 60 + minute;
  return slots.some(
    (s) => mins >= s.startMin && mins < s.endMin - schedule.preEndMinutes,
  );
}

/** "segunda a sexta das 8h às 19h e sábado das 9h às 16h" (ou o configurado). */
function hoursText(ctx: HumanQueueContext): string {
  const schedule = resolveSchedule(ctx);
  if (schedule.isDefault) return HOURS_FOOTER_TEXT;
  const parts: string[] = [];
  schedule.days.forEach((slots, idx) => {
    for (const s of slots) {
      parts.push(
        `${WEEKDAY_LABEL_PT[idx]} das ${formatStartLabel(s.startMin)} às ${formatStartLabel(s.endMin)}`,
      );
    }
  });
  if (parts.length === 0) return HOURS_FOOTER_TEXT;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

function hoursFooter(now = new Date(), ctx: HumanQueueContext = {}): string {
  const text = hoursText(ctx);
  if (isHumanAttendanceWindowOpen(now, ctx)) {
    return (
      `Assim que um(a) consultor(a) puder, te atendem ` +
      `(expediente: ${text}).`
    );
  }
  const { startLabel, dayLabel } = humanAttendanceStartHint(now, ctx);
  return (
    `O atendimento humano retoma às *${startLabel}* ${dayLabel} ` +
    `(${text}).`
  );
}

export function buildHumanUnavailableOfferMessage(
  now = new Date(),
  ctx?: HumanQueueContext,
): string {
  const custom = ctx?.handoffMessage?.trim();
  if (custom) return custom;

  const open = isHumanAttendanceWindowOpen(now, ctx);
  if (!open) {
    const off = ctx?.offHoursMessage?.trim();
    if (off) return off;
  }

  if (open) {
    return (
      `Combinado — já pedi para a equipe te atender. Assim que um(a) ` +
      `consultor(a) puder, continua com você por aqui, tá? ` +
      `Enquanto isso, se quiser tirar alguma dúvida, *estou aqui* contigo. ` +
      `Se preferir só esperar com calma, também tudo bem — me avisa 💛`
    );
  }
  if (!resolveSchedule(ctx ?? {}).isDefault) {
    return (
      `Combinado — já registrei seu pedido com a equipe. O atendimento ` +
      `humano retoma no próximo expediente. Enquanto isso, se quiser ` +
      `tirar alguma dúvida, *estou aqui* contigo. Se preferir só esperar, ` +
      `também tudo bem — me avisa 💛`
    );
  }
  const { startLabel, dayLabel } = humanAttendanceStartHint(now, ctx);
  return (
    `Combinado — já registrei seu pedido com a equipe. O atendimento humano ` +
    `retoma às *${startLabel}* ${dayLabel} ` +
    `(${HOURS_FOOTER_TEXT}). ` +
    `Enquanto isso, se quiser tirar alguma dúvida, *estou aqui* contigo. ` +
    `Se preferir só esperar, também tudo bem — me avisa 💛`
  );
}

export function buildHumanQueueWithHoursMessage(
  now = new Date(),
  ctx?: HumanQueueContext,
): string {
  const custom = ctx?.queueMessage?.trim();
  if (custom) return custom;
  return (
    `Combinado! Você já está na *fila* do atendimento humano. ` +
    `${hoursFooter(now, ctx ?? {})}`
  );
}

/**
 * Hint devolvido ao modelo quando o lead entra na fila. Cita o horário
 * configurado no agente — o texto trazia "seg–sex 8h–19h, sáb 9h–16h"
 * escrito no código de tools.ts.
 */
export function buildQueuedWaitingHint(ctx?: HumanQueueContext): string {
  const schedule = resolveSchedule(ctx ?? {});
  const window = schedule.isDefault
    ? "antes das 8h/9h ou a partir das 18h30"
    : "fora do horário da equipe";
  return (
    "Lead na fila (sem consultor elegível agora). Avise UMA vez com empatia: " +
    `já registrou o pedido. Fora do expediente (${window}) diga que o ` +
    `atendimento humano retoma no horário (${hoursText(ctx ?? {})}). ` +
    "Dentro do expediente: NÃO diga 'ninguém disponível' nem 'em breve' — " +
    "diga que a equipe continua quando puder. Ofereça continuar ajudando. NÃO repita."
  );
}

/** Aviso quando a conversa já foi atribuída a um consultor (não depender da automação). */
export function buildAssignedConsultantNotice(
  ctx?: HumanQueueContext,
): string {
  const custom = ctx?.assignedConsultantMessage?.trim();
  if (custom) return custom;
  return (
    "Já te passei para um *consultor* da equipe. Ele continua daqui — " +
    "pode levar um pouquinho, mas seu pedido já está com alguém, tá? 💛"
  );
}

/** Pedido explícito de fila / humano / consultor / distribuição. */
export function userWantsHumanDistribution(
  userMessage: string,
  ctx?: HumanQueueContext,
): boolean {
  const n = normalizeMsg(userMessage);
  if (!n) return false;
  for (const extra of ctx?.humanRequestKeywords ?? []) {
    const needle = normalizeMsg(extra);
    if (needle && n.includes(needle)) return true;
  }
  if (
    /\b(atendente|humano|consultor|consultora|atendimento humano)\b/.test(n)
  ) {
    return true;
  }
  if (
    /falar com (alguem|atendente|humano|consultor)|quero (um )?atendente|passar (para|pro) (humano|atendente|consultor)/.test(
      n,
    )
  ) {
    return true;
  }
  if (
    /\b(fila|aguardar (o )?consultor|espera(r)? (o )?consultor|distribu)/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}

/** Aluno pede para a IA continuar (após oferta de indisponibilidade). */
export function userWantsAiContinue(
  userMessage: string,
  ctx?: HumanQueueContext,
): boolean {
  const n = normalizeMsg(userMessage);
  if (!n) return false;
  if (userWantsHumanDistribution(userMessage, ctx)) return false;
  return (
    /pode continuar|continua(r)?( me)? (ajud|atend)|voce (pode )?ajud|quero (sua |a )?ajuda|pode me ajudar|consegue( me)? ajud|me ajuda|me ajudar|pode ajudar|segue( comigo)?|pode sim|quero (que )?voce/.test(
      n,
    ) ||
    /^(pode|quero|sim|continuar|continua)[\s!.]*$/.test(n)
  );
}

/** Mensagens já usadas neste fluxo (dedupe). */
export const HUMAN_QUEUE_MSG_PATTERNS = [
  "já pedi para a equipe",
  "ja pedi para a equipe",
  "já pedi para um(a) consultor",
  "ja pedi para um(a) consultor",
  "já registrei seu pedido",
  "ja registrei seu pedido",
  "estou aqui contigo",
  "em breve alguém da equipe",
  "o atendimento humano retoma",
  "já te encaminhei para a equipe",
  "ja te encaminhei para a equipe",
  "já te deixei na fila",
  "ja te deixei na fila",
  "assim que estiver livre",
  "atendimento humano está indisponível",
  "atendimento humano esta indisponivel",
  "nenhum consultor elegivel",
  "nenhum consultor elegível",
  "ninguém está disponível",
  "ninguem esta disponivel",
  "eu posso continuar",
  "já está na fila",
  "ja esta na fila",
  "expediente inicia",
  "atendimento humano inicia",
  "segunda a sexta às 8h",
  "segunda a sexta as 8h",
  "segunda a sexta das 8h",
  "a partir das 8h",
  "só mais um pouquinho",
  "so mais um pouquinho",
  "fala com você em breve",
  "fala com voce em breve",
  "vou te conectar",
  "já te passei para um consultor",
  "ja te passei para um consultor",
  "passei para um consultor",
  "seu pedido já está com alguém",
  "seu pedido ja esta com alguem",
] as const;

export function messageLooksLikeHumanQueueNotice(
  content: string | null | undefined,
): boolean {
  if (!content) return false;
  const n = normalizeMsg(content);
  return HUMAN_QUEUE_MSG_PATTERNS.some((p) => n.includes(normalizeMsg(p)));
}

/** Normaliza texto para comparação de near-duplicate. */
export function normalizeForDedupe(raw: string): string {
  return normalizeMsg(raw).replace(/[^\p{L}\p{N}\s]/gu, "");
}

/**
 * True se `candidate` é praticamente a mesma informação de `existing`
 * (template de fila/conexão ou overlap alto de tokens).
 */
export function isNearDuplicateBotText(
  candidate: string,
  existing: string,
): boolean {
  const a = normalizeForDedupe(candidate);
  const b = normalizeForDedupe(existing);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    if (shorter >= 40 && shorter / longer >= 0.7) return true;
  }
  const queueA = messageLooksLikeHumanQueueNotice(candidate);
  const queueB = messageLooksLikeHumanQueueNotice(existing);
  if (queueA && queueB) return true;
  if (a.includes("vou te conectar") && b.includes("vou te conectar")) {
    return true;
  }
  const ta = new Set(a.split(" ").filter((w) => w.length > 2));
  const tb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.7;
}
