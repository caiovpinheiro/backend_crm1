/**
 * Métricas do "Cockpit do Agente" — painel operacional (herdeiro do cockpit do
 * DataCrazy) migrado para o CRM novo. Os números de atendimento usam a MESMA
 * fonte da aba Dashboard do CRM (conversas: `conversation.count` /
 * `assignedToId`), além de `responsibles.ts` (elegibilidade/fila) e
 * `DistributionLog` (só o handoff do agente IA). É SOMENTE LEITURA e escopado
 * à organização do token.
 *
 * Consumido por `GET /api/public/agent-cockpit` (Bearer token) e renderizado
 * pelo dashboard estático `public/cockpit-agente.html`.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { activeInboxQueueGuardWhere } from "@/lib/inbox-queue-membership";

import {
  getRechamadoMetrics,
  type RechamadoMetrics,
} from "./rechamado";
import { getDistributionResponsibles } from "./responsibles";
import { getWaitingQueueWhere } from "./pending";
import {
  getAcademicCockpitMetrics,
  type AcademicCockpit,
} from "@/services/ai/cockpit-academic";

export interface CockpitAgent {
  userId: string;
  name: string | null;
  archetype: string;
  active: boolean;
  /** Conversas OPEN atualmente atribuídas ao agente (atendendo agora). */
  attendingNow: number;
}

export interface CockpitConsultant {
  userId: string;
  name: string | null;
  departments: string[];
  /** Carga atual (conversas OPEN atribuídas) — mesma base do limite. */
  queueCount: number;
  /** Teto da fila. 0 = não recebe. */
  queueLimit: number;
  status: string | null;
  eligible: boolean;
  /**
   * Conversas atribuídas a ESTE consultor hoje — mesma fonte do Dashboard
   * do CRM (conversation.assignedToId, criadas hoje). "Atendimentos" por
   * consultor, não distribuições.
   */
  receivedToday: number;
}

export interface CockpitData {
  generatedAt: string;
  totals: {
    /**
     * Atendimentos de hoje — mesma fonte do Dashboard do CRM
     * (conversas criadas hoje, todos os canais). Substitui a antiga contagem
     * de distribuições para os números baterem com a aba Dashboard.
     */
    attendancesToday: number;
    /** Distribuições feitas HOJE pelo agente IA (handoff, origem AI_AGENT). */
    distributedByAgentToday: number;
    /** Conversas OPEN atribuídas a agentes de IA agora. */
    attendingNow: number;
    /** Leads na fila de espera (sem responsável elegível). */
    pendingQueue: number;
  };
  /**
   * Rechamado (hoje): recontato 24h / mesmo depto / cruzado.
   * Ver `rechamado.ts` — painel para calibração ao longo dos dias.
   */
  rechamado: RechamadoMetrics;
  academic: AcademicCockpit;
  agents: CockpitAgent[];
  consultants: CockpitConsultant[];
}

/** Meia-noite de hoje no fuso America/Sao_Paulo, como Date UTC. */
function startOfTodaySaoPaulo(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = parts.split("-").map(Number);
  // Brasil não usa mais horário de verão → offset fixo -03:00.
  // 00:00 -03:00 == 03:00 UTC do mesmo dia.
  return new Date(Date.UTC(y!, m! - 1, d!, 3, 0, 0));
}

export async function getCockpitData(): Promise<CockpitData> {
  const orgId = getOrgIdOrThrow();
  const since = startOfTodaySaoPaulo();

  const [
    agentConfigs,
    responsibles,
    attendancesToday,
    convByAgent,
    byAgentToday,
    pendingQueue,
    rechamado,
  ] = await Promise.all([
      prisma.aIAgentConfig.findMany({
        where: { organizationId: orgId },
        select: {
          userId: true,
          archetype: true,
          active: true,
          user: { select: { name: true } },
        },
      }),
      getDistributionResponsibles(),
      // "Atendimentos hoje" — mesma definição do Dashboard do CRM:
      // conversas criadas hoje (todos os canais, atribuídas ou não).
      prisma.conversation.count({
        where: { organizationId: orgId, createdAt: { gte: since } },
      }),
      // Conversas atribuídas por consultor hoje — "recebidos hoje" = atendimentos
      // por atendente, igual ao Dashboard (conversation.assignedToId).
      prisma.conversation.groupBy({
        by: ["assignedToId"],
        where: {
          organizationId: orgId,
          createdAt: { gte: since },
          assignedToId: { not: null },
        },
        _count: { _all: true },
      }),
      // Quantas dessas foram feitas pelo AGENTE IA (handoff → distribuição).
      // Origem AI_AGENT — distinto de AUTOMATION (workflows), que roda mesmo
      // com o agente desligado e não deve entrar neste card.
      prisma.distributionLog.count({
        where: {
          organizationId: orgId,
          success: true,
          createdAt: { gte: since },
          triggerSource: { contains: "AI_AGENT" },
        },
      }),
      prisma.conversation.count({
        where: await getWaitingQueueWhere(),
      }),
      getRechamadoMetrics({ organizationId: orgId, since, sampleLimit: 80 }),
    ]);

  const receivedByUser = new Map<string, number>();
  for (const row of convByAgent) {
    if (!row.assignedToId) continue;
    receivedByUser.set(row.assignedToId, row._count._all);
  }

  // Atendendo agora por agente (conversas OPEN atribuídas ao user do agente).
  const agentUserIds = agentConfigs.map((a) => a.userId);
  const attendingRows =
    agentUserIds.length > 0
      ? await prisma.conversation.groupBy({
          by: ["assignedToId"],
          where: {
            ...activeInboxQueueGuardWhere(),
            assignedToId: { in: agentUserIds },
          },
          _count: { _all: true },
        })
      : [];
  const attendingByAgent = new Map<string, number>();
  for (const row of attendingRows) {
    if (row.assignedToId) attendingByAgent.set(row.assignedToId, row._count._all);
  }

  const agents: CockpitAgent[] = agentConfigs.map((a) => ({
    userId: a.userId,
    name: a.user?.name ?? null,
    archetype: a.archetype,
    active: a.active,
    attendingNow: attendingByAgent.get(a.userId) ?? 0,
  }));

  const consultants: CockpitConsultant[] = responsibles
    .map((r) => ({
      userId: r.userId,
      name: r.name,
      departments: r.departments.map((d) => d.name),
      queueCount: r.queueCount,
      queueLimit: r.queueLimit,
      status: r.status,
      eligible: r.eligible,
      receivedToday: receivedByUser.get(r.userId) ?? 0,
    }))
    // Ordena por recebidos hoje (desc) e depois por fila — quem mais recebeu no topo.
    .sort(
      (a, b) => b.receivedToday - a.receivedToday || b.queueCount - a.queueCount,
    );

  const attendingNow = agents.reduce((s, a) => s + a.attendingNow, 0);
  const academic = await getAcademicCockpitMetrics({
    organizationId: orgId,
    since,
    attendingNow,
  });

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      attendancesToday,
      distributedByAgentToday: byAgentToday,
      attendingNow,
      pendingQueue,
    },
    rechamado,
    academic,
    agents,
    consultants,
  };
}
