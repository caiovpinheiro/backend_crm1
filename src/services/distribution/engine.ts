/**
 * Motor único da Distribuição Inteligente.
 *
 * Compartilhado por: distribuição real (`auto-deals.ts`, na Fase 6), ação de
 * automação (`execute_distribution`, Fase 5), execução manual e a tela
 * ("Testar distribuição"). A elegibilidade vem de `eligibility.ts` e a fila
 * de `queue.ts`, garantindo que tela, simulação e execução decidam igual.
 *
 * Seleção (v1): elegíveis → menor fila → desempate por `lastExecutionAt` mais
 * antigo (nunca executado tem prioridade). `volume` é apenas peso exibido na
 * v2, não entra na seleção v1.
 */

import { Prisma } from "@prisma/client";

import { getConversationSession } from "@/lib/channel-session";
import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { logEvent } from "@/services/activity-log";
import {
  assignDealOwner,
  propagateOwnerToContactAndChat,
  syncOwnershipForContact,
} from "@/services/deals";
import { hasOrganizationWidget } from "@/services/organization-widgets";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";

import {
  clearOwnershipForRedistribution,
  isAssigneeCurrentlyEligible,
  shouldClearOwnershipOnIneligible,
} from "./assignee-eligibility";
import type { DistributionBlockReason } from "./eligibility";
import {
  getDistributionResponsibles,
  type DistributionResponsibleView,
} from "./responsibles";

export type DistributionTriggerSource =
  | "SYSTEM"
  | "AUTOMATION"
  | "MANUAL"
  | "SIMULATION"
  /** Handoff / execute_distribution solicitado pelo agente de IA. */
  | "AI_AGENT";

export type DistributionReason =
  | "ASSIGNED"
  | "SMART_DISTRIBUTION_NOT_ENABLED"
  | "NO_ELIGIBLE_RESPONSIBLE"
  | "NO_DEPARTMENT"
  | "RETIRED_WHATSAPP_CHANNEL";

export interface ExecuteDistributionInput {
  dealId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  triggerSource: DistributionTriggerSource;
  /** Tipo/segmento solicitado (avalia `TYPE_INCOMPATIBLE`). */
  distributionType?: string | null;
  /**
   * Departamento-alvo explícito (opcional). Quando não vier, o motor resolve
   * pelo departamento da conversa (`Conversation.departmentId`, definido por
   * automações de transferência).
   */
  departmentId?: string | null;
  /**
   * Pool explícito de departamentos (automação `execute_distribution`).
   * Quando preenchido, ignora o toggle org `respectDepartment` e distribui
   * apenas entre membros de qualquer um desses departamentos.
   */
  departmentIds?: string[] | null;
  /**
   * Quando true, redistribui mesmo se a conversa já tiver responsável
   * (uso manual no inbox / handoff entre departamentos).
   */
  reassign?: boolean;
  /**
   * Quando true e o escopo de departamento (explícito ou da conversa) não
   * tiver NENHUM responsável elegível, cai para o escopo org-wide (todos os
   * elegíveis) em vez de deixar o lead preso na fila.
   *
   * DEFAULT/ATUAL: `false` em todos os fluxos (fronteira de departamento
   * ESTRITA — decisão de produto). Um lead roteado a um departamento só é
   * distribuído a quem estiver disponível NAQUELE departamento; se ninguém,
   * espera na fila do departamento e é drenado quando alguém do depto ficar
   * elegível. Leads SEM departamento já são org-wide (departmentScoped=false),
   * então este flag não os afeta. Mantido como opção para usos futuros.
   */
  allowOrgWideFallback?: boolean;
  /** Momento de referência (testes). Default: agora. */
  now?: Date;
}

/**
 * Escopo resolvido para uma distribuição:
 *  - `org-wide`: nenhum departamento da org opta por distribuição automática
 *    (feature não adotada) → comportamento clássico (todos os elegíveis).
 *  - `department`: o lead foi roteado a um departamento COM `distributionEnabled`
 *    → só membros desse departamento entram na disputa.
 *  - `blocked`: a org usa o recurso, mas este lead não está em um departamento
 *    habilitado (ou não tem departamento) → não distribui, vai pra fila.
 */
type DepartmentScope =
  | { mode: "org-wide"; departmentId: null }
  | { mode: "department"; departmentId: string }
  | { mode: "blocked"; departmentId: string | null };

/**
 * Resolve o escopo de departamento. A distribuição por departamento é POR
 * DEPARTAMENTO (`Department.distributionEnabled`), não um toggle global: cada
 * departamento decide se usa distribuição automática entre seus membros. Se
 * NENHUM departamento da org habilitou, mantém o comportamento org-wide
 * (retrocompatível). A regra individual de cada responsável continua valendo.
 */
async function resolveDepartmentScope(
  input: Pick<ExecuteDistributionInput, "conversationId" | "departmentId">,
): Promise<DepartmentScope> {
  // Opção da org (default DESLIGADO): só respeita o departamento da conversa
  // quando ligado. Desligado = distribuição CLÁSSICA org-wide (todos os
  // elegíveis), ignorando departamento — evita que conversas sem roteamento
  // fiquem presas na fila. Ligue quando existirem regras claras de roteamento.
  const respectDepartment = await getOrgSettingBool(
    "distribution.respectDepartment",
    false,
  );
  if (!respectDepartment) return { mode: "org-wide", departmentId: null };

  // Feature em uso? Só quando ao menos 1 departamento opta por distribuição.
  const enabledCount = await prisma.department.count({
    where: { distributionEnabled: true },
  });
  if (enabledCount === 0) return { mode: "org-wide", departmentId: null };

  // Resolve o departamento-alvo: explícito > conversa.
  let departmentId = input.departmentId ?? null;
  if (!departmentId && input.conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { departmentId: true },
    });
    departmentId = conv?.departmentId ?? null;
  }
  // Conversa SEM departamento identificado → distribui para todos os elegíveis
  // (comportamento clássico), em vez de bloquear na fila.
  if (!departmentId) return { mode: "org-wide", departmentId: null };

  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { distributionEnabled: true },
  });
  if (dept?.distributionEnabled) return { mode: "department", departmentId };
  // Departamento identificado mas que optou por NÃO distribuir automaticamente
  // → respeita o opt-out: fica na fila (manual).
  return { mode: "blocked", departmentId };
}

/** Diagnóstico compacto de um responsável (vai para o log e a resposta). */
export interface EvaluatedResponsibleSummary {
  userId: string;
  name: string | null;
  eligible: boolean;
  blockedReasons: DistributionBlockReason[];
  queueCount: number;
}

export interface DistributionResult {
  success: boolean;
  reason: DistributionReason;
  selectedUserId: string | null;
  selectedUserName: string | null;
  evaluated: EvaluatedResponsibleSummary[];
}

function toSummary(
  responsibles: DistributionResponsibleView[],
): EvaluatedResponsibleSummary[] {
  return responsibles.map((r) => ({
    userId: r.userId,
    name: r.name,
    eligible: r.eligible,
    blockedReasons: r.blockedReasons,
    queueCount: r.queueCount,
  }));
}

/**
 * Seleciona o responsável: menor fila; empate → `lastExecutionAt` mais antigo
 * (nunca executado = prioridade máxima). Assume lista já filtrada por elegíveis
 * e não vazia.
 */
export function selectResponsible(
  eligible: DistributionResponsibleView[],
): DistributionResponsibleView {
  return [...eligible].sort((a, b) => {
    if (a.queueCount !== b.queueCount) return a.queueCount - b.queueCount;
    const aTime = a.lastExecutionAt ? Date.parse(a.lastExecutionAt) : 0;
    const bTime = b.lastExecutionAt ? Date.parse(b.lastExecutionAt) : 0;
    return aTime - bTime;
  })[0];
}

/**
 * Enfileira um lead na fila de espera (DistributionPending) quando nenhum
 * responsável estava elegível. Idempotente: se já existe um PENDING para o
 * mesmo deal/contato, apenas incrementa `attempts`/`lastAttemptAt`.
 */
/**
 * Garante contactId/dealId a partir da conversa — o handoff manual do inbox
 * às vezes manda só conversationId; sem isso o enqueue era no-op e o lead
 * sumia da fila de espera.
 */
async function hydrateDistributionIds(
  input: ExecuteDistributionInput,
): Promise<ExecuteDistributionInput> {
  if ((input.dealId && input.contactId) || !input.conversationId) return input;
  const conv = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: { contactId: true },
  });
  const contactId = input.contactId ?? conv?.contactId ?? null;
  let dealId = input.dealId ?? null;
  if (!dealId && contactId) {
    const openDeal = await prisma.deal.findFirst({
      where: { contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    dealId = openDeal?.id ?? null;
  }
  return { ...input, contactId, dealId };
}

async function enqueuePending(input: ExecuteDistributionInput): Promise<void> {
  const hydrated = await hydrateDistributionIds(input);
  if (!hydrated.dealId && !hydrated.contactId) return;
  try {
    // Sem inbound do aluno (ex.: só template BV/Bem-vindo) não entra na fila —
    // exceto redistribuição MANUAL (operador mandou p/ departamento com fila
    // cheia): aí o lead precisa aparecer na espera mesmo sem novo inbound.
    const isManual = hydrated.triggerSource === "MANUAL";
    if (hydrated.conversationId && !isManual) {
      const conv = await prisma.conversation.findUnique({
        where: { id: hydrated.conversationId },
        select: { lastInboundAt: true },
      });
      if (!conv?.lastInboundAt) {
        console.info(
          "[distribution] enqueuePending skip — sem inbound do aluno",
          JSON.stringify({ conversationId: hydrated.conversationId }),
        );
        return;
      }
    }
    const existing = await prisma.distributionPending.findFirst({
      where: {
        status: "PENDING",
        ...(hydrated.dealId
          ? { dealId: hydrated.dealId }
          : { contactId: hydrated.contactId }),
      },
      select: { id: true, attempts: true, triggerSource: true },
    });
    if (existing) {
      await prisma.distributionPending.update({
        where: { id: existing.id },
        data: {
          attempts: existing.attempts + 1,
          lastAttemptAt: new Date(),
          // Preserva origem IA se a tentativa atual (ou anterior) veio do agente.
          triggerSource: mergeTriggerSources(
            existing.triggerSource ?? hydrated.triggerSource,
            hydrated.triggerSource,
          ),
          ...(hydrated.conversationId
            ? { conversationId: hydrated.conversationId }
            : {}),
        },
      });
    } else {
      await prisma.distributionPending.create({
        data: {
          organizationId: getOrgIdOrThrow(),
          dealId: hydrated.dealId ?? null,
          contactId: hydrated.contactId ?? null,
          conversationId: hydrated.conversationId ?? null,
          distributionType: hydrated.distributionType ?? null,
          triggerSource: hydrated.triggerSource,
          status: "PENDING",
          attempts: 1,
          lastAttemptAt: new Date(),
        },
      });
    }
    // NÃO agenda retry automático aqui. Com fila cheia / ninguém ONLINE,
    // reprocessar a cada falha vira loop (CPU alto). A drenagem só roda
    // quando alguém fica elegível (online/capacidade), no cron periódico
    // ou no botão manual.
  } catch (e) {
    console.error("[distribution] falha ao enfileirar pendência", e);
  }
}

/** Marca como RESOLVED qualquer pendência aberta do mesmo lead. */
async function resolvePendingFor(
  dealId: string | null | undefined,
  contactId: string | null | undefined,
  userId: string,
): Promise<void> {
  if (!dealId && !contactId) return;
  try {
    // Safety: never close a human-queue pending onto an AI user.
    const resolverUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { type: true },
    });
    if (resolverUser?.type === "AI") {
      console.warn("[distribution] resolvePendingFor skipped — userId is AI", { userId });
      return;
    }
    await prisma.distributionPending.updateMany({
      where: {
        status: "PENDING",
        ...(dealId ? { dealId } : { contactId }),
      },
      data: { status: "RESOLVED", resolvedUserId: userId, resolvedAt: new Date() },
    });
  } catch (e) {
    console.error("[distribution] falha ao resolver pendência", e);
  }
}

/**
 * Grava um evento no feed de atividades (/logs do CRM) para a distribuição.
 * Observabilidade — nunca derruba a distribuição se falhar.
 */
async function emitDistributionEvent(
  input: ExecuteDistributionInput,
  success: boolean,
  reason: DistributionReason,
  selectedUserId: string | null,
  selectedUserName: string | null,
  assignedDealId: string | null,
): Promise<void> {
  const entityId =
    assignedDealId ?? input.contactId ?? input.conversationId ?? null;
  if (!entityId) return;
  let conversationId = input.conversationId ?? null;
  if (!conversationId && input.contactId) {
    const openConv = await prisma.conversation.findFirst({
      where: { contactId: input.contactId, status: { not: "RESOLVED" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    conversationId = openConv?.id ?? null;
  }
  let departmentName: string | null = null;
  if (conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { department: { select: { name: true } } },
    });
    departmentName = conv?.department?.name ?? null;
  } else if (input.departmentId) {
    const dept = await prisma.department.findUnique({
      where: { id: input.departmentId },
      select: { name: true },
    });
    departmentName = dept?.name ?? null;
  }
  try {
    await logEvent({
      type: success ? "LEAD_DISTRIBUTED" : "LEAD_DISTRIBUTION_FAILED",
      entityType: assignedDealId ? "DEAL" : conversationId ? "CONVERSATION" : "CONTACT",
      entityId: assignedDealId ?? conversationId ?? entityId,
      entityLabel: selectedUserName ?? null,
      dealId: assignedDealId,
      contactId: input.contactId ?? null,
      conversationId,
      field: "owner",
      newValue: selectedUserName ?? null,
      meta: {
        reason,
        triggerSource: input.triggerSource,
        selectedUserId,
        ...(departmentName ? { departmentName } : {}),
      },
      actor: {
        type:
          input.triggerSource === "AUTOMATION" ||
          input.triggerSource === "AI_AGENT"
            ? "AUTOMATION"
            : "SYSTEM",
        label:
          input.triggerSource === "AI_AGENT"
            ? "Agente IA · Distribuição"
            : "Distribuição Inteligente",
      },
    });
  } catch (e) {
    console.error("[distribution] falha ao gravar evento no feed", e);
  }
}

/** Janela para juntar retries do mesmo lead (automação + drenagem SYSTEM). */
const LOG_COALESCE_WINDOW_MS = 45_000;

const TRIGGER_MERGE_ORDER: DistributionTriggerSource[] = [
  "AI_AGENT",
  "AUTOMATION",
  "MANUAL",
  "SYSTEM",
  "SIMULATION",
];

function mergeTriggerSources(
  existing: string,
  next: DistributionTriggerSource,
): string {
  const parts = new Set(
    existing
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  parts.add(next);
  const ordered = TRIGGER_MERGE_ORDER.filter((t) => parts.has(t));
  for (const t of parts) {
    if (!ordered.includes(t as DistributionTriggerSource)) ordered.push(t);
  }
  return ordered.join("+");
}

async function resolveLogDepartmentId(
  input: ExecuteDistributionInput,
): Promise<string | null> {
  const fromInput =
    input.departmentId ??
    input.departmentIds?.find((id) => typeof id === "string" && id.length > 0) ??
    null;
  if (fromInput) return fromInput;
  if (!input.conversationId) return null;
  const conv = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: { departmentId: true },
  });
  return conv?.departmentId ?? null;
}

async function writeLog(
  input: ExecuteDistributionInput,
  success: boolean,
  reason: DistributionReason,
  selectedUserId: string | null,
  evaluated: EvaluatedResponsibleSummary[],
): Promise<void> {
  try {
    const orgId = getOrgIdOrThrow();
    const since = new Date(Date.now() - LOG_COALESCE_WINDOW_MS);
    const departmentId = await resolveLogDepartmentId(input);

    // Mesmo atendimento/contato/deal + mesmo resultado em janela curta →
    // atualiza o log existente (junta AUTOMATION+SYSTEM) em vez de duplicar.
    const identity: Prisma.DistributionLogWhereInput | null =
      input.conversationId
        ? { conversationId: input.conversationId }
        : input.contactId
          ? { contactId: input.contactId }
          : input.dealId
            ? { dealId: input.dealId }
            : null;

    if (identity) {
      const recent = await prisma.distributionLog.findFirst({
        where: {
          ...identity,
          success,
          reason,
          createdAt: { gte: since },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, triggerSource: true },
      });
      if (recent) {
        await prisma.distributionLog.update({
          where: { id: recent.id },
          data: {
            triggerSource: mergeTriggerSources(
              recent.triggerSource,
              input.triggerSource,
            ),
            selectedUserId,
            dealId: input.dealId ?? undefined,
            contactId: input.contactId ?? undefined,
            conversationId: input.conversationId ?? undefined,
            ...(departmentId ? { departmentId } : {}),
            evaluated: evaluated as unknown as Prisma.InputJsonValue,
          },
        });
        return;
      }
    }

    await prisma.distributionLog.create({
      data: {
        organizationId: orgId,
        triggerSource: input.triggerSource,
        dealId: input.dealId ?? null,
        contactId: input.contactId ?? null,
        conversationId: input.conversationId ?? null,
        departmentId,
        selectedUserId,
        success,
        reason,
        evaluated: evaluated as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    // Log é observabilidade — nunca deve derrubar a distribuição.
    console.error("[distribution] falha ao gravar DistributionLog", e);
  }
}

/**
 * Distribuição REAL: avalia, seleciona, ATRIBUI o owner (propagando para
 * contato/conversa), atualiza `lastExecutionAt` e grava `DistributionLog`.
 * Deve rodar dentro de `withOrgContext` / contexto org-scoped.
 */
export async function executeDistribution(
  rawInput: ExecuteDistributionInput,
): Promise<DistributionResult> {
  if (!(await hasOrganizationWidget("smart_distribution"))) {
    return {
      success: false,
      reason: "SMART_DISTRIBUTION_NOT_ENABLED",
      selectedUserId: null,
      selectedUserName: null,
      evaluated: [],
    };
  }

  if (rawInput.conversationId) {
    const retiredConv = await prisma.conversation.findUnique({
      where: { id: rawInput.conversationId },
      select: {
        channelRef: {
          select: { name: true, phoneNumber: true, config: true },
        },
      },
    });
    if (isRetiredWhatsAppChannel(retiredConv?.channelRef)) {
      await prisma.distributionPending.updateMany({
        where: {
          conversationId: rawInput.conversationId,
          status: "PENDING",
        },
        data: { status: "CANCELLED" },
      });
      return {
        success: false,
        reason: "RETIRED_WHATSAPP_CHANNEL",
        selectedUserId: null,
        selectedUserName: null,
        evaluated: [],
      };
    }
  }

  const input = await hydrateDistributionIds(rawInput);

  // Snapshot ANTES do reassign limpar o assignee — usado para disparar
  // `lead_distributed` quando um HUMAN assume vindo de IA/sem dono
  // (mesmo se a conversa já teve resposta humana antes).
  let preAssignSnap: {
    assignedToId: string | null;
    assigneeType: string | null;
    departmentId: string | null;
    contactId: string | null;
  } | null = null;
  if (input.conversationId) {
    const snap = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        assignedToId: true,
        departmentId: true,
        contactId: true,
        assignedTo: { select: { type: true } },
      },
    });
    if (snap) {
      preAssignSnap = {
        assignedToId: snap.assignedToId,
        assigneeType: snap.assignedTo?.type ?? null,
        departmentId: snap.departmentId,
        contactId: snap.contactId,
      };
    }
  }

  // Idempotente: se a conversa já tem responsável (ex.: inbound acabou de
  // distribuir e a automação dispara execute_distribution de novo), não
  // reatribui — salvo `reassign` (handoff manual para departamento).
  // Antes de sair, cura deal/contato sem owner (pipeline "Sem responsável").
  if (input.conversationId && !input.reassign) {
    const already = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { assignedToId: true, contactId: true },
    });
    if (already?.assignedToId) {
      const contactId = input.contactId ?? already.contactId ?? null;
      const check = await isAssigneeCurrentlyEligible(already.assignedToId);
      // O teto de fila barra lead NOVO; não tira de quem já é responsável.
      // Soltar o dono por fila cheia jogaria o ticket na fila de espera sem
      // ninguém elegível. Offline / fora do expediente seguem liberando.
      const keepHumanAssignee =
        !check.isAi &&
        (check.eligible ||
          !shouldClearOwnershipOnIneligible(
            check.reason,
            check.blockedReasons,
          ));
      // IA nunca conta como distribuição humana bem-sucedida — limpa e segue.
      if (check.isAi && contactId) {
        await clearOwnershipForRedistribution({
          conversationId: input.conversationId,
          contactId,
        });
      } else if (!keepHumanAssignee && contactId) {
        // Offline/indisponível herdado: limpa e segue redistribuição.
        await clearOwnershipForRedistribution({
          conversationId: input.conversationId,
          contactId,
        });
      } else if (keepHumanAssignee) {
        if (contactId) {
          await syncOwnershipForContact(contactId);
        } else if (input.dealId) {
          const deal = await prisma.deal.findUnique({
            where: { id: input.dealId },
            select: { ownerId: true, contactId: true },
          });
          if (deal && !deal.ownerId) {
            await assignDealOwner(input.dealId, already.assignedToId);
          } else if (deal?.contactId) {
            await syncOwnershipForContact(deal.contactId);
          }
        }
        await resolvePendingFor(
          input.dealId,
          contactId,
          already.assignedToId,
        );
        return {
          success: true,
          reason: "ASSIGNED",
          selectedUserId: already.assignedToId,
          selectedUserName: null,
          evaluated: [],
        };
      }
    }
  }

  // Conversa sem assignee mas deal/contato já tem dono → espelha pro chat
  // antes de tentar redistribuir (evita "já tem owner no pipeline" + inbox vazio).
  if (!input.reassign) {
    const contactId =
      input.contactId ??
      (input.conversationId
        ? (
            await prisma.conversation.findUnique({
              where: { id: input.conversationId },
              select: { contactId: true },
            })
          )?.contactId
        : null) ??
      (input.dealId
        ? (
            await prisma.deal.findUnique({
              where: { id: input.dealId },
              select: { contactId: true },
            })
          )?.contactId
        : null);
    if (contactId) {
      const healed = await syncOwnershipForContact(contactId);
      if (healed && input.conversationId) {
        const healCheck = await isAssigneeCurrentlyEligible(healed);
        const healKeep =
          !healCheck.isAi &&
          (healCheck.eligible ||
            !shouldClearOwnershipOnIneligible(
              healCheck.reason,
              healCheck.blockedReasons,
            ));
        if (!healKeep) {
          await clearOwnershipForRedistribution({
            conversationId: input.conversationId,
            contactId,
          });
        } else {
          const again = await prisma.conversation.findUnique({
            where: { id: input.conversationId },
            select: { assignedToId: true },
          });
          if (again?.assignedToId) {
            await resolvePendingFor(
              input.dealId,
              contactId,
              again.assignedToId,
            );
            return {
              success: true,
              reason: "ASSIGNED",
              selectedUserId: again.assignedToId,
              selectedUserName: null,
              evaluated: [],
            };
          }
        }
      }
    }
  }

  // Handoff: libera o responsável atual antes de redistribuir — se ninguém
  // estiver elegível, o lead fica na fila de espera (sem dono antigo).
  if (input.reassign && input.conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { assignedToId: true, contactId: true },
    });
    const contactId = conv?.contactId ?? input.contactId ?? null;
    if (conv?.assignedToId) {
      await prisma.$transaction(async (tx) => {
        await tx.conversation.update({
          where: { id: input.conversationId! },
          data: { assignedToId: null },
        });
        if (contactId) {
          await tx.contact.update({
            where: { id: contactId },
            data: { assignedToId: null },
          });
          await tx.deal.updateMany({
            where: { contactId, status: "OPEN" },
            data: { ownerId: null },
          });
        }
      });
    } else if (contactId) {
      // A conversa já chegou sem responsável — o handoff acadêmico limpa
      // `assignedToId` antes de chamar o motor. Nesse caminho contato/deal
      // ainda apontavam para o usuário IA: com fila cheia o lead ia para a
      // espera com a IA como dono no pipeline e o `syncOwnership` seguinte
      // devolvia o card para a aba Agente IA. Só limpa quando o dono é IA;
      // dono humano continua preservado para o motor decidir.
      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        select: { assignedTo: { select: { type: true } } },
      });
      if (contact?.assignedTo?.type === "AI") {
        await prisma.$transaction(async (tx) => {
          await tx.contact.update({
            where: { id: contactId },
            data: { assignedToId: null },
          });
          await tx.deal.updateMany({
            where: { contactId, status: "OPEN" },
            data: { ownerId: null },
          });
        });
      }
    }
  }

  // Pool explícito (departmentIds) ou departmentId da conversa — força
  // o escopo mesmo com respectDepartment=false. Sem isso a drenagem
  // SYSTEM entregava lead de Retenção para Atendimento. Sem departmentId
  // o lead continua org-wide.
  const requestedDeptIds = Array.from(
    new Set(
      [
        ...(input.departmentIds ?? []),
        ...(input.departmentId ? [input.departmentId] : []),
      ].filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  // Nunca aceita departmentId de outra organização (cross-tenant).
  const orgIdForDept = getOrgIdOrThrow();
  const explicitDeptIds =
    requestedDeptIds.length > 0
      ? (
          await prisma.department.findMany({
            where: {
              organizationId: orgIdForDept,
              id: { in: requestedDeptIds },
            },
            select: { id: true },
          })
        ).map((d) => d.id)
      : [];

  let responsibles;
  let departmentScoped = false;
  if (explicitDeptIds.length > 0) {
    // Marca a conversa com o 1º departamento (contexto/inbox); o pool
    // de elegíveis usa TODOS os IDs selecionados.
    if (input.conversationId) {
      await prisma.conversation.update({
        where: { id: input.conversationId },
        data: { departmentId: explicitDeptIds[0]! },
      });
    }
    responsibles = await getDistributionResponsibles({
      distributionType: input.distributionType ?? null,
      now: input.now,
      departmentIds: explicitDeptIds,
    });
    departmentScoped = true;
  } else {
    // Distribuição por departamento (flag por depto). A org usa o recurso mas
    // este lead não está num departamento habilitado (ou sem departamento) →
    // não distribui (fallback = fila), respeitando a fronteira do departamento.
    const deptScope = await resolveDepartmentScope(input);
    if (deptScope.mode === "blocked") {
      await writeLog(input, false, "NO_DEPARTMENT", null, []);
      await enqueuePending(input);
      await emitDistributionEvent(input, false, "NO_DEPARTMENT", null, null, null);
      return {
        success: false,
        reason: "NO_DEPARTMENT",
        selectedUserId: null,
        selectedUserName: null,
        evaluated: [],
      };
    }

    departmentScoped = deptScope.mode === "department";
    responsibles = await getDistributionResponsibles({
      distributionType: input.distributionType ?? null,
      now: input.now,
      departmentId: deptScope.mode === "department" ? deptScope.departmentId : null,
    });
  }
  let evaluated = toSummary(responsibles);
  let eligible = responsibles.filter((r) => r.eligible);

  // Fallback org-wide: um departamento sem NINGUÉM elegível (offline / fila
  // cheia / sem membros) prendia o lead na fila para sempre — mesmo havendo
  // consultores elegíveis em outros departamentos. Nos gatilhos de SISTEMA
  // (drenagem/reprocess/inbound) o departamento é preferência, não prisão:
  // se vazio, tenta todos os elegíveis antes de enfileirar.
  if (eligible.length === 0 && input.allowOrgWideFallback && departmentScoped) {
    const orgWide = await getDistributionResponsibles({
      distributionType: input.distributionType ?? null,
      now: input.now,
    });
    const orgEligible = orgWide.filter((r) => r.eligible);
    if (orgEligible.length > 0) {
      responsibles = orgWide;
      evaluated = toSummary(orgWide);
      eligible = orgEligible;
    }
  }

  if (eligible.length === 0) {
    // Ninguém elegível: não força atribuição. Registra no log E enfileira o
    // lead na fila de espera, para redistribuir quando alguém ficar ONLINE.
    await writeLog(input, false, "NO_ELIGIBLE_RESPONSIBLE", null, evaluated);
    await enqueuePending(input);
    await emitDistributionEvent(
      input,
      false,
      "NO_ELIGIBLE_RESPONSIBLE",
      null,
      null,
      null,
    );
    return {
      success: false,
      reason: "NO_ELIGIBLE_RESPONSIBLE",
      selectedUserId: null,
      selectedUserName: null,
      evaluated,
    };
  }

  const selected = selectResponsible(eligible);

  // Atribui o owner. Quando veio um dealId explícito, usa-o. Quando veio só
  // contactId (ex.: automação manual disparada pela conversa), resolvemos o
  // negócio ABERTO do contato e atribuímos TAMBÉM o deal — senão o lead
  // aparece "Sem responsável" no pipeline. assignDealOwner já propaga para
  // contato e conversas; sem deal aberto, propagamos direto.
  let assignedDealId: string | null = input.dealId ?? null;
  if (input.dealId) {
    await assignDealOwner(input.dealId, selected.userId);
  } else if (input.contactId) {
    const contactId = input.contactId;
    const openDeal = await prisma.deal.findFirst({
      where: { contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (openDeal) {
      assignedDealId = openDeal.id;
      await assignDealOwner(openDeal.id, selected.userId);
    } else {
      await prisma.$transaction((tx) =>
        propagateOwnerToContactAndChat(tx, contactId, selected.userId),
      );
    }
  } else if (input.conversationId) {
    // Fallback: só conversationId — atribui o chat direto (e o deal aberto
    // do contato, se houver) para não "sucesso" sem dono após reassign.
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: { assignedToId: selected.userId },
    });
    const conv = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { contactId: true },
    });
    if (conv?.contactId) {
      const openDeal = await prisma.deal.findFirst({
        where: { contactId: conv.contactId, status: "OPEN" },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      if (openDeal) {
        assignedDealId = openDeal.id;
        await assignDealOwner(openDeal.id, selected.userId);
      } else {
        await prisma.$transaction((tx) =>
          propagateOwnerToContactAndChat(tx, conv.contactId!, selected.userId),
        );
      }
    }
  }

  const orgId = getOrgIdOrThrow();
  await prisma.distributionResponsible.upsert({
    where: {
      organizationId_userId: { organizationId: orgId, userId: selected.userId },
    },
    update: { lastExecutionAt: new Date() },
    create: {
      organizationId: orgId,
      userId: selected.userId,
      lastExecutionAt: new Date(),
    },
  });

  await resolvePendingFor(input.dealId, input.contactId, selected.userId);
  await writeLog(input, true, "ASSIGNED", selected.userId, evaluated);
  await emitDistributionEvent(
    input,
    true,
    "ASSIGNED",
    selected.userId,
    selected.name,
    assignedDealId,
  );

  // Handoff acadêmico / drenagem da fila → estágio "Em Atendimento".
  // Await: o card precisa estar no funil operacional assim que o consultor
  // humano for responsável (fire-and-forget perdia corridas com o inbox).
  let selectedIsHuman = false;
  try {
    const assigneeType = await prisma.user.findUnique({
      where: { id: selected.userId },
      select: { type: true },
    });
    selectedIsHuman = assigneeType?.type === "HUMAN";
  } catch {
    selectedIsHuman = false;
  }

  if (
    selectedIsHuman &&
    (input.triggerSource === "AI_AGENT" ||
      (input.triggerSource === "SYSTEM" && Boolean(input.departmentId)))
  ) {
    try {
      const { getVerticalPack } = await import("@/verticals");
      const moveOpenDealToEmAtendimento = getVerticalPack("academic")!.ops.moveOpenDealToEmAtendimento;
      await moveOpenDealToEmAtendimento({
        dealId: assignedDealId,
        contactId: input.contactId ?? null,
      });
    } catch (e) {
      console.error("[distribution] moveOpenDealToEmAtendimento failed", e);
    }
  }

  // Saudação pós-distribuição (`lead_distributed`): HUMAN assumindo vindo
  // de IA/null. Não re-dispara em handoff humano→humano.
  //
  // Fora da janela Meta 24h a saudação em texto livre falha (131047) e marca
  // hasError — típico após disparo HSM em ticket antigo. Sem inbound recente
  // NÃO dispara a automação; o aluno reabre a janela ao responder o template.
  const priorWasHuman = preAssignSnap?.assigneeType === "HUMAN";
  let sessionOpenForFreeText = true;
  if (input.conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        id: true,
        contactId: true,
        channel: true,
        channelId: true,
        lastInboundAt: true,
      },
    });
    sessionOpenForFreeText = conv
      ? (await getConversationSession(conv)).active
      : false;
  }
  const shouldFireLeadDistributed =
    selectedIsHuman && !priorWasHuman && sessionOpenForFreeText;

  if (shouldFireLeadDistributed) {
    const contactId =
      input.contactId ?? preAssignSnap?.contactId ?? null;
    const departmentId =
      input.departmentId ??
      explicitDeptIds[0] ??
      preAssignSnap?.departmentId ??
      null;
    if (contactId) {
      const { fireTrigger } = await import("@/services/automation-triggers");
      fireTrigger("lead_distributed", {
        contactId,
        dealId: assignedDealId ?? input.dealId ?? undefined,
        data: {
          conversationId: input.conversationId ?? undefined,
          departmentId: departmentId ?? undefined,
          assignedToId: selected.userId,
          assignedToName: selected.name,
          triggerSource: input.triggerSource,
        },
      }).catch((err) =>
        console.warn(
          "[distribution] fireTrigger lead_distributed:",
          err instanceof Error ? err.message : err,
        ),
      );
    }
  } else if (selectedIsHuman && !priorWasHuman && !sessionOpenForFreeText) {
    console.info(
      "[distribution] skip lead_distributed — sessão 24h fechada",
      JSON.stringify({
        conversationId: input.conversationId ?? null,
        triggerSource: input.triggerSource,
        selectedUserId: selected.userId,
      }),
    );
  }

  return {
    success: true,
    reason: "ASSIGNED",
    selectedUserId: selected.userId,
    selectedUserName: selected.name,
    evaluated,
  };
}

/**
 * Simulação ("Testar distribuição"): faz a MESMA avaliação/seleção, mas NÃO
 * atribui, NÃO atualiza `lastExecutionAt` e NÃO grava log. Retorna o
 * diagnóstico completo + a escolha prevista.
 */
export async function simulateDistribution(
  input: Omit<ExecuteDistributionInput, "triggerSource">,
): Promise<DistributionResult> {
  if (!(await hasOrganizationWidget("smart_distribution"))) {
    return {
      success: false,
      reason: "SMART_DISTRIBUTION_NOT_ENABLED",
      selectedUserId: null,
      selectedUserName: null,
      evaluated: [],
    };
  }

  // Simulação: escopa ao departamento apenas quando resolvido para um depto
  // habilitado; caso contrário simula org-wide (o "testar" genérico não tem
  // lead atrelado, então não bloqueia).
  const deptScope = await resolveDepartmentScope(input);

  const responsibles = await getDistributionResponsibles({
    distributionType: input.distributionType ?? null,
    now: input.now,
    departmentId: deptScope.mode === "department" ? deptScope.departmentId : null,
  });
  const evaluated = toSummary(responsibles);
  const eligible = responsibles.filter((r) => r.eligible);

  if (eligible.length === 0) {
    return {
      success: false,
      reason: "NO_ELIGIBLE_RESPONSIBLE",
      selectedUserId: null,
      selectedUserName: null,
      evaluated,
    };
  }

  const selected = selectResponsible(eligible);
  return {
    success: true,
    reason: "ASSIGNED",
    selectedUserId: selected.userId,
    selectedUserName: selected.name,
    evaluated,
  };
}
