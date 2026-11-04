/**
 * Regras de horário por departamento do modo "leads" (Distribuição por Leads).
 *
 * Com a setting `distribution.leads.departmentRules.enabled` ligada, só os
 * membros (`DepartmentMember`) de um departamento com regra HABILITADA e
 * ATIVA no instante da distribuição entram no sorteio do motor leads. Um
 * departamento sem regra habilitada não participa. Quem é membro de vários
 * departamentos entra uma vez (conjunto de userIds).
 *
 * Horários em minutos do dia em `America/Sao_Paulo`, pelo relógio do
 * servidor. `startMinute > endMinute` = intervalo que cruza a meia-noite; o
 * dia da semana da regra é o do INÍCIO (seg 22:00–02:00 vale às 01:00 de
 * terça). Setting desligada = motor idêntico ao anterior.
 *
 * Nada aqui é lido pela Distribuição Inteligente (`smart`).
 */

import { getOrgSettingBoolFresh } from "@/lib/org-settings";
import type { ScopedTx } from "@/lib/prisma";

export const LEADS_DEPARTMENT_RULES_ENABLED_KEY =
  "distribution.leads.departmentRules.enabled";
export const LEADS_RULES_TIMEZONE = "America/Sao_Paulo";
export const MINUTES_PER_DAY = 1440;

export interface LeadsDepartmentRuleWindow {
  startMinute: number;
  endMinute: number;
  /** 0 = domingo … 6 = sábado (dia do início do intervalo). */
  weekdays: number[];
  enabled: boolean;
}

export interface LocalClock {
  /** 0 = domingo … 6 = sábado. */
  weekday: number;
  /** Minutos desde a meia-noite local (0..1439). */
  minute: number;
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

/** Dia da semana e minuto do dia de `now` em America/Sao_Paulo. */
export function localClock(now: Date, timeZone = LEADS_RULES_TIMEZONE): LocalClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAY_INDEX[get("weekday")] ?? now.getUTCDay();
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    weekday,
    minute: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

export async function isLeadsDepartmentRulesEnabled(): Promise<boolean> {
  try {
    return (await getOrgSettingBoolFresh(LEADS_DEPARTMENT_RULES_ENABLED_KEY, false)) === true;
  } catch {
    return false;
  }
}

/** `[start, end)` no mesmo dia, ou cruzando a meia-noite quando start > end. */
export function isRuleActiveAt(rule: LeadsDepartmentRuleWindow, clock: LocalClock): boolean {
  if (!rule.enabled) return false;
  if (!rule.weekdays.length) return false;
  const { startMinute: start, endMinute: end } = rule;
  if (start === end) return false;
  if (start < end) {
    return rule.weekdays.includes(clock.weekday) && clock.minute >= start && clock.minute < end;
  }
  // Cruza a meia-noite: a parte de hoje (>= start) conta no dia de hoje;
  // a parte da madrugada (< end) conta no dia anterior (dia do início).
  if (clock.minute >= start) return rule.weekdays.includes(clock.weekday);
  if (clock.minute < end) return rule.weekdays.includes((clock.weekday + 6) % 7);
  return false;
}

export function isAnyRuleActiveAt(
  rules: readonly LeadsDepartmentRuleWindow[],
  clock: LocalClock,
): boolean {
  return rules.some((r) => isRuleActiveAt(r, clock));
}

/**
 * Próxima mudança de estado (ativa ↔ inativa) do conjunto de regras de um
 * departamento, olhando até 7 dias à frente, minuto a minuto no relógio
 * local. Devolve `null` quando o estado não muda na semana (sem regra
 * habilitada, ou regra 24x7).
 */
export function nextTransition(
  rules: readonly LeadsDepartmentRuleWindow[],
  now: Date,
  timeZone = LEADS_RULES_TIMEZONE,
): { at: Date; becomesActive: boolean } | null {
  const active = rules.filter((r) => r.enabled && r.weekdays.length && r.startMinute !== r.endMinute);
  if (!active.length) return null;
  const startClock = localClock(now, timeZone);
  const current = isAnyRuleActiveAt(active, startClock);
  // Avança a partir do próximo minuto cheio.
  const base = new Date(now);
  base.setUTCSeconds(0, 0);
  const limit = 7 * MINUTES_PER_DAY;
  for (let i = 1; i <= limit; i++) {
    const at = new Date(base.getTime() + i * 60_000);
    const state = isAnyRuleActiveAt(active, localClock(at, timeZone));
    if (state !== current) return { at, becomesActive: state };
  }
  return null;
}

export interface LeadsDepartmentRuleInput {
  departmentId: string;
  startMinute: number;
  endMinute: number;
  weekdays: number[];
  enabled: boolean;
}

/** Valida e normaliza o corpo de criação/edição. Devolve a mensagem de erro ou a regra. */
export function parseLeadsDepartmentRuleInput(
  raw: unknown,
  opts: { partial?: boolean } = {},
): { ok: true; value: Partial<LeadsDepartmentRuleInput> } | { ok: false; message: string } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Partial<LeadsDepartmentRuleInput> = {};

  if (o.departmentId !== undefined || !opts.partial) {
    if (typeof o.departmentId !== "string" || !o.departmentId.trim()) {
      return { ok: false, message: "Informe o departamento." };
    }
    out.departmentId = o.departmentId.trim();
  }
  for (const key of ["startMinute", "endMinute"] as const) {
    if (o[key] !== undefined || !opts.partial) {
      const n = Number(o[key]);
      if (!Number.isInteger(n) || n < 0 || n >= MINUTES_PER_DAY) {
        return {
          ok: false,
          message:
            key === "startMinute"
              ? "Hora inicial inválida (00:00 a 23:59)."
              : "Hora final inválida (00:00 a 23:59).",
        };
      }
      out[key] = n;
    }
  }
  if (o.weekdays !== undefined || !opts.partial) {
    if (!Array.isArray(o.weekdays)) {
      return { ok: false, message: "Selecione ao menos um dia da semana." };
    }
    const raw = o.weekdays.map((d) => Number(d));
    if (raw.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return { ok: false, message: "Dia da semana inválido (0 = domingo … 6 = sábado)." };
    }
    const days = [...new Set(raw)].sort((a, b) => a - b);
    if (!days.length) {
      return { ok: false, message: "Selecione ao menos um dia da semana." };
    }
    out.weekdays = days;
  }
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== "boolean") {
      return { ok: false, message: "Informe enabled (boolean)." };
    }
    out.enabled = o.enabled;
  } else if (!opts.partial) {
    out.enabled = true;
  }
  if (
    out.startMinute !== undefined &&
    out.endMinute !== undefined &&
    out.startMinute === out.endMinute
  ) {
    return { ok: false, message: "Hora inicial e final não podem ser iguais." };
  }
  return { ok: true, value: out };
}

/** `"09:00"` → 540. Inválido → null. */
export function parseClockMinute(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 && raw < MINUTES_PER_DAY ? raw : null;
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Usuários elegíveis AGORA pelas regras de departamento da org: membros de
 * departamentos com regra habilitada e ativa. Conjunto (membro de vários
 * departamentos entra uma vez). Só é chamado com a setting ligada; lista
 * vazia = ninguém recebe. Roda dentro da transação do sorteio.
 */
export async function eligibleUserIdsByDepartmentRulesTx(
  tx: Pick<ScopedTx, "distributionLeadsDepartmentRule" | "departmentMember">,
  orgId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rules = await tx.distributionLeadsDepartmentRule.findMany({
    where: { organizationId: orgId, enabled: true },
    select: { departmentId: true, startMinute: true, endMinute: true, weekdays: true, enabled: true },
  });
  const clock = localClock(now);
  const activeDepartmentIds = [
    ...new Set(rules.filter((r) => isRuleActiveAt(r, clock)).map((r) => r.departmentId)),
  ];
  if (!activeDepartmentIds.length) return [];
  const members = await tx.departmentMember.findMany({
    where: { organizationId: orgId, departmentId: { in: activeDepartmentIds } },
    select: { userId: true },
  });
  return [...new Set(members.map((m) => m.userId))];
}
