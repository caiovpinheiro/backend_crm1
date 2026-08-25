/**
 * Regra ÚNICA de elegibilidade da Distribuição Inteligente.
 *
 * Esta é a fonte de verdade usada por TODOS os consumidores: a tela
 * (`getDistributionResponsibles`), a simulação (`simulateDistribution`), a
 * distribuição real e a automação (`executeDistribution`). Mantê-la aqui,
 * pura e sem IO, garante que o que a tela mostra é exatamente o que o motor
 * decide.
 *
 * Estados (não se misturam — alinhado à UI):
 *  - `INACTIVE`             → bloqueio administrativo (`participates = false`).
 *  - `ON_PAUSE`             → pausa temporária (`paused = true` OU AgentStatus AWAY).
 *  - `OFFLINE`              → presença offline (AgentStatus OFFLINE OU sem registro).
 *  - `OUTSIDE_WORKING_HOURS`→ fora do expediente (AgentSchedule).
 *  - `PRE_LUNCH`            → pré-almoço / almoço (`lunchStart - N` até `lunchEnd`).
 *  - `PRE_END`              → pré-fim de expediente (`endTime - N` até `endTime`).
 *  - `QUEUE_LIMIT_REACHED`  → fila cheia (`filaAtual >= queueLimit`; 0 = não recebe).
 *  - `TYPE_INCOMPATIBLE`    → tipo/segmento do responsável != tipo solicitado.
 *
 * Compatibilidade: a lógica de presença/expediente espelha o legado
 * `isAgentAvailable` (sem registro de AgentStatus = disponível; sem
 * AgentSchedule = sem restrição de horário).
 */

import type { AgentOnlineStatus } from "@prisma/client";

export type DistributionBlockReason =
  | "INACTIVE"
  | "OFFLINE"
  | "ON_PAUSE"
  | "OUTSIDE_WORKING_HOURS"
  | "PRE_LUNCH"
  | "PRE_END"
  | "QUEUE_LIMIT_REACHED"
  | "TYPE_INCOMPATIBLE"
  | "DEPARTMENT_MISMATCH";

/** Subconjunto do AgentSchedule necessário para o cálculo de expediente. */
export interface ScheduleLike {
  startTime: string;
  lunchStart: string;
  lunchEnd: string;
  endTime: string;
  timezone: string;
  weekdays: number[];
  /**
   * Expediente de SÁBADO por consultor. Quando `saturdayEnabled` e hoje é
   * sábado, a elegibilidade usa `[saturdayStart, saturdayEnd)` (sem almoço),
   * ignorando `weekdays`. Desligado/ausente = sábado fora do expediente.
   */
  saturdayEnabled?: boolean;
  saturdayStart?: string;
  saturdayEnd?: string;
}

export interface ResponsibleEligibilityInput {
  /** Status administrativo: false = INATIVO. */
  participates: boolean;
  /** Pausa temporária dedicada. */
  paused: boolean;
  /** Teto da fila. 0 = não recebe (fila já está no limite). */
  queueLimit: number;
  /** Tipo/segmento opcional do responsável. */
  type: string | null;
  /** Presença operacional. `null` = sem registro (tratado como ONLINE). */
  status: AgentOnlineStatus | null;
  /** Expediente. `null` = sem restrição de horário. */
  schedule: ScheduleLike | null;
  /**
   * Minutos de antecedência aplicados ao almoço E ao fim do expediente.
   * 0 = só bloqueia no intervalo `[lunchStart, lunchEnd)` (sem pré-corte
   * nem pré-fim). Default 30 quando omitido.
   */
  preLunchStopMinutes?: number;
  /** Fila atual (deals OPEN com este owner). */
  queueCount: number;
  /**
   * Distribuição por departamento: `false` bloqueia com `DEPARTMENT_MISMATCH`
   * (responsável não é membro do departamento-alvo). `true` quando o modo
   * está desligado ou o usuário pertence ao departamento — sem restrição.
   */
  inDepartment?: boolean;
}

export interface EligibilityContext {
  /** Tipo/segmento solicitado pela distribuição (para `TYPE_INCOMPATIBLE`). */
  distributionType?: string | null;
  /** Momento de referência (testes/simulação). Default: agora. */
  now?: Date;
}

export interface EligibilityResult {
  eligible: boolean;
  blockedReasons: DistributionBlockReason[];
}

/** "HH:MM" → minutos desde a meia-noite. */
function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function clockPartsForTimezone(
  timezone: string,
  now: Date,
): { currentWeekday: number; currentMinutes: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
  const currentWeekday = WEEKDAY_MAP[weekdayStr] ?? now.getDay();
  const currentMinutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);
  return { currentWeekday, currentMinutes };
}

function localClockParts(
  schedule: ScheduleLike,
  now: Date,
): { currentWeekday: number; currentMinutes: number } {
  return clockPartsForTimezone(schedule.timezone, now);
}

/**
 * True se `now` está no intervalo `[lunchStart - N, lunchEnd)`.
 * `N = preLunchStopMinutes` (0 = só o almoço).
 */
export function isInPreLunchOrLunchWindow(
  schedule: ScheduleLike,
  now: Date,
  preLunchStopMinutes = 30,
): boolean {
  const { currentWeekday, currentMinutes } = localClockParts(schedule, now);
  if (!schedule.weekdays.includes(currentWeekday)) return false;

  const lunchStartMinutes = parseTime(schedule.lunchStart);
  const lunchEndMinutes = parseTime(schedule.lunchEnd);
  const n = Math.max(0, Math.floor(preLunchStopMinutes));
  const cutoff = lunchStartMinutes - n;

  return currentMinutes >= cutoff && currentMinutes < lunchEndMinutes;
}

/**
 * True se `now` está no intervalo `[endTime - N, endTime)`.
 * Mesmo `N` do pré-almoço (`preLunchStopMinutes`). 0 = desliga o pré-fim
 * (o bloqueio duro em `endTime` continua via `OUTSIDE_WORKING_HOURS`).
 */
export function isInPreEndWindow(
  schedule: ScheduleLike,
  now: Date,
  preEndStopMinutes = 30,
): boolean {
  const n = Math.max(0, Math.floor(preEndStopMinutes));
  if (n <= 0) return false;

  const { currentWeekday, currentMinutes } = localClockParts(schedule, now);
  if (!schedule.weekdays.includes(currentWeekday)) return false;

  const endMinutes = parseTime(schedule.endTime);
  const cutoff = endMinutes - n;
  return currentMinutes >= cutoff && currentMinutes < endMinutes;
}

/**
 * True se `now` está dentro do expediente do `schedule` (timezone-aware,
 * respeitando dias da semana e intervalo de almoço). Espelha o legado
 * `isAgentAvailable`. Não aplica o corte pré-almoço / pré-fim — use
 * `isInPreLunchOrLunchWindow` / `isInPreEndWindow` /
 * `evaluateResponsibleEligibility`.
 */
export function isWithinWorkingHours(schedule: ScheduleLike, now: Date): boolean {
  const { currentWeekday, currentMinutes } = localClockParts(schedule, now);

  if (!schedule.weekdays.includes(currentWeekday)) return false;

  const startMinutes = parseTime(schedule.startTime);
  const endMinutes = parseTime(schedule.endTime);
  const lunchStartMinutes = parseTime(schedule.lunchStart);
  const lunchEndMinutes = parseTime(schedule.lunchEnd);

  if (currentMinutes < startMinutes || currentMinutes >= endMinutes) return false;
  if (currentMinutes >= lunchStartMinutes && currentMinutes < lunchEndMinutes) {
    return false;
  }
  return true;
}

/**
 * Avalia a elegibilidade de um responsável. Retorna `eligible` + a lista
 * completa de `blockedReasons` (não para no primeiro motivo — a tela mostra
 * todos). Função pura: receba os dados já carregados.
 */
export function evaluateResponsibleEligibility(
  input: ResponsibleEligibilityInput,
  ctx: EligibilityContext = {},
): EligibilityResult {
  const reasons: DistributionBlockReason[] = [];
  const now = ctx.now ?? new Date();

  if (!input.participates) reasons.push("INACTIVE");

  // Presença REAL: sem registro de AgentStatus = OFFLINE. O responsável só
  // é elegível se ficou online de propósito (PUT /api/agents/[id]/status).
  const status: AgentOnlineStatus = input.status ?? "OFFLINE";
  if (input.paused || status === "AWAY") {
    reasons.push("ON_PAUSE");
  } else if (status === "OFFLINE") {
    reasons.push("OFFLINE");
  }

  if (input.schedule) {
    const sched = input.schedule;
    const { currentWeekday } = clockPartsForTimezone(sched.timezone, now);

    if (currentWeekday === 6) {
      // Sábado: janela própria por consultor (sem almoço/pré-corte). Ligado e
      // fora do intervalo, ou desligado → OUTSIDE_WORKING_HOURS.
      if (sched.saturdayEnabled && sched.saturdayStart && sched.saturdayEnd) {
        const { currentMinutes } = clockPartsForTimezone(sched.timezone, now);
        const startMinutes = parseTime(sched.saturdayStart);
        const endMinutes = parseTime(sched.saturdayEnd);
        if (currentMinutes < startMinutes || currentMinutes >= endMinutes) {
          reasons.push("OUTSIDE_WORKING_HOURS");
        }
      } else {
        reasons.push("OUTSIDE_WORKING_HOURS");
      }
    } else {
      const n = input.preLunchStopMinutes ?? 30;
      if (isInPreLunchOrLunchWindow(sched, now, n)) {
        reasons.push("PRE_LUNCH");
      } else if (isInPreEndWindow(sched, now, n)) {
        reasons.push("PRE_END");
      } else if (!isWithinWorkingHours(sched, now)) {
        reasons.push("OUTSIDE_WORKING_HOURS");
      }
    }
  }

  if (input.queueCount >= input.queueLimit) {
    reasons.push("QUEUE_LIMIT_REACHED");
  }

  const requested = ctx.distributionType?.trim();
  const ownType = input.type?.trim();
  if (requested && ownType && ownType !== requested) {
    reasons.push("TYPE_INCOMPATIBLE");
  }

  // Distribuição por departamento: só bloqueia quando explicitamente marcado
  // como fora do departamento-alvo (undefined = modo desligado = sem restrição).
  if (input.inDepartment === false) {
    reasons.push("DEPARTMENT_MISMATCH");
  }

  return { eligible: reasons.length === 0, blockedReasons: reasons };
}
