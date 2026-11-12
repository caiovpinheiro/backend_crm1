import { createHash } from "node:crypto";

/**
 * Gatilho de automação "activity_scheduled": dispara no horário da tarefa
 * (Activity.scheduledAt) ou X minutos/horas/dias antes ou depois dele.
 *
 * triggerConfig:
 *   timing        "before" | "at" | "after"
 *   offsetAmount  inteiro >= 1 (ignorado quando timing = "at")
 *   offsetUnit    "minutes" | "hours" | "days"
 *   activityType  "" = qualquer tipo; senão ActivityType (TASK, CALL, ...)
 *   includeCompleted  false = ignora tarefas já concluídas (padrão)
 */
export type ActivityScheduleTiming = "before" | "at" | "after";
export type ActivityScheduleUnit = "minutes" | "hours" | "days";

export type ActivityScheduleConfig = {
  timing: ActivityScheduleTiming;
  offsetAmount: number;
  offsetUnit: ActivityScheduleUnit;
  /** Deslocamento em ms em relação a scheduledAt (negativo = antes). */
  offsetMs: number;
  activityType: string | null;
  includeCompleted: boolean;
};

const UNIT_MS: Record<ActivityScheduleUnit, number> = {
  minutes: 60_000,
  hours: 60 * 60_000,
  days: 24 * 60 * 60_000,
};

/** Teto do deslocamento: 30 dias. */
export const ACTIVITY_SCHEDULE_MAX_OFFSET_MS = 30 * UNIT_MS.days;

/**
 * Tolerância para atraso do sweeper (deploy, restart). Tarefas cujo
 * momento de disparo passou há mais que isso não disparam — evita uma
 * enxurrada de execuções antigas ao ativar a automação.
 */
export const ACTIVITY_SCHEDULE_GRACE_MS = 15 * 60_000;

export function normalizeActivityScheduleConfig(
  raw: unknown,
): ActivityScheduleConfig | null {
  const cfg =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const timing: ActivityScheduleTiming =
    cfg.timing === "before" || cfg.timing === "after" ? cfg.timing : "at";
  const offsetUnit: ActivityScheduleUnit =
    cfg.offsetUnit === "hours" || cfg.offsetUnit === "days" ? cfg.offsetUnit : "minutes";
  const activityType =
    typeof cfg.activityType === "string" && cfg.activityType.trim()
      ? cfg.activityType.trim().toUpperCase()
      : null;
  const includeCompleted = cfg.includeCompleted === true;

  if (timing === "at") {
    return {
      timing,
      offsetAmount: 0,
      offsetUnit,
      offsetMs: 0,
      activityType,
      includeCompleted,
    };
  }

  const amount =
    typeof cfg.offsetAmount === "number"
      ? cfg.offsetAmount
      : typeof cfg.offsetAmount === "string" && cfg.offsetAmount.trim()
        ? Number(cfg.offsetAmount)
        : Number.NaN;
  if (!Number.isInteger(amount) || amount < 1) return null;
  const abs = amount * UNIT_MS[offsetUnit];
  if (abs > ACTIVITY_SCHEDULE_MAX_OFFSET_MS) return null;

  return {
    timing,
    offsetAmount: amount,
    offsetUnit,
    offsetMs: timing === "before" ? -abs : abs,
    activityType,
    includeCompleted,
  };
}

/**
 * Faixa de `scheduledAt` cujo momento de disparo (scheduledAt + offset)
 * caiu em (now - grace, now].
 */
export function activityScheduleRange(
  offsetMs: number,
  now = new Date(),
  graceMs = ACTIVITY_SCHEDULE_GRACE_MS,
): { gt: Date; lte: Date } {
  const lte = new Date(now.getTime() - offsetMs);
  return { gt: new Date(lte.getTime() - graceMs), lte };
}

/** Uma execução por automação + tarefa + horário agendado (reagendou → dispara de novo). */
export function buildActivityScheduleClaimKey(
  automationId: string,
  activityId: string,
  scheduledAt: Date,
): string {
  return createHash("sha256")
    .update(`${automationId}\0${activityId}\0${scheduledAt.toISOString()}`)
    .digest("hex");
}

const UNIT_LABEL: Record<ActivityScheduleUnit, [string, string]> = {
  minutes: ["minuto", "minutos"],
  hours: ["hora", "horas"],
  days: ["dia", "dias"],
};

export function describeActivitySchedule(raw: unknown): string {
  const cfg = normalizeActivityScheduleConfig(raw);
  if (!cfg) return "Configurar horário";
  if (cfg.timing === "at") return "No horário da tarefa";
  const [one, many] = UNIT_LABEL[cfg.offsetUnit];
  const unit = cfg.offsetAmount === 1 ? one : many;
  return `${cfg.offsetAmount} ${unit} ${cfg.timing === "before" ? "antes" : "depois"} da tarefa`;
}
