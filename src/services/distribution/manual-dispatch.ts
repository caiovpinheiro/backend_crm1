/**
 * "Distribuir p/ departamento" e "Transferir para departamento" (origem
 * MANUAL) respeitam o modo da org.
 *
 * Antes iam sempre para a Distribuição Inteligente. Numa org em "Por Leads"
 * o interruptor do Inteligente fica desligado e a resposta era sempre
 * "Distribuição desligada. Nenhum consultor foi atribuído." — mesmo com
 * consultor do departamento elegível no rodízio (Comercial Cruzeiro,
 * 11/nov/26, negócio #106732, departamento Acadêmico).
 *
 * Em "Por Leads": a conversa é marcada com o departamento escolhido e o
 * sorteio é o do modo por leads, só entre os membros desse(s)
 * departamento(s) — peso, ativo/inativo, regras de horário e liberar/pausar
 * valem como no rodízio. Demais origens e o modo Inteligente: sem mudança.
 * Transferência que já escolheu o consultor (reassign=false) mantém quem
 * está na conversa.
 */

import { prisma } from "@/lib/prisma";

import {
  executeDistribution,
  type DistributionResult,
  type ExecuteDistributionInput,
} from "./engine";
import { executeLeadsDistribution, type LeadsDistributionResult } from "./leads/engine";
import { getOrgDistributionMode } from "./mode";

/** Departamentos pedidos na execução (lista + campo único), sem repetição. */
export function requestedDepartmentIds(input: Pick<ExecuteDistributionInput, "departmentId" | "departmentIds">): string[] {
  return [
    ...new Set([...(input.departmentIds ?? []), ...(input.departmentId ? [input.departmentId] : [])].filter(Boolean)),
  ];
}

/** Resultado do modo por leads no formato que a tela já entende. */
export function leadsResultAsDistribution(r: LeadsDistributionResult): DistributionResult {
  const reason: DistributionResult["reason"] =
    r.reason === "ASSIGNED" || r.reason === "DONO_PRESERVADO"
      ? "ASSIGNED"
      : r.reason === "NO_ELIGIBLE_PARTICIPANT"
        ? "NO_ELIGIBLE_PARTICIPANT"
        : r.reason === "SMART_DISTRIBUTION_NOT_ENABLED" || r.reason === "DISTRIBUTION_DISABLED"
          ? r.reason
          : "NO_ELIGIBLE_PARTICIPANT";
  return {
    success: r.success,
    reason,
    selectedUserId: r.selectedUserId,
    selectedUserName: r.selectedUserName,
    evaluated: [],
  };
}

export async function executeManualDistribution(
  input: ExecuteDistributionInput,
): Promise<DistributionResult> {
  const deptIds = requestedDepartmentIds(input);
  const useLeads =
    input.triggerSource === "MANUAL" &&
    deptIds.length > 0 &&
    Boolean(input.conversationId) &&
    (await getOrgDistributionMode()) === "leads";
  if (!useLeads) return executeDistribution(input);

  const conversationId = input.conversationId!;
  const before = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { departmentId: true, assignedToId: true, contactId: true },
  });
  if (before && before.departmentId !== deptIds[0]) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { departmentId: deptIds[0]! },
      select: { id: true },
    });
    const { logConversationDepartmentChange } = await import(
      "@/services/conversation-department-event"
    );
    await logConversationDepartmentChange({
      conversationId,
      contactId: before.contactId ?? input.contactId ?? null,
      fromDepartmentId: before.departmentId ?? null,
      toDepartmentId: deptIds[0]!,
      fromAssigneeId: before.assignedToId ?? null,
    });
  }

  // Transferência com consultor escolhido na mesma ação (reassign=false):
  // quem já está na conversa fica; o rodízio só entra se ela estiver sem dono.
  if (input.reassign !== true && before?.assignedToId) {
    return {
      success: true,
      reason: "ASSIGNED",
      selectedUserId: before.assignedToId,
      selectedUserName: null,
      evaluated: [],
    };
  }

  const members = await prisma.departmentMember.findMany({
    where: { departmentId: { in: deptIds } },
    select: { userId: true },
  });
  const onlyUserIds = [...new Set(members.map((m) => m.userId))];

  const result = await executeLeadsDistribution({
    dealId: input.dealId ?? null,
    contactId: input.contactId ?? null,
    conversationId,
    triggerSource: "MANUAL",
    reassign: true,
    onlyUserIds,
    keepDealOwner: input.keepDealOwner ?? null,
  });
  return leadsResultAsDistribution(result);
}
