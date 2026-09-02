import type { EnqueueWaitResult } from "@/lib/distribution-execute-queue";
import type { DistributionResult } from "@/services/distribution/engine";

export type TransferDistributionJson = {
  success: boolean;
  reason: string;
  selectedUserId: string | null;
  selectedUserName: string | null;
};

/**
 * Transferência manual para departamento (sem agente escolhido) precisa
 * `reassign` — senão o motor devolve ASSIGNED e mantém o dono atual.
 */
export function departmentTransferDistributionInput(args: {
  conversationId: string;
  contactId: string | null;
  departmentId: string;
  explicitAgent: boolean;
}) {
  return {
    conversationId: args.conversationId,
    contactId: args.contactId,
    departmentId: args.departmentId,
    departmentIds: [args.departmentId],
    reassign: !args.explicitAgent,
    triggerSource: "MANUAL" as const,
  };
}

/**
 * Job ainda na fila não é falha: departamento já persistiu e o worker
 * termina o handoff. Sem isso o kebab trata 202/`queued` como erro.
 */
export function transferDistributionFromQueueOutcome(
  outcome: EnqueueWaitResult<DistributionResult>,
): TransferDistributionJson | null {
  if (outcome.kind === "result") {
    return {
      success: outcome.result.success,
      reason: outcome.result.reason,
      selectedUserId: outcome.result.selectedUserId,
      selectedUserName: outcome.result.selectedUserName,
    };
  }
  if (outcome.kind === "queued") {
    return {
      success: true,
      reason: "QUEUED",
      selectedUserId: null,
      selectedUserName: null,
    };
  }
  return null;
}
