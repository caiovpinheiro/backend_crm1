/**
 * Monta a visão de responsáveis da Distribuição: cada usuário humano da org
 * + sua config (`DistributionResponsible`, com defaults quando não existe) +
 * presença (`AgentStatus`) + expediente (`AgentSchedule`) + fila atual +
 * elegibilidade (via `eligibility.ts`, a regra única).
 *
 * Usado pela tela (`GET /api/distribution/responsibles`) e pelo motor
 * (`engine.ts`) — mesma fonte de dados garante consistência tela↔motor.
 */

import type { AgentOnlineStatus, UserRole } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { getSystemPresenceMap } from "@/services/system-presence";

import {
  evaluateResponsibleEligibility,
  type DistributionBlockReason,
  type EligibilityContext,
  type ScheduleLike,
} from "./eligibility";
import { getQueueCounts } from "./queue";

/** Linha de expediente já normalizada (sempre com os campos de sábado). */
interface ScheduleRow {
  userId: string;
  startTime: string;
  lunchStart: string;
  lunchEnd: string;
  endTime: string;
  timezone: string;
  weekdays: number[];
  saturdayEnabled: boolean;
  saturdayStart: string;
  saturdayEnd: string;
}

/**
 * Carrega os `AgentSchedule` dos usuários. Defensivo contra ambientes onde a
 * migration das colunas de sábado (`saturday*`) ainda não foi aplicada: se o
 * SELECT com essas colunas falhar (P2022 "column does not exist"), relê sem
 * elas e assume sábado desligado. Assim a tela de Distribuição não quebra
 * durante a janela entre o deploy do código e a aplicação da migration.
 */
async function loadSchedules(userIds: string[]): Promise<ScheduleRow[]> {
  try {
    return await prisma.agentSchedule.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        startTime: true,
        lunchStart: true,
        lunchEnd: true,
        endTime: true,
        timezone: true,
        weekdays: true,
        saturdayEnabled: true,
        saturdayStart: true,
        saturdayEnd: true,
      },
    });
  } catch (e) {
    console.warn(
      "[distribution] AgentSchedule sem colunas de sábado — usando fallback " +
        "(aplique a migration 20260801130000_add_agent_schedule_saturday).",
      e,
    );
    const base = await prisma.agentSchedule.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        startTime: true,
        lunchStart: true,
        lunchEnd: true,
        endTime: true,
        timezone: true,
        weekdays: true,
      },
    });
    return base.map((s) => ({
      ...s,
      saturdayEnabled: false,
      saturdayStart: "09:00",
      saturdayEnd: "13:00",
    }));
  }
}

/** Defaults de config quando o usuário ainda não tem `DistributionResponsible`. */
const DEFAULT_RESPONSIBLE = {
  participates: true,
  visibleInCoverage: true,
  queueLimit: 0,
  volume: 1,
  type: null as string | null,
  paused: false,
  preLunchStopMinutes: 30,
  lastExecutionAt: null as Date | null,
};

export interface ResponsibleScheduleView {
  startTime: string;
  lunchStart: string;
  lunchEnd: string;
  endTime: string;
  timezone: string;
  weekdays: number[];
  saturdayEnabled: boolean;
  saturdayStart: string;
  saturdayEnd: string;
}

export interface DistributionResponsibleView {
  userId: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: UserRole;
  /** Config administrativa. */
  participates: boolean;
  /** false = some da grade de cobertura. Default true. */
  visibleInCoverage: boolean;
  queueLimit: number;
  volume: number;
  type: string | null;
  paused: boolean;
  /** Minutos antes do almoço em que para de receber leads. */
  preLunchStopMinutes: number;
  lastExecutionAt: string | null;
  /** Departamentos dos quais é membro (dirige o roteamento por departamento). */
  departments: { id: string; name: string }[];
  /** Presença operacional (null = sem registro). */
  status: AgentOnlineStatus | null;
  /** Tem expediente configurado. */
  hasSchedule: boolean;
  /** Expediente (null se não configurado). */
  schedule: ResponsibleScheduleView | null;
  /**
   * Fila usada para SELEÇÃO ("menor carga"). POR DEPARTAMENTO quando a chamada
   * tem escopo de departamento (distribuição); global caso contrário.
   */
  queueCount: number;
  /**
   * Carga TOTAL do consultor (todos os departamentos + conversas sem
   * departamento) — é ela que o teto `queueLimit` compara. Sem escopo de
   * departamento é igual a `queueCount`.
   */
  totalQueueCount: number;
  /** Resultado da regra única. */
  eligible: boolean;
  blockedReasons: DistributionBlockReason[];
  /**
   * Presença de USO do CRM ("aba aberta"). Distinta de `status`:
   * indica apenas se o agente tem o CRM aberto agora — não afeta
   * elegibilidade da Distribuição.
   */
  systemOnline: boolean;
  lastSeenAt: string | null;
}

export interface GetResponsiblesOptions {
  /** Tipo/segmento solicitado (avalia `TYPE_INCOMPATIBLE`). */
  distributionType?: string | null;
  /** Momento de referência (simulação/teste). */
  now?: Date;
  /**
   * Distribuição por departamento: quando definido, responsáveis que NÃO são
   * membros deste departamento (`DepartmentMember`) recebem o bloqueio
   * `DEPARTMENT_MISMATCH` (inelegíveis). `null`/undefined = modo desligado.
   */
  departmentId?: string | null;
  /**
   * Pool de departamentos (OR): membro de qualquer um dos IDs é elegível
   * quanto a departamento. Tem prioridade sobre `departmentId` quando ambos
   * vêm preenchidos.
   */
  departmentIds?: string[] | null;
}

export async function getDistributionResponsibles(
  opts: GetResponsiblesOptions = {},
): Promise<DistributionResponsibleView[]> {
  const orgId = getOrgIdOrThrow();

  // User NÃO é org-scoped na Prisma Extension — filtro manual obrigatório.
  const users = await prisma.user.findMany({
    where: { type: "HUMAN", organizationId: orgId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, avatarUrl: true, role: true },
  });
  if (users.length === 0) return [];

  const userIds = users.map((u) => u.id);

  // Distribuição por departamento: carrega os membros do(s) departamento(s)
  // alvo para marcar quem está dentro/fora. Vazio (Set) quando modo desligado.
  const scopeDeptIds = Array.from(
    new Set(
      [
        ...(opts.departmentIds ?? []),
        ...(opts.departmentId ? [opts.departmentId] : []),
      ].filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const departmentMemberIds =
    scopeDeptIds.length > 0
      ? new Set(
          (
            await prisma.departmentMember.findMany({
              where: {
                departmentId: { in: scopeDeptIds },
                userId: { in: userIds },
              },
              select: { userId: true },
            })
          ).map((m) => m.userId),
        )
      : null;

  const [
    responsibles,
    statuses,
    schedules,
    queue,
    totalQueue,
    memberships,
    systemPresence,
  ] = await Promise.all([
    prisma.distributionResponsible.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        participates: true,
        visibleInCoverage: true,
        queueLimit: true,
        volume: true,
        type: true,
        paused: true,
        preLunchStopMinutes: true,
        lastExecutionAt: true,
      },
    }),
    prisma.agentStatus.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, status: true },
    }),
    loadSchedules(userIds),
    // Fila POR DEPARTAMENTO quando há escopo: usada só para SELEÇÃO (o
    // consultor concorre pela menor fila daquele depto). Sem escopo
    // (tela/cockpit) = fila global.
    getQueueCounts(userIds, scopeDeptIds),
    // Carga TOTAL, usada para o TETO (`queueLimit`). Contar só o depto fazia
    // membro de 2 departamentos receber um limite por departamento, e ignorava
    // conversas sem departamento — o consultor passava de 25 sem nunca ficar
    // "fila cheia" para o motor.
    scopeDeptIds.length > 0
      ? getQueueCounts(userIds)
      : Promise.resolve(null),
    prisma.departmentMember.findMany({
      where: { userId: { in: userIds }, organizationId: orgId },
      select: { userId: true, department: { select: { id: true, name: true } } },
    }),
    // Presença de USO (aba do CRM aberta) — falha "aberta": em erro,
    // devolvemos Map vazio para não bloquear a tela de Distribuição.
    getSystemPresenceMap({ organizationId: orgId, userIds }).catch(() => new Map()),
  ]);

  // userId → lista de departamentos (nome), para exibição e roteamento.
  const deptsByUser = new Map<string, { id: string; name: string }[]>();
  for (const m of memberships) {
    if (!m.department) continue;
    const arr = deptsByUser.get(m.userId) ?? [];
    arr.push({ id: m.department.id, name: m.department.name });
    deptsByUser.set(m.userId, arr);
  }

  const respByUser = new Map(responsibles.map((r) => [r.userId, r]));
  const statusByUser = new Map(statuses.map((s) => [s.userId, s.status]));
  const scheduleByUser = new Map<string, ScheduleLike>(
    schedules.map((s) => [
      s.userId,
      {
        startTime: s.startTime,
        lunchStart: s.lunchStart,
        lunchEnd: s.lunchEnd,
        endTime: s.endTime,
        timezone: s.timezone,
        weekdays: s.weekdays,
        saturdayEnabled: s.saturdayEnabled,
        saturdayStart: s.saturdayStart,
        saturdayEnd: s.saturdayEnd,
      },
    ]),
  );

  const eligibilityCtx: EligibilityContext = {
    distributionType: opts.distributionType ?? null,
    now: opts.now,
  };

  return users.map((u) => {
    const cfg = respByUser.get(u.id) ?? DEFAULT_RESPONSIBLE;
    const status = statusByUser.get(u.id) ?? null;
    const schedule = scheduleByUser.get(u.id) ?? null;
    const queueCount = queue.get(u.id) ?? 0;
    const totalQueueCount = totalQueue
      ? (totalQueue.get(u.id) ?? 0)
      : queueCount;

    const { eligible, blockedReasons } = evaluateResponsibleEligibility(
      {
        participates: cfg.participates,
        paused: cfg.paused,
        queueLimit: cfg.queueLimit,
        type: cfg.type,
        status,
        schedule,
        preLunchStopMinutes: cfg.preLunchStopMinutes,
        queueCount: totalQueueCount,
        // undefined = modo desligado (sem restrição); false = fora do depto.
        inDepartment: departmentMemberIds ? departmentMemberIds.has(u.id) : undefined,
      },
      eligibilityCtx,
    );

    return {
      userId: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      role: u.role,
      participates: cfg.participates,
      visibleInCoverage: cfg.visibleInCoverage ?? true,
      queueLimit: cfg.queueLimit,
      volume: cfg.volume,
      type: cfg.type,
      paused: cfg.paused,
      preLunchStopMinutes: cfg.preLunchStopMinutes,
      lastExecutionAt: cfg.lastExecutionAt
        ? cfg.lastExecutionAt.toISOString()
        : null,
      departments: (deptsByUser.get(u.id) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      status,
      hasSchedule: schedule !== null,
      schedule: schedule
        ? {
            startTime: schedule.startTime,
            lunchStart: schedule.lunchStart,
            lunchEnd: schedule.lunchEnd,
            endTime: schedule.endTime,
            timezone: schedule.timezone,
            weekdays: schedule.weekdays,
            saturdayEnabled: schedule.saturdayEnabled ?? false,
            saturdayStart: schedule.saturdayStart ?? "09:00",
            saturdayEnd: schedule.saturdayEnd ?? "13:00",
          }
        : null,
      queueCount,
      totalQueueCount,
      eligible,
      blockedReasons,
      systemOnline: systemPresence.get(u.id)?.systemOnline ?? false,
      lastSeenAt:
        systemPresence.get(u.id)?.lastSeenAt?.toISOString() ?? null,
    };
  });
}
