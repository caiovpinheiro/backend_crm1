/**
 * Liberação / pausa MANUAL e TEMPORÁRIA de consultor no modo "leads".
 *
 * - Liberar (`eligible=true`): o consultor recebe lead mesmo fora do horário
 *   do departamento (ex.: hora extra das 17:00 às 22:00).
 * - Pausar (`eligible=false`): não recebe, mesmo no horário.
 *
 * Vale de `startsAt` até `endsAt` (exclusivo). Depois some sozinha e volta a
 * regra do departamento. Uma por consultor: criar outra encerra a anterior.
 * Continua exigindo participante ACTIVE com peso > 0 — a liberação só tira
 * a restrição de horário. A pausa vale mesmo com as regras desligadas.
 *
 * Nada aqui é lido pela Distribuição Inteligente (`smart`).
 */

import { prisma, type ScopedTx } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

import { LEADS_RULES_TIMEZONE, localClock, MINUTES_PER_DAY, parseClockMinute } from "./department-rules";

export interface LeadsEligibilityOverrideWindow {
  userId: string;
  eligible: boolean;
  startsAt: Date;
  endsAt: Date;
}

export type LeadsEligibilityReason =
  | "INACTIVE"
  | "WEIGHT_ZERO"
  | "OVERRIDE_INELIGIBLE"
  | "OVERRIDE_ELIGIBLE"
  | "RULES_OFF"
  | "DEPARTMENT_ACTIVE"
  | "OUT_OF_HOURS";

export interface LeadsEligibilityView {
  eligibleNow: boolean;
  reason: LeadsEligibilityReason;
  override: { eligible: boolean; startsAt: string; endsAt: string } | null;
}

/** Override valendo no instante `now` (`startsAt <= now < endsAt`). */
export function isOverrideActiveAt(o: { startsAt: Date; endsAt: Date }, now: Date): boolean {
  const t = now.getTime();
  return o.startsAt.getTime() <= t && t < o.endsAt.getTime();
}

/** Mapa userId → override vigente (o mais recente, se houver corrida). */
export function activeOverridesByUser(
  overrides: readonly LeadsEligibilityOverrideWindow[],
  now: Date,
): Map<string, LeadsEligibilityOverrideWindow> {
  const map = new Map<string, LeadsEligibilityOverrideWindow>();
  for (const o of overrides) {
    if (!isOverrideActiveAt(o, now)) continue;
    const prev = map.get(o.userId);
    if (!prev || prev.startsAt.getTime() < o.startsAt.getTime()) map.set(o.userId, o);
  }
  return map;
}

/**
 * Recorte do sorteio com as liberações/pausas:
 * - regras ligadas: (membros dos departamentos ativos ∪ liberados) − pausados;
 * - regras desligadas: todos, menos os pausados.
 * `allowUserIds` undefined = sem recorte por usuário.
 */
export function applyEligibilityOverrides(input: {
  departmentUserIds: string[] | undefined;
  overrides: ReadonlyMap<string, LeadsEligibilityOverrideWindow>;
}): { allowUserIds: string[] | undefined; excludeUserIds: string[] } {
  const paused = [...input.overrides.values()].filter((o) => !o.eligible).map((o) => o.userId);
  const pausedSet = new Set(paused);
  if (!input.departmentUserIds) {
    return { allowUserIds: undefined, excludeUserIds: paused };
  }
  const allow = new Set(input.departmentUserIds);
  for (const o of input.overrides.values()) if (o.eligible) allow.add(o.userId);
  return {
    allowUserIds: [...allow].filter((u) => !pausedSet.has(u)),
    excludeUserIds: paused,
  };
}

/** Situação de um consultor agora (coluna "Elegível" da tela). */
export function describeEligibility(input: {
  status: string;
  weight: number;
  rulesEnabled: boolean;
  departmentActiveNow: boolean;
  override: LeadsEligibilityOverrideWindow | undefined;
}): LeadsEligibilityView {
  const o = input.override;
  const override = o
    ? { eligible: o.eligible, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString() }
    : null;
  const result = (eligibleNow: boolean, reason: LeadsEligibilityReason): LeadsEligibilityView => ({
    eligibleNow,
    reason,
    override,
  });
  if (input.status !== "ACTIVE") return result(false, "INACTIVE");
  if (input.weight <= 0) return result(false, "WEIGHT_ZERO");
  if (o && !o.eligible) return result(false, "OVERRIDE_INELIGIBLE");
  if (o && o.eligible) return result(true, "OVERRIDE_ELIGIBLE");
  if (!input.rulesEnabled) return result(true, "RULES_OFF");
  if (input.departmentActiveNow) return result(true, "DEPARTMENT_ACTIVE");
  return result(false, "OUT_OF_HOURS");
}

/**
 * "22:00" → próximo 22:00 no fuso de São Paulo a partir de `now` (hoje, ou
 * amanhã se já passou). Máximo 24 h. Inválido → null.
 */
export function resolveOverrideEndsAt(
  until: unknown,
  now: Date,
  timeZone = LEADS_RULES_TIMEZONE,
): Date | null {
  const target = typeof until === "string" ? parseClockMinute(until) : null;
  if (target === null) return null;
  const nowMinute = localClock(now, timeZone).minute;
  let delta = (target - nowMinute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (delta === 0) delta = MINUTES_PER_DAY;
  const base = new Date(now);
  base.setUTCSeconds(0, 0);
  return new Date(base.getTime() + delta * 60_000);
}

const OVERRIDE_SELECT = { userId: true, eligible: true, startsAt: true, endsAt: true } as const;

/** Overrides vigentes da org (dentro da transação do sorteio). */
export async function activeEligibilityOverridesTx(
  tx: Pick<ScopedTx, "distributionLeadsEligibilityOverride">,
  orgId: string,
  now: Date = new Date(),
): Promise<Map<string, LeadsEligibilityOverrideWindow>> {
  const rows = await tx.distributionLeadsEligibilityOverride.findMany({
    where: { organizationId: orgId, startsAt: { lte: now }, endsAt: { gt: now } },
    select: OVERRIDE_SELECT,
  });
  return activeOverridesByUser(rows, now);
}

/** Overrides vigentes da org da sessão (tela / resumo). */
export async function getActiveEligibilityOverrides(
  now: Date = new Date(),
): Promise<Map<string, LeadsEligibilityOverrideWindow>> {
  const orgId = getOrgIdOrThrow();
  return activeEligibilityOverridesTx(prisma, orgId, now);
}

export type SetOverrideResult =
  | { ok: true; override: LeadsEligibilityOverrideWindow }
  | { ok: false; status: 400 | 404; message: string };

async function endActiveOverridesTx(
  tx: Pick<ScopedTx, "distributionLeadsEligibilityOverride">,
  orgId: string,
  userId: string,
  now: Date,
): Promise<number> {
  const where = { organizationId: orgId, userId, endsAt: { gt: now } };
  // Já começou: fecha em `now` (fica no histórico). Ainda não começou: apaga.
  const ended = await tx.distributionLeadsEligibilityOverride.updateMany({
    where: { ...where, startsAt: { lt: now } },
    data: { endsAt: now },
  });
  const dropped = await tx.distributionLeadsEligibilityOverride.deleteMany({
    where: { ...where, startsAt: { gte: now } },
  });
  return ended.count + dropped.count;
}

/** Libera (`eligible=true`) ou pausa (`false`) o consultor até `until` ("HH:MM"). */
export async function setLeadsEligibilityOverride(input: {
  userId: string;
  eligible: boolean;
  until: unknown;
  createdById: string | null;
  now?: Date;
}): Promise<SetOverrideResult> {
  const orgId = getOrgIdOrThrow();
  const now = input.now ?? new Date();
  const endsAt = resolveOverrideEndsAt(input.until, now);
  if (!endsAt) {
    return { ok: false, status: 400, message: "Informe o horário de fim (HH:MM)." };
  }
  // User não é org-scoped na extension: filtro manual.
  const user = await prisma.user.findFirst({
    where: { id: input.userId, organizationId: orgId, type: "HUMAN", isErased: false },
    select: { id: true },
  });
  if (!user) return { ok: false, status: 404, message: "Consultor não encontrado." };

  const row = await prisma.$transaction(async (tx) => {
    await endActiveOverridesTx(tx, orgId, input.userId, now);
    return tx.distributionLeadsEligibilityOverride.create({
      data: {
        organizationId: orgId,
        userId: input.userId,
        eligible: input.eligible,
        startsAt: now,
        endsAt,
        createdById: input.createdById,
      },
      select: OVERRIDE_SELECT,
    });
  });
  return { ok: true, override: row };
}

/** Encerra agora a liberação/pausa vigente. `false` = não havia nenhuma. */
export async function endLeadsEligibilityOverride(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const orgId = getOrgIdOrThrow();
  const n = await prisma.$transaction((tx) => endActiveOverridesTx(tx, orgId, userId, now));
  return n > 0;
}
