/**
 * Fila de espera da Distribuição.
 *
 * A fila reflete os ATENDIMENTOS da aba "Entrada" que ainda estão SEM
 * responsável (conversa aberta, sem `assignedToId`). Deriva do mesmo
 * critério da aba Entrada do inbox. A drenagem automática passa por
 * `processPendingDistributionQueue` (gatilhos: novo item, agente online,
 * elegibilidade, capacidade liberada, botão manual, cron de segurança).
 * A drenagem é **por departamento** (FIFO + capacidade). Quem fica
 * elegível abre a fila dos seus depts; o reprocesso manual/cron também
 * tenta os depts que já têm gente na espera — o motor decide se o
 * pool é o depto ou org-wide (`respectDepartment`).
 *
 * Import unidirecional: pending → engine (evita ciclo de import).
 * O engine agenda drenagem via import dinâmico.
 */

import { Prisma } from "@prisma/client";

import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import {
  getOrgIdOrNull,
  runWithContext,
} from "@/lib/request-context";
import { hasOrganizationWidget } from "@/services/organization-widgets";

import { tryAssignFirstAttendanceAi } from "@/services/ai/first-attendance";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import {
  clearOwnershipForRedistribution,
  isAssigneeCurrentlyEligible,
} from "@/services/distribution/assignee-eligibility";
import { humanWasAssignedInThisConversation } from "@/services/distribution/human-assignment-history";
import { keepHumanAfterAutomationClose } from "@/services/distribution/return-after-close";

import { executeDistribution } from "./engine";
import {
  getDistributionResponsibles,
  type DistributionResponsibleView,
} from "./responsibles";

export interface PendingDistributionView {
  id: string;
  /** Ticket sequencial da org — usado em `/inbox?c=<number>`. */
  number: number | null;
  dealId: string | null;
  contactId: string | null;
  /** Nome amigável: título do negócio, nome do contato, ou fallback. */
  label: string;
  /** Canal de origem da conversa (WHATSAPP, INSTAGRAM, FACEBOOK, EMAIL, WEBCHAT). */
  channel: string;
  departmentId: string | null;
  departmentName: string | null;
  distributionType: string | null;
  triggerSource: string;
  attempts: number;
  lastAttemptAt: string;
  createdAt: string;
}

/**
 * Critério da fila = atendimentos ABERTOS SEM responsável (`assignedToId=null`)
 * em que o contato JÁ RESPONDEU pelo menos uma vez (`lastInboundAt` preenchido).
 *
 * Calouros que só receberam template "BV / Bem-vindo" e nunca responderam
 * NÃO entram na fila de espera nem na drenagem — só passam a contar quando
 * houver inbound real do aluno.
 *
 * NÃO usamos `hasAgentReply` de propósito: uma resposta de AUTOMAÇÃO/IA marca
 * `hasAgentReply=true` e tiraria o lead da aba "Entrada", mas ele continua SEM
 * responsável humano e PRECISA ser distribuído (desde que já tenha inbound).
 */
export const ABERTA_SEM_RESPONSAVEL: Prisma.ConversationWhereInput = {
  status: "OPEN",
  assignedToId: null,
  lastInboundAt: { not: null },
};

/** Default true: inbound sem dono entra na fila (legado acadêmico). */
const AUTO_ON_INBOUND_KEY = "distribution.autoOnInbound";

export async function isDistributionAutoOnInbound(): Promise<boolean> {
  return getOrgSettingBool(AUTO_ON_INBOUND_KEY, true);
}

async function listExplicitPendingConversationIds(): Promise<string[]> {
  const rows = await prisma.distributionPending.findMany({
    where: { status: "PENDING", conversationId: { not: null } },
    select: { conversationId: true },
    take: 5000,
  });
  return [
    ...new Set(
      rows
        .map((r) => r.conversationId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

/**
 * Filtro da fila de espera.
 * - autoOnInbound true: toda conversa OPEN sem responsável (com inbound).
 * - false: só quem já passou por execute_distribution / redistribuição
 *   manual / IA e ficou em DistributionPending.
 */
export async function getWaitingQueueWhere(): Promise<Prisma.ConversationWhereInput> {
  if (await isDistributionAutoOnInbound()) return ABERTA_SEM_RESPONSAVEL;
  const ids = await listExplicitPendingConversationIds();
  if (ids.length === 0) return { id: { equals: "__no_distribution_pending__" } };
  return { id: { in: ids }, status: "OPEN", assignedToId: null };
}

export async function getPendingDistributions(): Promise<
  PendingDistributionView[]
> {
  // Limpa pendências de quem só recebeu template e nunca respondeu.
  await purgeUnansweredFromPendingQueue().catch(() => 0);

  const autoOnInbound = await isDistributionAutoOnInbound();

  // Inclui também conversas OPEN sem dono enfileiradas MANUALMENTE mesmo
  // sem lastInboundAt (redistribuição p/ depto com fila cheia).
  const manualPending = await prisma.distributionPending.findMany({
    where: {
      status: "PENDING",
      triggerSource: "MANUAL",
      conversationId: { not: null },
    },
    select: { conversationId: true },
    take: 500,
  });
  const manualConvIds = manualPending
    .map((p) => p.conversationId)
    .filter((id): id is string => Boolean(id));

  const explicitIds = autoOnInbound
    ? []
    : await listExplicitPendingConversationIds();

  const items = await prisma.conversation.findMany({
    where: autoOnInbound
      ? {
          OR: [
            ABERTA_SEM_RESPONSAVEL,
            ...(manualConvIds.length > 0
              ? [
                  {
                    id: { in: manualConvIds },
                    status: "OPEN" as const,
                    assignedToId: null,
                  },
                ]
              : []),
          ],
        }
      : explicitIds.length === 0
        ? { id: { equals: "__no_distribution_pending__" } }
        : {
            id: { in: explicitIds },
            status: "OPEN",
            assignedToId: null,
          },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      number: true,
      channel: true,
      contactId: true,
      departmentId: true,
      createdAt: true,
      updatedAt: true,
      contact: { select: { name: true, phone: true } },
      department: { select: { id: true, name: true } },
    },
  });

  if (items.length === 0) return [];

  const convIds = items.map((c) => c.id);
  const contactIds = items
    .map((c) => c.contactId)
    .filter((id): id is string => Boolean(id));

  // Origem real da solicitação (ex.: AI_AGENT) — a aba "Aguardando" lista
  // conversas OPEN sem assignee; o meta vem da pendência do motor.
  const pendRows = await prisma.distributionPending.findMany({
    where: {
      status: "PENDING",
      OR: [
        { conversationId: { in: convIds } },
        ...(contactIds.length > 0 ? [{ contactId: { in: contactIds } }] : []),
      ],
    },
    select: {
      conversationId: true,
      contactId: true,
      triggerSource: true,
      attempts: true,
      lastAttemptAt: true,
      distributionType: true,
      dealId: true,
      createdAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const byConv = new Map<string, (typeof pendRows)[number]>();
  const byContact = new Map<string, (typeof pendRows)[number]>();
  for (const row of pendRows) {
    if (row.conversationId && !byConv.has(row.conversationId)) {
      byConv.set(row.conversationId, row);
    }
    if (row.contactId && !byContact.has(row.contactId)) {
      byContact.set(row.contactId, row);
    }
  }

  return items.map((c) => {
    const meta =
      byConv.get(c.id) ??
      (c.contactId ? byContact.get(c.contactId) : undefined) ??
      null;
    return {
      id: c.id,
      number: c.number ?? null,
      dealId: meta?.dealId ?? null,
      contactId: c.contactId,
      label: c.contact?.phone || c.contact?.name || "Atendimento",
      channel: c.channel ?? "",
      departmentId: c.departmentId ?? c.department?.id ?? null,
      departmentName: c.department?.name ?? null,
      distributionType: meta?.distributionType ?? null,
      triggerSource: meta?.triggerSource ?? "INBOUND",
      attempts: meta?.attempts ?? 0,
      lastAttemptAt: (meta?.lastAttemptAt ?? c.updatedAt).toISOString(),
      createdAt: (meta?.createdAt ?? c.createdAt).toISOString(),
    };
  });
}

export interface RetryResult {
  resolved: number;
  cancelled: number;
  pending: number;
  trigger?: PendingQueueTrigger;
  /** Código estável para o toast (ex.: NO_ELIGIBLE_IN_DEPARTMENT). */
  skipReason?: string | null;
  /** Mensagem pronta para o operador — por que a fila não andou. */
  skipMessage?: string | null;
}

export type PendingQueueTrigger =
  | "new_item"
  | "agent_online"
  | "agent_eligible"
  | "capacity_released"
  | "manual"
  | "scheduled";

/** Teto de segurança por consultor por passagem quando queueLimit=0 (sem limite configurado). */
const SAFETY_CAP_PER_USER = 25;

/** Debounce / lock in-memory por org (sem schema novo). */
const drainState = new Map<
  string,
  {
    running: boolean;
    queuedTrigger: PendingQueueTrigger | null;
    /** null = todos os depts com elegível; string = só depts desta pessoa. */
    queuedUserId: string | null;
    timer: ReturnType<typeof setTimeout> | null;
  }
>();

function getDrainState(orgId: string) {
  let s = drainState.get(orgId);
  if (!s) {
    s = {
      running: false,
      queuedTrigger: null,
      queuedUserId: null,
      timer: null,
    };
    drainState.set(orgId, s);
  }
  return s;
}

type ResponsibleCapacity = {
  userId: string;
  queueLimit: number;
  queueCount: number;
  departments: { id: string }[];
};

/** Capacidade livre ao vivo de um consultor, descontando atribuições desta passagem. */
function liveFreeCapacityForUser(
  r: Pick<ResponsibleCapacity, "userId" | "queueLimit" | "queueCount">,
  assignedDeltaByUser: Map<string, number>,
): number {
  const delta = assignedDeltaByUser.get(r.userId) ?? 0;
  const loaded = r.queueCount + delta;
  // Sem limite configurado: ainda assim não ultrapassa o teto de segurança
  // por consultor (conta carga atual + o que já entrou nesta passagem).
  const cap = r.queueLimit > 0 ? r.queueLimit : SAFETY_CAP_PER_USER;
  return Math.max(0, cap - loaded);
}

function eligibleInDeptScope(
  eligible: ResponsibleCapacity[],
  deptId: string | null,
): ResponsibleCapacity[] {
  return eligible.filter((r) =>
    deptId === null
      ? true
      : r.departments.some((d) => d.id === deptId),
  );
}

/**
 * Capacidade livre agregada dos elegíveis de um departamento
 * (ou org-wide quando deptId é null), com delta desta passagem.
 */
function takeLimitForDept(
  eligible: ResponsibleCapacity[],
  deptId: string | null,
  assignedDeltaByUser: Map<string, number>,
): number {
  const inScope = eligibleInDeptScope(eligible, deptId);
  if (inScope.length === 0) return 0;
  return inScope.reduce(
    (acc, r) => acc + liveFreeCapacityForUser(r, assignedDeltaByUser),
    0,
  );
}

function hasRemainingCapacityInScope(
  eligible: ResponsibleCapacity[],
  deptId: string | null,
  assignedDeltaByUser: Map<string, number>,
): boolean {
  return eligibleInDeptScope(eligible, deptId).some(
    (r) => liveFreeCapacityForUser(r, assignedDeltaByUser) > 0,
  );
}

function uniqueDeptNames(names: string[]): string {
  const uniq = Array.from(new Set(names.filter(Boolean)));
  if (uniq.length === 0) return "";
  if (uniq.length === 1) return uniq[0]!;
  if (uniq.length === 2) return `${uniq[0]} e ${uniq[1]}`;
  return `${uniq.slice(0, 2).join(", ")} e mais ${uniq.length - 2}`;
}

/**
 * Por que o reprocesso não atribuiu ninguém, mesmo com elegíveis no KPI.
 * O KPI é org-wide; a fila pode ser de um depto sem nenhum desses elegíveis.
 */
async function explainEmptyDrain(opts: {
  eligible: DistributionResponsibleView[];
  pendingCount: number;
}): Promise<{ skipReason: string; skipMessage: string }> {
  const n = opts.eligible.length;
  if (n === 0) {
    return {
      skipReason: "NO_ELIGIBLE_RESPONSIBLE",
      skipMessage: "Ainda não há responsável elegível para a fila.",
    };
  }
  if (opts.pendingCount <= 0) {
    return {
      skipReason: "EMPTY_QUEUE",
      skipMessage: "Fila de espera vazia.",
    };
  }

  const waiting = await prisma.conversation.findMany({
    where: await getWaitingQueueWhere(),
    select: {
      departmentId: true,
      department: { select: { name: true, distributionEnabled: true } },
    },
    take: 500,
  });

  const byDept = new Map<
    string,
    { name: string; enabled: boolean | null }
  >();
  for (const c of waiting) {
    if (!c.departmentId) continue;
    if (byDept.has(c.departmentId)) continue;
    byDept.set(c.departmentId, {
      name: c.department?.name ?? "Departamento",
      enabled: c.department?.distributionEnabled ?? null,
    });
  }

  const unmatchedNames: string[] = [];
  const disabledNames: string[] = [];
  for (const [deptId, info] of byDept) {
    const inDept = opts.eligible.some((r) =>
      r.departments.some((d) => d.id === deptId),
    );
    if (!inDept) unmatchedNames.push(info.name);
    if (info.enabled === false) disabledNames.push(info.name);
  }

  const respectDepartment = await getOrgSettingBool(
    "distribution.respectDepartment",
    false,
  );

  if (respectDepartment && unmatchedNames.length > 0) {
    const label = uniqueDeptNames(unmatchedNames);
    return {
      skipReason: "NO_ELIGIBLE_IN_DEPARTMENT",
      skipMessage: `Há ${n} elegíveis, mas nenhum no departamento ${label}.`,
    };
  }

  if (respectDepartment && disabledNames.length > 0) {
    const label = uniqueDeptNames(disabledNames);
    return {
      skipReason: "NO_DEPARTMENT",
      skipMessage: `O departamento ${label} não está com distribuição automática habilitada.`,
    };
  }

  const anyCap = opts.eligible.some(
    (r) => liveFreeCapacityForUser(r, new Map()) > 0,
  );
  if (!anyCap) {
    return {
      skipReason: "QUEUE_LIMIT_REACHED",
      skipMessage: `Há ${n} elegíveis, mas todos estão no limite da fila.`,
    };
  }

  return {
    skipReason: "NO_MATCH",
    skipMessage: `Há ${n} elegíveis, mas nenhum pode receber os atendimentos da fila (departamento, capacidade ou horário).`,
  };
}

/**
 * Marca como RESOLVED as pendências cuja conversa NÃO precisa mais ser
 * distribuída. Continua ativa quando:
 *
 *   - OPEN sem responsável (`ABERTA_SEM_RESPONSAVEL` / assignedToId null), OU
 *   - OPEN ainda com **IA** (handoff noturno: `NO_ELIGIBLE_RESPONSIBLE` →
 *     enfileira + IA reassumiu para continuar falando; a fila deve drenar
 *     quando um humano ficar elegível — ver `pendingOwnedByAi` abaixo).
 *
 * Resolve (cleanup) quando:
 *
 *   - Conversa encerrada (status != OPEN)
 *   - Conversa OPEN já com **humano** (distribuída por outro caminho)
 *   - Conversa deletada
 *
 * Bug histórico (ago/2026): tratar qualquer assignee ≠ null como órfã
 * cancelava a fila no mesmo segundo em que a IA reassumia → centenas de
 * alunos ficavam na aba Automação “para sempre” após expediente.
 *
 * `resolvedUserId=null` marca que foi cleanup, não distribuição real.
 */
async function cancelStalePendingOrphans(orgId: string): Promise<number> {
  const stale = await prisma.distributionPending.findMany({
    where: {
      organizationId: orgId,
      status: "PENDING",
      conversationId: { not: null },
    },
    select: { id: true, conversationId: true, triggerSource: true },
  });
  if (stale.length === 0) return 0;

  const convIds = stale
    .map((p) => p.conversationId)
    .filter((id): id is string => Boolean(id));

  const stillActive = await prisma.conversation.findMany({
    where: {
      id: { in: convIds },
      status: "OPEN",
      OR: [
        { assignedToId: null },
        // Handoff fora do expediente: IA segura o chat até haver elegível.
        { assignedTo: { type: "AI" } },
      ],
    },
    select: { id: true },
  });
  const activeSet = new Set(stillActive.map((c) => c.id));

  const toResolve = stale
    .filter((p) => {
      if (!p.conversationId || !activeSet.has(p.conversationId)) return true;
      return false;
    })
    .map((p) => p.id);
  if (toResolve.length === 0) return 0;

  const res = await prisma.distributionPending.updateMany({
    where: { id: { in: toResolve } },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });
  return res.count;
}

/**
 * Remove da fila de espera (lista + DistributionPending) conversas OPEN sem
 * responsável em que o aluno nunca respondeu — tipicamente calouros que só
 * receberam template de bem-vindo. Chamada no GET da fila para limpar o
 * dashboard imediatamente, sem depender do cron de drenagem.
 */
export async function purgeUnansweredFromPendingQueue(): Promise<number> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return 0;

  const unanswered = await prisma.conversation.findMany({
    where: {
      status: "OPEN",
      assignedToId: null,
      lastInboundAt: null,
    },
    select: { id: true, contactId: true },
    take: 2000,
  });
  if (unanswered.length === 0) return 0;

  const convIds = unanswered.map((c) => c.id);
  const contactIds = unanswered
    .map((c) => c.contactId)
    .filter((id): id is string => Boolean(id));

  // Não purga redistribuição MANUAL — operador mandou p/ fila de propósito.
  const res = await prisma.distributionPending.updateMany({
    where: {
      organizationId: orgId,
      status: "PENDING",
      NOT: { triggerSource: "MANUAL" },
      OR: [
        { conversationId: { in: convIds } },
        ...(contactIds.length > 0
          ? [{ contactId: { in: contactIds }, conversationId: null }]
          : []),
      ],
    },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });

  if (res.count > 0) {
    console.info(
      "[distribution] purgeUnansweredFromPendingQueue",
      JSON.stringify({ orgId, conversations: unanswered.length, resolved: res.count }),
    );
  }
  return res.count;
}

/**
 * Após criar um NOVO ticket OPEN inbound (modelo: RESOLVED não reabre),
 * tenta distribuir imediatamente se ainda não há responsável.
 *
 * Cobre o caso Anna: distribuição falhou de manhã → ticket RESOLVED sem
 * assign → aluno volta → novo #N sem `execute_distribution` da automação.
 * Remapeia `distribution_pending` órfãs para o conversationId novo.
 *
 * Nunca propaga erro ao webhook — falha só loga.
 */
export async function maybeDistributeNewInboundTicket(input: {
  conversationId: string;
  contactId: string;
  assignedToId?: string | null;
}): Promise<void> {
  const retiredConv = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      channelRef: { select: { name: true, phoneNumber: true, config: true } },
    },
  });
  if (isRetiredWhatsAppChannel(retiredConv?.channelRef)) {
    await prisma.distributionPending.updateMany({
      where: { conversationId: input.conversationId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    return;
  }

  // #region agent log
  console.warn(
    "[DBG-e46688 maybeDist] entry",
    JSON.stringify({
      convId: input.conversationId,
      contactId: input.contactId,
      alreadyAssigned: !!input.assignedToId,
    }),
  );
  // #endregion

  // Automação encerrou e o aluno voltou: o consultor anterior continua.
  // Sem isso o 1º atendimento da IA tira o humano e ninguém responde.
  try {
    const keptHumanId = await keepHumanAfterAutomationClose({
      conversationId: input.conversationId,
      contactId: input.contactId,
    });
    if (keptHumanId) {
      console.warn(
        "[DBG-e46688 maybeDist] keep_human_after_automation_close",
        JSON.stringify({
          convId: input.conversationId,
          humanUserId: keptHumanId,
        }),
      );
      return;
    }
  } catch (e) {
    console.error("[distribution] keepHumanAfterAutomationClose failed", e);
  }

  // Herança de contato/deal NÃO pode burlar elegibilidade: offline /
  // indisponível / fora do expediente devem cair na redistribuição (ou IA).
  let assignee = input.assignedToId ?? null;
  if (assignee) {
    const check = await isAssigneeCurrentlyEligible(assignee);
    // AI owner: keep regardless of eligible flag — first-attendance guard handles post-handoff.
    if (check.isAi) {
      console.warn(
        "[DBG-e46688 maybeDist] keep_ai_assignee",
        JSON.stringify({ convId: input.conversationId, assignee }),
      );
      return;
    }
    if (check.eligible) {
      // IA herdada: mantém. Humano elegível sem reply nesta conversa:
      // libera p/ 1º atendimento IA (substitui INICIO-PIPE).
      if (!check.isAi) {
        const conv = await prisma.conversation.findUnique({
          where: { id: input.conversationId },
          select: { hasHumanReply: true },
        });
        // Herança de ticket antigo pode ir para a IA; quem foi atribuído
        // NESTA conversa fica (a saudação da distribuição sai como bot e
        // não marca `hasHumanReply` — não é sinal de "humano não atendeu").
        if (
          !conv?.hasHumanReply &&
          (await humanWasAssignedInThisConversation(
            input.conversationId,
            assignee,
          ))
        ) {
          console.warn(
            "[DBG-e46688 maybeDist] keep_assigned_human",
            JSON.stringify({ convId: input.conversationId, assignee }),
          );
          return;
        }
        if (!conv?.hasHumanReply) {
          console.warn(
            "[DBG-e46688 maybeDist] release_human_for_first_attendance",
            JSON.stringify({
              convId: input.conversationId,
              assignee,
            }),
          );
          try {
            await clearOwnershipForRedistribution({
              conversationId: input.conversationId,
              contactId: input.contactId,
            });
          } catch (e) {
            console.error(
              "[distribution] clearOwnershipForRedistribution failed",
              e,
            );
            return;
          }
          assignee = null;
        } else {
          console.warn(
            "[DBG-e46688 maybeDist] keep_eligible_assignee",
            JSON.stringify({
              convId: input.conversationId,
              assignee,
              isAi: check.isAi,
            }),
          );
          return;
        }
      } else {
        console.warn(
          "[DBG-e46688 maybeDist] keep_eligible_assignee",
          JSON.stringify({
            convId: input.conversationId,
            assignee,
            isAi: check.isAi,
          }),
        );
        return;
      }
    } else {
      console.warn(
        "[DBG-e46688 maybeDist] clear_ineligible_assignee",
        JSON.stringify({
          convId: input.conversationId,
          assignee,
          reason: check.reason,
        }),
      );
      try {
        await clearOwnershipForRedistribution({
          conversationId: input.conversationId,
          contactId: input.contactId,
        });
      } catch (e) {
        console.error(
          "[distribution] clearOwnershipForRedistribution failed",
          e,
        );
        return;
      }
      assignee = null;
    }
  }

  // 1º atendimento: Agente IA (se houver ativo) assume antes da fila humana.
  try {
    const aiUserId = await tryAssignFirstAttendanceAi({
      conversationId: input.conversationId,
      contactId: input.contactId,
      assignedToId: assignee,
    });
    if (aiUserId) {
      console.warn(
        "[DBG-e46688 maybeDist] first_attendance_ai",
        JSON.stringify({
          convId: input.conversationId,
          aiUserId,
        }),
      );
      return;
    }
  } catch (e) {
    console.error("[ai] tryAssignFirstAttendanceAi failed", e);
  }

  try {
    const widgetActive = await hasOrganizationWidget("smart_distribution");
    // #region agent log
    console.warn(
      "[DBG-e46688 maybeDist] widget check",
      JSON.stringify({ widgetActive, convId: input.conversationId }),
    );
    // #endregion
    if (!widgetActive) return;

    const autoOnInbound = await isDistributionAutoOnInbound();
    if (!autoOnInbound) {
      const alreadyQueued = await prisma.distributionPending.findFirst({
        where: { status: "PENDING", contactId: input.contactId },
        select: { id: true },
      });
      if (!alreadyQueued) {
        console.warn(
          "[DBG-e46688 maybeDist] skip autoOnInbound=false",
          JSON.stringify({ convId: input.conversationId }),
        );
        return;
      }
    }

    const remapped = await prisma.distributionPending.updateMany({
      where: { status: "PENDING", contactId: input.contactId },
      data: {
        conversationId: input.conversationId,
        lastAttemptAt: new Date(),
      },
    });

    const convDept = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { departmentId: true },
    });

    const result = await executeDistribution({
      dealId: null,
      contactId: input.contactId,
      conversationId: input.conversationId,
      distributionType: null,
      triggerSource: "SYSTEM",
      departmentId: convDept?.departmentId ?? null,
      // Fronteira de departamento ESTRITA: quando o lead foi roteado a um
      // departamento (ex.: handoff acadêmico), ele só é distribuído a quem
      // estiver disponível NAQUELE depto — se ninguém, espera na fila do depto
      // (nunca vai para outro). Leads SEM departamento já nascem org-wide
      // (departmentScoped=false), então não ficam presos.
      allowOrgWideFallback: false,
    });
    // #region agent log
    console.warn(
      "[DBG-e46688 maybeDist] result",
      JSON.stringify({
        convId: input.conversationId,
        remappedPending: remapped.count,
        success: result.success,
        reason: result.reason,
        selectedUserId: result.selectedUserId,
      }),
    );
    // #endregion

    // Sem elegíveis: deixa na fila e NÃO dispara retry em loop.
    // Drena só quando consultor ficar disponível / cron / manual.
  } catch (e) {
    console.error("[distribution] maybeDistributeNewInboundTicket failed", e);
    // #region agent log
    console.warn(
      "[DBG-e46688 maybeDist] threw",
      JSON.stringify({
        convId: input.conversationId,
        err: e instanceof Error ? e.message : String(e),
      }),
    );
    // #endregion
  }
}

/**
 * Função central de drenagem da fila de espera.
 *
 * Regra: drena **por departamento** — nunca mistura filas de depts diferentes
 * num lote global. Com `userId` (agent_online / agent_eligible), só os depts
 * dessa pessoa. Sem `userId` (cron / manual / capacity), todos os depts da
 * fila de espera + os depts dos elegíveis — o motor aplica a fronteira
 * (`respectDepartment`). Sem isso, tickets de Acolhimento ficavam presos
 * enquanto o KPI mostrava elegíveis de outros depts.
 *
 * Dentro de cada dept: FIFO (mais antigos primeiro) com teto = capacidade
 * livre. Se o depto não tem membro elegível, usa a capacidade org-wide só
 * para puxar o lote; `executeDistribution` decide se atribui.
 * Capacidade é **global por consultor**; atribuições desta passagem entram
 * no delta antes de abrir o próximo bucket.
 */
export async function processPendingDistributionQueue(opts: {
  trigger: PendingQueueTrigger;
  /** Quando informado, restringe a drenagem aos departamentos desta pessoa. */
  userId?: string | null;
}): Promise<RetryResult> {
  const orgId = getOrgIdOrNull();
  if (!orgId) {
    return { resolved: 0, cancelled: 0, pending: 0, trigger: opts.trigger };
  }

  const state = getDrainState(orgId);
  if (state.running) {
    const pending = await prisma.conversation.count({
      where: await getWaitingQueueWhere(),
    });
    // Manual: não mente "ninguém elegível" — a drenagem já está no ar.
    if (opts.trigger === "manual") {
      return {
        resolved: 0,
        cancelled: 0,
        pending,
        trigger: opts.trigger,
        skipReason: "ALREADY_RUNNING",
        skipMessage:
          "A fila já está sendo reprocessada. Tente de novo em instantes.",
      };
    }
    // Coalesca: marca para re-rodar ao terminar.
    // 2º evento enquanto roda → amplia (todos os depts com elegível),
    // para não perder o dept de outro consultor que ficou elegível.
    if (state.queuedTrigger) {
      state.queuedUserId = null;
    } else {
      state.queuedUserId = opts.userId ?? null;
    }
    state.queuedTrigger = opts.trigger;
    return { resolved: 0, cancelled: 0, pending, trigger: opts.trigger };
  }

  state.running = true;
  try {
    const widgetActive = await hasOrganizationWidget("smart_distribution");
    console.warn(
      "[DBG-e46688 retry] widget check",
      JSON.stringify({
        widgetActive,
        trigger: opts.trigger,
        userId: opts.userId ?? null,
      }),
    );
    if (!widgetActive) {
      return { resolved: 0, cancelled: 0, pending: 0, trigger: opts.trigger };
    }

    const autoOnInbound = await isDistributionAutoOnInbound();
    const explicitPendingIds = autoOnInbound
      ? null
      : await listExplicitPendingConversationIds();

    let cancelledOrphans = 0;
    try {
      cancelledOrphans = await cancelStalePendingOrphans(orgId);
      if (cancelledOrphans > 0) {
        console.info(
          "[distribution] cancelStalePendingOrphans",
          JSON.stringify({
            orgId,
            trigger: opts.trigger,
            cancelled: cancelledOrphans,
          }),
        );
      }
    } catch (e) {
      console.warn("[distribution] cancelStalePendingOrphans failed", e);
    }

    let views: Awaited<ReturnType<typeof getDistributionResponsibles>> = [];
    try {
      views = await getDistributionResponsibles();
    } catch (e) {
      console.warn(
        "[distribution] processPending eligibility precheck failed",
        e,
      );
    }
    const eligible = views.filter((r) => r.eligible);

    if (eligible.length === 0) {
      const pending = await prisma.conversation.count({
        where: await getWaitingQueueWhere(),
      });
      console.info(
        "[distribution] processPending skip — nenhum consultor elegível",
        JSON.stringify({
          orgId,
          trigger: opts.trigger,
          pending,
          cancelledOrphans,
        }),
      );
      return {
        resolved: 0,
        cancelled: cancelledOrphans,
        pending,
        trigger: opts.trigger,
        skipReason: "NO_ELIGIBLE_RESPONSIBLE",
        skipMessage: "Ainda não há responsável elegível para a fila.",
      };
    }

    // Depts a drenar nesta passagem.
    let targetDeptIds: string[] = [];
    let includeOrgWide = false;

    if (opts.userId) {
      const focus = views.find((r) => r.userId === opts.userId);
      if (!focus?.eligible) {
        const pending = await prisma.conversation.count({
          where: await getWaitingQueueWhere(),
        });
        console.info(
          "[distribution] processPending skip — userId não elegível",
          JSON.stringify({
            orgId,
            trigger: opts.trigger,
            userId: opts.userId,
            pending,
          }),
        );
        return {
          resolved: 0,
          cancelled: cancelledOrphans,
          pending,
          trigger: opts.trigger,
        };
      }
      targetDeptIds = focus.departments.map((d) => d.id);
      // Sem dept: pode receber leads org-wide (sem departmentId na conversa).
      includeOrgWide = targetDeptIds.length === 0;
      // Com dept(s): também tenta org-wide (pool humano elegível inclui esta pessoa).
      if (targetDeptIds.length > 0) includeOrgWide = true;
    } else {
      const deptSet = new Set<string>();
      for (const r of eligible) {
        for (const d of r.departments) deptSet.add(d.id);
      }
      // Também drena depts que JÁ têm gente na espera — senão Acolhimento
      // (ou qualquer depto sem membro no KPI) nunca é tentado.
      const waitingDepts = await prisma.conversation.findMany({
        where: await getWaitingQueueWhere(),
        select: { departmentId: true },
      });
      for (const w of waitingDepts) {
        if (w.departmentId) deptSet.add(w.departmentId);
      }
      targetDeptIds = Array.from(deptSet);
      includeOrgWide = true;
    }

    let resolved = 0;
    let scanned = 0;
    /** Atribuições bem-sucedidas nesta passagem, por consultor (capacidade global). */
    const assignedDeltaByUser = new Map<string, number>();

    const drainBucket = async (departmentId: string | null) => {
      // Sem membro elegível neste depto: ainda puxa o lote com capacidade
      // org-wide. O motor aplica respectDepartment (atribui ou recusa).
      const inDept = eligibleInDeptScope(eligible, departmentId);
      const capDeptId = inDept.length > 0 ? departmentId : null;

      if (
        !hasRemainingCapacityInScope(
          eligible,
          capDeptId,
          assignedDeltaByUser,
        )
      ) {
        return;
      }

      let take = takeLimitForDept(
        eligible,
        capDeptId,
        assignedDeltaByUser,
      );

      if (take <= 0) return;

      // Também drena conversas ainda na IA com DistributionPending PENDING
      // (handoff noturno: a IA reassumiu para continuar o atendimento, mas
      // o lead precisa ir ao humano quando alguém ficar elegível).
      // Tag "Agente IA" / assignee AI NÃO bloqueia reprocesso humano.
      const pendingOwnedByAi = await prisma.distributionPending.findMany({
        where: {
          organizationId: orgId,
          status: "PENDING",
          conversationId: { not: null },
        },
        select: { conversationId: true },
        take: 500,
      });
      const pendingAiConvIds = pendingOwnedByAi
        .map((p) => p.conversationId)
        .filter((id): id is string => Boolean(id));

      // autoOnInbound=false: só drena quem já foi pedido à distribuição
      // (automação / IA / redistribuição manual). Senão o cron puxa a
      // aba Entrada inteira sem execute_distribution.
      if (explicitPendingIds && explicitPendingIds.length === 0) return;

      const items = await prisma.conversation.findMany({
        where: {
          ...(explicitPendingIds
            ? { id: { in: explicitPendingIds } }
            : { lastInboundAt: { not: null } }),
          status: "OPEN",
          departmentId: departmentId === null ? null : departmentId,
          OR: [
            { assignedToId: null },
            ...(pendingAiConvIds.length > 0
              ? [
                  {
                    id: { in: pendingAiConvIds },
                    assignedTo: { type: "AI" as const },
                  },
                ]
              : []),
          ],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, contactId: true, departmentId: true },
        take,
      });
      scanned += items.length;

      for (const it of items) {
        if (
          !hasRemainingCapacityInScope(
            eligible,
            departmentId,
            assignedDeltaByUser,
          )
        ) {
          console.info(
            "[distribution] processPending cap — scope capacity exhausted",
            JSON.stringify({
              orgId,
              trigger: opts.trigger,
              userId: opts.userId ?? null,
              departmentId,
              assignedDeltaByUser: Object.fromEntries(assignedDeltaByUser),
            }),
          );
          break;
        }

        try {
          const result = await executeDistribution({
            dealId: null,
            contactId: it.contactId,
            conversationId: it.id,
            distributionType: null,
            triggerSource: "SYSTEM",
            departmentId: it.departmentId,
            // Handoff com IA ainda assignee (após fila noturna) precisa reassign.
            reassign: true,
            allowOrgWideFallback: false,
          });
          console.warn(
            "[DBG-e46688 retry] executeDistribution",
            JSON.stringify({
              convId: it.id,
              departmentId: it.departmentId,
              success: result.success,
              reason: result.reason,
              selectedUserId: result.selectedUserId,
            }),
          );
          if (result.success) {
            resolved++;
            if (result.selectedUserId) {
              const uid = result.selectedUserId;
              assignedDeltaByUser.set(
                uid,
                (assignedDeltaByUser.get(uid) ?? 0) + 1,
              );

              if (opts.userId && uid === opts.userId) {
                const focus = eligible.find((r) => r.userId === opts.userId);
                if (
                  focus &&
                  liveFreeCapacityForUser(focus, assignedDeltaByUser) <= 0
                ) {
                  console.info(
                    "[distribution] processPending cap — user budget exhausted",
                    JSON.stringify({
                      orgId,
                      trigger: opts.trigger,
                      userId: opts.userId,
                      departmentId,
                      assignedInPass: assignedDeltaByUser.get(opts.userId) ?? 0,
                    }),
                  );
                }
              }
            }
          } else if (
            result.reason === "NO_ELIGIBLE_RESPONSIBLE" ||
            result.reason === "NO_DEPARTMENT"
          ) {
            // Capacidade do dept esgotou nesta passagem — para o bucket.
            break;
          }
        } catch (e) {
          console.error(
            "[distribution] processPendingDistributionQueue item failed",
            {
              conversationId: it.id,
              trigger: opts.trigger,
              err: e,
            },
          );
        }
      }
    };

    for (const deptId of targetDeptIds) {
      await drainBucket(deptId);
    }
    if (includeOrgWide) {
      await drainBucket(null);
    }

    const pending = await prisma.conversation.count({
      where: await getWaitingQueueWhere(),
    });

    let skipReason: string | null = null;
    let skipMessage: string | null = null;
    if (resolved === 0 && pending > 0) {
      const explained = await explainEmptyDrain({
        eligible,
        pendingCount: pending,
      });
      skipReason = explained.skipReason;
      skipMessage = explained.skipMessage;
    }

    if (
      resolved > 0 ||
      cancelledOrphans > 0 ||
      opts.trigger === "manual" ||
      opts.trigger === "scheduled"
    ) {
      console.info(
        "[distribution] processPendingDistributionQueue",
        JSON.stringify({
          orgId,
          trigger: opts.trigger,
          userId: opts.userId ?? null,
          targetDeptIds,
          includeOrgWide,
          resolved,
          cancelledOrphans,
          pending,
          scanned,
          skipReason,
        }),
      );
    }

    return {
      resolved,
      cancelled: cancelledOrphans,
      pending,
      trigger: opts.trigger,
      skipReason,
      skipMessage,
    };
  } finally {
    state.running = false;
    const queued = state.queuedTrigger;
    const queuedUserId = state.queuedUserId;
    state.queuedTrigger = null;
    state.queuedUserId = null;
    // Só re-drena se alguém ficou elegível / capacidade / manual.
    // `new_item` NÃO reentra sozinho — evita loop quando a fila está
    // cheia e ninguém ONLINE.
    if (
      queued &&
      (queued === "agent_online" ||
        queued === "agent_eligible" ||
        queued === "capacity_released" ||
        queued === "manual")
    ) {
      scheduleProcessPendingDistributionQueue({
        trigger: queued,
        delayMs: 500,
        userId: queuedUserId,
      });
    }
  }
}

/**
 * Compat: botão "Reprocessar agora" e callers legados.
 */
export async function retryPendingDistributions(): Promise<RetryResult> {
  return processPendingDistributionQueue({ trigger: "manual" });
}

/**
 * Agenda drenagem sem bloquear o caller (presença, enqueue, PATCH, etc.).
 * Debounce por org: vários gatilhos próximos viram uma única execução.
 */
export function scheduleProcessPendingDistributionQueue(opts: {
  trigger: PendingQueueTrigger;
  /** Default 500ms — agrupa rajadas (ex.: vários leads entrando juntos). */
  delayMs?: number;
  /** Restringe aos depts desta pessoa (agent_online / agent_eligible). */
  userId?: string | null;
}): void {
  const orgId = getOrgIdOrNull();
  if (!orgId) return;

  const delayMs = opts.delayMs ?? 500;
  const state = getDrainState(orgId);
  // Debounce por org: vários gatilhos próximos viram uma única execução.
  state.queuedTrigger = opts.trigger;
  if (
    opts.userId &&
    state.queuedUserId &&
    opts.userId !== state.queuedUserId
  ) {
    state.queuedUserId = null;
  } else if (!opts.userId) {
    state.queuedUserId = null;
  } else if (!state.timer) {
    state.queuedUserId = opts.userId;
  } else if (state.queuedUserId === opts.userId) {
    state.queuedUserId = opts.userId;
  }
  // Se já havia timer com outro escopo amplo (null), mantém amplo.

  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    const trigger = state.queuedTrigger ?? opts.trigger;
    const userId = state.queuedUserId;
    state.queuedTrigger = null;
    state.queuedUserId = null;

    void runWithContext(
      {
        organizationId: orgId,
        userId: "system",
        isSuperAdmin: false,
        actor: {
          type: "SYSTEM",
          label: "Distribuição Inteligente",
          sublabel: `queue:${trigger}`,
        },
      },
      () => processPendingDistributionQueue({ trigger, userId }),
    ).catch((e) => {
      console.error(
        "[distribution] scheduleProcessPendingDistributionQueue failed",
        e,
      );
    });
  }, delayMs);

  // Evita manter o processo Node vivo só por causa do timer em testes/scripts.
  if (typeof state.timer === "object" && state.timer && "unref" in state.timer) {
    try {
      state.timer.unref();
    } catch {
      /* ignore */
    }
  }
}
