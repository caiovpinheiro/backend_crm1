/**
 * Motor da Distribuição por Leads (modo "leads").
 *
 * Síncrono, SEM fila de espera: acionado pelo bloco `execute_distribution`
 * com mode="leads" (worker-automation). Considera SOMENTE a configuração
 * própria (DistributionLeadsParticipant: status administrativo + peso 0..5) —
 * nunca presença, pausa, expediente, queueLimit, departamento ou tipo do
 * smart. A seleção é o rodízio de slots por `lastAssignedAt` (NULL primeiro),
 * dentro de UMA transaction serializada por organização (advisory lock) — o
 * CAS do alvo protege a corrida no item; o lock protege a proporção entre
 * leads distintos.
 *
 * Idempotência: `DistributionLeadsExecution` registra TODO outcome por
 * (automationContextId, stepId, occurrence); a occurrence só avança junto ao
 * avanço do fluxo (variables do AutomationContext). Retry antes do avanço
 * durável reencontra o resultado gravado — sem consumir slot nem duplicar
 * histórico.
 *
 * Nunca remove dono humano existente (DONO_PRESERVADO), salvo `reassign`
 * explícito (CAS com o dono esperado). Sem elegível: NO_ELIGIBLE_PARTICIPANT
 * — o alvo fica marcado (routeMode="leads") fora do smart, sem fila e sem
 * fallback.
 */

import { Prisma } from "@prisma/client";

import { getConversationSession } from "@/lib/channel-session";
import { prisma, type ScopedTx } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { logEvent } from "@/services/activity-log";
import {
  assignDealOwnerTx,
  invalidateBoardsForPipelines,
  propagateOwnerToContactAndChat,
} from "@/services/deals";
import { hasOrganizationWidget } from "@/services/organization-widgets";

import {
  claimConversationAssignmentTx,
  claimDealAssignmentTx,
} from "../claim";
import { isLeadsDistributionEnabled } from "./enabled";

export type LeadsDistributionReason =
  | "ASSIGNED"
  | "NO_ELIGIBLE_PARTICIPANT"
  | "DONO_PRESERVADO"
  | "NO_TARGET"
  | "SMART_DISTRIBUTION_NOT_ENABLED"
  | "DISTRIBUTION_DISABLED";

export interface LeadsDistributionResult {
  success: boolean;
  reason: LeadsDistributionReason;
  selectedUserId: string | null;
  selectedUserName: string | null;
}

export interface ExecuteLeadsDistributionInput {
  dealId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  triggerSource: "AUTOMATION" | "MANUAL" | "SYSTEM";
  /** Única forma de o modo leads trocar um dono humano existente. */
  reassign?: boolean;
  /** Identidade da ocorrência do passo (idempotência). */
  automationContextId?: string | null;
  stepId?: string | null;
  occurrence?: number | null;
}

interface LeadsTarget {
  targetKey: string;
  contactId: string | null;
  dealId: string | null;
  conversationId: string | null;
  /** Dono humano vigente (conversa → deal → contato). */
  currentHumanOwnerId: string | null;
  currentHumanOwnerName: string | null;
  /** Há dono IA em alguma das projeções (CAS handoff IA→humano cobre). */
  currentOwnerIsAi: boolean;
}

async function hydrateLeadsTarget(
  input: ExecuteLeadsDistributionInput,
): Promise<LeadsTarget | null> {
  let conversationId = input.conversationId ?? null;
  let contactId = input.contactId ?? null;
  let dealId = input.dealId ?? null;

  let conv: {
    id: string;
    contactId: string;
    assignedToId: string | null;
    assignedTo: { type: string; name: string | null } | null;
  } | null = null;
  if (conversationId) {
    conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        contactId: true,
        assignedToId: true,
        assignedTo: { select: { type: true, name: true } },
      },
    });
    if (!conv) return null;
    contactId = contactId ?? conv.contactId ?? null;
  }

  let deal: {
    id: string;
    contactId: string | null;
    ownerId: string | null;
    owner: { type: string; name: string | null } | null;
  } | null = null;
  if (dealId) {
    deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        contactId: true,
        ownerId: true,
        owner: { select: { type: true, name: true } },
      },
    });
    contactId = contactId ?? deal?.contactId ?? null;
  } else if (contactId) {
    deal = await prisma.deal.findFirst({
      where: { contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        contactId: true,
        ownerId: true,
        owner: { select: { type: true, name: true } },
      },
    });
    dealId = deal?.id ?? null;
  }

  let contact: {
    id: string;
    assignedToId: string | null;
    assignedTo: { type: string; name: string | null } | null;
  } | null = null;
  if (contactId) {
    contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        id: true,
        assignedToId: true,
        assignedTo: { select: { type: true, name: true } },
      },
    });
  }

  if (!conversationId && !dealId && !contactId) return null;

  const humanFrom =
    conv?.assignedTo?.type === "HUMAN" && conv.assignedToId
      ? { id: conv.assignedToId, name: conv.assignedTo?.name ?? null }
      : deal?.owner?.type === "HUMAN" && deal.ownerId
        ? { id: deal.ownerId, name: deal.owner?.name ?? null }
        : contact?.assignedTo?.type === "HUMAN" && contact.assignedToId
          ? { id: contact.assignedToId, name: contact.assignedTo?.name ?? null }
          : null;

  const targetKey = contactId
    ? `contact:${contactId}`
    : dealId
      ? `deal:${dealId}`
      : `conversation:${conversationId}`;

  return {
    targetKey,
    contactId,
    dealId,
    conversationId,
    currentHumanOwnerId: humanFrom?.id ?? null,
    currentHumanOwnerName: humanFrom?.name ?? null,
    currentOwnerIsAi:
      conv?.assignedTo?.type === "AI" ||
      deal?.owner?.type === "AI" ||
      contact?.assignedTo?.type === "AI",
  };
}

interface ExecutionIdentity {
  automationContextId: string;
  stepId: string;
  occurrence: number;
}

function executionKeyString(id: ExecutionIdentity): string {
  return `${id.automationContextId}:${id.stepId}:${id.occurrence}`;
}

async function findExecutionResult(
  id: ExecutionIdentity,
): Promise<LeadsDistributionResult | null> {
  const row = await prisma.distributionLeadsExecution.findUnique({
    where: {
      automationContextId_stepId_occurrence: {
        automationContextId: id.automationContextId,
        stepId: id.stepId,
        occurrence: id.occurrence,
      },
    },
    select: { result: true },
  });
  return row ? (row.result as unknown as LeadsDistributionResult) : null;
}

/** Grava o outcome do step (fora de tx — outcomes sem atribuição). */
async function recordExecution(
  orgId: string,
  id: ExecutionIdentity | null,
  result: LeadsDistributionResult,
  assignmentId?: string | null,
  tx?: ScopedTx,
): Promise<void> {
  if (!id) return;
  const data = {
    organizationId: orgId,
    automationContextId: id.automationContextId,
    stepId: id.stepId,
    occurrence: id.occurrence,
    result: result as unknown as Prisma.InputJsonValue,
    assignmentId: assignmentId ?? null,
  };
  try {
    if (tx) {
      await tx.distributionLeadsExecution.upsert({
        where: {
          automationContextId_stepId_occurrence: {
            automationContextId: id.automationContextId,
            stepId: id.stepId,
            occurrence: id.occurrence,
          },
        },
        create: data,
        update: {},
      });
    } else {
      await prisma.distributionLeadsExecution.upsert({
        where: {
          automationContextId_stepId_occurrence: {
            automationContextId: id.automationContextId,
            stepId: id.stepId,
            occurrence: id.occurrence,
          },
        },
        create: data,
        update: {},
      });
    }
  } catch (e) {
    // Idempotência é rede de segurança; nunca derruba a distribuição.
    console.error("[leads] falha ao gravar execution", e);
  }
}

interface SelectedSlot {
  id: string;
  participantId: string;
  slotIndex: number;
  userId: string;
  userName: string | null;
}

/** Rodízio: slot ativo (slotIndex < weight) de participante ACTIVE com o
 * lastAssignedAt mais antigo (NULL primeiro), desempate estável por id. */
async function selectNextSlotTx(
  tx: ScopedTx,
  orgId: string,
): Promise<SelectedSlot | null> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      participantId: string;
      slotIndex: number;
      userId: string;
      userName: string | null;
    }[]
  >`
    SELECT s.id, s."participantId", s."slotIndex", p."userId", u.name AS "userName"
    FROM "distribution_leads_slots" s
    JOIN "distribution_leads_participants" p ON p.id = s."participantId"
    JOIN "users" u ON u.id = p."userId"
    WHERE s."organizationId" = ${orgId}
      AND p.status = 'ACTIVE'
      AND p.weight > 0
      AND s."slotIndex" < p.weight
      AND u.type = 'HUMAN'
    ORDER BY s."lastAssignedAt" ASC NULLS FIRST, s.id ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function executeLeadsDistribution(
  input: ExecuteLeadsDistributionInput,
): Promise<LeadsDistributionResult> {
  const orgId = getOrgIdOrThrow();
  const execId: ExecutionIdentity | null =
    input.automationContextId && input.stepId && input.occurrence
      ? {
          automationContextId: input.automationContextId,
          stepId: input.stepId,
          occurrence: input.occurrence,
        }
      : null;

  const finish = async (
    result: LeadsDistributionResult,
    assignmentId?: string | null,
  ): Promise<LeadsDistributionResult> => {
    await recordExecution(orgId, execId, result, assignmentId);
    return result;
  };

  if (!(await hasOrganizationWidget("smart_distribution"))) {
    return finish({
      success: false,
      reason: "SMART_DISTRIBUTION_NOT_ENABLED",
      selectedUserId: null,
      selectedUserName: null,
    });
  }
  if (!(await isLeadsDistributionEnabled())) {
    return finish({
      success: false,
      reason: "DISTRIBUTION_DISABLED",
      selectedUserId: null,
      selectedUserName: null,
    });
  }

  // Retry antes do avanço durável do fluxo reencontra o outcome gravado.
  if (execId) {
    const existing = await findExecutionResult(execId);
    if (existing) return existing;
  }

  const target = await hydrateLeadsTarget(input);
  if (!target) {
    return finish({
      success: false,
      reason: "NO_TARGET",
      selectedUserId: null,
      selectedUserName: null,
    });
  }

  // Dono humano vigente é preservado — o modo leads nunca troca dono, salvo
  // `reassign` explícito (CAS com o dono esperado, na tx).
  if (target.currentHumanOwnerId && !input.reassign) {
    if (target.conversationId) {
      await prisma.conversation
        .update({
          where: { id: target.conversationId },
          data: { routeMode: null },
        })
        .catch(() => {});
    }
    return finish({
      success: true,
      reason: "DONO_PRESERVADO",
      selectedUserId: target.currentHumanOwnerId,
      selectedUserName: target.currentHumanOwnerName,
    });
  }

  // Marca a rota ANTES da seleção: enquanto o step executa, o alvo fica fora
  // do alcance do smart (fila derivada e inbound). Persistente — sem TTL.
  if (target.conversationId) {
    await prisma.conversation
      .update({
        where: { id: target.conversationId },
        data: { routeMode: "leads" },
      })
      .catch(() => {});
  }

  let txOutcome:
    | {
        kind: "ASSIGNED";
        slot: SelectedSlot;
        assignmentId: string;
        pipelineId: string | null;
        fromOwnerId: string | null;
      }
    | { kind: "NO_ELIGIBLE_PARTICIPANT" }
    | { kind: "DONO_PRESERVADO"; ownerId: string | null; ownerName: string | null };

  try {
    txOutcome = await prisma.$transaction(async (tx) => {
      // Serializa o rodízio por organização: duas distribuições leads na
      // mesma org executam em série, então a 2ª já vê o lastAssignedAt da 1ª.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${orgId + ":leads-rotation"}, 0))
      `;

      const slot = await selectNextSlotTx(tx, orgId);
      if (!slot) {
        const result: LeadsDistributionResult = {
          success: false,
          reason: "NO_ELIGIBLE_PARTICIPANT",
          selectedUserId: null,
          selectedUserName: null,
        };
        await recordExecution(orgId, execId, result, null, tx);
        return { kind: "NO_ELIGIBLE_PARTICIPANT" };
      }

      // Claim CAS do alvo (proteção de corrida entre modos/fluxos).
      let claimed = false;
      if (target.conversationId) {
        claimed = await claimConversationAssignmentTx(tx, {
          conversationId: target.conversationId,
          userId: slot.userId,
          via: "leads",
          expectedOwnerId: input.reassign
            ? target.currentHumanOwnerId
            : null,
        });
      } else if (target.dealId) {
        claimed = await claimDealAssignmentTx(tx, {
          dealId: target.dealId,
          userId: slot.userId,
          via: "leads",
          expectedOwnerId: input.reassign
            ? target.currentHumanOwnerId
            : null,
        });
      } else if (target.contactId) {
        const res = await tx.contact.updateMany({
          where: input.reassign && target.currentHumanOwnerId
            ? { id: target.contactId, assignedToId: target.currentHumanOwnerId }
            : {
                id: target.contactId,
                OR: [{ assignedToId: null }, { assignedTo: { type: "AI" } }],
              },
          data: { assignedToId: slot.userId },
        });
        claimed = res.count === 1;
      }

      if (!claimed) {
        // Outro fluxo venceu a corrida — relê o dono para o outcome.
        const owner = target.conversationId
          ? await tx.conversation.findUnique({
              where: { id: target.conversationId },
              select: { assignedToId: true, assignedTo: { select: { name: true } } },
            })
          : target.dealId
            ? await tx.deal.findUnique({
                where: { id: target.dealId },
                select: { ownerId: true, owner: { select: { name: true } } },
              })
            : await tx.contact.findUnique({
                where: { id: target.contactId! },
                select: { assignedToId: true, assignedTo: { select: { name: true } } },
              });
        const ownerId =
          owner && "assignedToId" in owner
            ? owner.assignedToId
            : ((owner as { ownerId?: string | null } | null)?.ownerId ?? null);
        const ownerName =
          owner && "assignedTo" in owner
            ? (owner.assignedTo?.name ?? null)
            : ((owner as { owner?: { name: string | null } | null } | null)
                ?.owner?.name ?? null);
        const result: LeadsDistributionResult = {
          success: true,
          reason: "DONO_PRESERVADO",
          selectedUserId: ownerId,
          selectedUserName: ownerName,
        };
        await recordExecution(orgId, execId, result, null, tx);
        return { kind: "DONO_PRESERVADO", ownerId, ownerName };
      }

      // Propagação do ownership (contato/conversas/deal) com a marca de origem.
      let fromOwnerId: string | null = null;
      let pipelineId: string | null = null;
      if (target.dealId) {
        const assigned = await assignDealOwnerTx(
          tx,
          target.dealId,
          slot.userId,
          "leads",
        );
        fromOwnerId = assigned.fromOwnerId;
        pipelineId = assigned.stage?.pipelineId ?? null;
      } else if (target.contactId) {
        fromOwnerId = target.currentHumanOwnerId;
        await propagateOwnerToContactAndChat(tx, target.contactId, slot.userId, {
          via: "leads",
        });
      }

      // Só o slot escolhido avança. O carimbo é monotônico POR ORG:
      // TIMESTAMP(3) tem resolução de ms e o advisory lock serializa a tx,
      // então duas atribuições podem cair no mesmo ms — o desempate por id
      // quebraria a proporcionalidade. Como a tx já é serializada pelo lock,
      // o MAX lido aqui é consistente: toda atribuição grava um instante
      // estritamente maior que o anterior da org (ordem total exata).
      const [maxRow] = await tx.$queryRaw<{ max: Date | null }[]>`
        SELECT MAX("lastAssignedAt") AS max
        FROM "distribution_leads_slots"
        WHERE "organizationId" = ${orgId}
      `;
      const now = new Date();
      const assignedAt =
        maxRow?.max && maxRow.max.getTime() >= now.getTime()
          ? new Date(maxRow.max.getTime() + 1)
          : now;
      await tx.distributionLeadsSlot.update({
        where: { id: slot.id },
        data: { lastAssignedAt: assignedAt },
      });

      const assignment = await tx.distributionLeadsAssignment.create({
        data: {
          organizationId: orgId,
          participantId: slot.participantId,
          userId: slot.userId,
          slotIndex: slot.slotIndex,
          targetKey: target.targetKey,
          contactId: target.contactId,
          dealId: target.dealId,
          conversationId: target.conversationId,
          triggerSource: input.triggerSource,
          executionKey: execId ? executionKeyString(execId) : null,
        },
        select: { id: true },
      });

      await recordExecution(
        orgId,
        execId,
        {
          success: true,
          reason: "ASSIGNED",
          selectedUserId: slot.userId,
          selectedUserName: slot.userName,
        },
        assignment.id,
        tx,
      );

      return {
        kind: "ASSIGNED",
        slot,
        assignmentId: assignment.id,
        pipelineId,
        fromOwnerId,
      };
    });
  } catch (e) {
    // Corrida no MESMO step (dois workers): a unique da execution decide.
    if (
      execId &&
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      const existing = await findExecutionResult(execId);
      if (existing) return existing;
    }
    throw e;
  }

  if (txOutcome.kind === "NO_ELIGIBLE_PARTICIPANT") {
    // routeMode permanece: o alvo fica fora do smart até ação explícita.
    return {
      success: false,
      reason: "NO_ELIGIBLE_PARTICIPANT",
      selectedUserId: null,
      selectedUserName: null,
    };
  }

  if (txOutcome.kind === "DONO_PRESERVADO") {
    if (target.conversationId) {
      await prisma.conversation
        .update({
          where: { id: target.conversationId },
          data: { routeMode: null },
        })
        .catch(() => {});
    }
    return {
      success: true,
      reason: "DONO_PRESERVADO",
      selectedUserId: txOutcome.ownerId,
      selectedUserName: txOutcome.ownerName,
    };
  }

  // ── Pós-commit (nunca falha a distribuição; triggers vão pela fila com
  // retry nativo do BullMQ — falha de ENQUEUE é log+métrica, paridade com o
  // comportamento atual de assignDealOwner). Atribuição concluída NUNCA é
  // refeita por causa de falha aqui.
  const { slot, pipelineId, fromOwnerId, assignmentId } = txOutcome;

  if (pipelineId) {
    await invalidateBoardsForPipelines([pipelineId]).catch(() => {});
  }

  if (target.dealId && fromOwnerId !== slot.userId) {
    const { fireTrigger } = await import("@/services/automation-triggers");
    fireTrigger("agent_changed", {
      dealId: target.dealId,
      contactId: target.contactId ?? undefined,
      data: { fromOwnerId, toOwnerId: slot.userId },
    }).catch((err) =>
      console.warn(
        "[leads] fireTrigger agent_changed:",
        err instanceof Error ? err.message : err,
      ),
    );
  }

  // Saudação pós-distribuição (paridade smart): humano assumindo com a
  // janela Meta 24h aberta. Fora da janela, o aluno reabre ao responder.
  if (target.conversationId) {
    try {
      const conv = await prisma.conversation.findUnique({
        where: { id: target.conversationId },
        select: {
          id: true,
          contactId: true,
          channel: true,
          channelId: true,
          lastInboundAt: true,
          departmentId: true,
        },
      });
      if (conv && (await getConversationSession(conv)).active) {
        const { fireTrigger } = await import("@/services/automation-triggers");
        fireTrigger("lead_distributed", {
          contactId: target.contactId ?? undefined,
          dealId: target.dealId ?? undefined,
          data: {
            conversationId: target.conversationId,
            departmentId: conv.departmentId ?? undefined,
            assignedToId: slot.userId,
            assignedToName: slot.userName,
            triggerSource: input.triggerSource,
            mode: "leads",
          },
        }).catch((err) =>
          console.warn(
            "[leads] fireTrigger lead_distributed:",
            err instanceof Error ? err.message : err,
          ),
        );
      }
    } catch (e) {
      console.warn("[leads] lead_distributed guard falhou", e);
    }
  }

  logEvent({
    type: "LEAD_DISTRIBUTED",
    entityType: target.dealId
      ? "DEAL"
      : target.conversationId
        ? "CONVERSATION"
        : "CONTACT",
    entityId: target.dealId ?? target.conversationId ?? target.contactId!,
    entityLabel: slot.userName ?? null,
    dealId: target.dealId,
    contactId: target.contactId,
    conversationId: target.conversationId,
    field: "owner",
    newValue: slot.userName ?? null,
    meta: {
      reason: "ASSIGNED",
      mode: "leads",
      triggerSource: input.triggerSource,
      selectedUserId: slot.userId,
      assignmentId,
      slotIndex: slot.slotIndex,
    },
    actor: {
      type: input.triggerSource === "AUTOMATION" ? "AUTOMATION" : "SYSTEM",
      label: "Distribuição por Leads",
    },
  }).catch((e) => console.error("[leads] logEvent falhou", e));

  return {
    success: true,
    reason: "ASSIGNED",
    selectedUserId: slot.userId,
    selectedUserName: slot.userName,
  };
}
