/**
 * Evento `CONVERSATION_DEPARTMENT_CHANGED` das trocas de departamento que não
 * passam pela rota do Inbox (automação, IA, distribuição). Mesmo formato do
 * evento da rota `conversations/[id]/actions`, com `fromAssigneeId` — quem
 * atendia antes da troca —, lido pelo passo "Devolver atendimento".
 *
 * Best-effort: `logEvent` nunca derruba quem chamou.
 */

import { prisma } from "@/lib/prisma";
import { logEvent } from "@/services/activity-log";

export async function logConversationDepartmentChange(args: {
  conversationId: string;
  contactId?: string | null;
  externalId?: string | null;
  fromDepartmentId: string | null;
  toDepartmentId: string | null;
  fromAssigneeId: string | null;
  extraMeta?: Record<string, unknown>;
}): Promise<void> {
  if ((args.fromDepartmentId ?? null) === (args.toDepartmentId ?? null)) return;
  try {
    const [from, to] = await Promise.all([
      args.fromDepartmentId
        ? prisma.department.findFirst({ where: { id: args.fromDepartmentId }, select: { name: true } })
        : null,
      args.toDepartmentId
        ? prisma.department.findFirst({ where: { id: args.toDepartmentId }, select: { name: true } })
        : null,
    ]);
    await logEvent({
      type: "CONVERSATION_DEPARTMENT_CHANGED",
      entityType: "CONVERSATION",
      entityId: args.conversationId,
      entityLabel: args.externalId ?? null,
      conversationId: args.conversationId,
      contactId: args.contactId ?? null,
      field: "department",
      oldValue: from?.name ?? null,
      newValue: to?.name ?? null,
      meta: {
        fromDepartmentId: args.fromDepartmentId ?? null,
        toDepartmentId: args.toDepartmentId ?? null,
        fromDepartmentName: from?.name ?? null,
        toDepartmentName: to?.name ?? null,
        fromAssigneeId: args.fromAssigneeId ?? null,
        ...(args.extraMeta ?? {}),
      },
    });
  } catch {
    /* best-effort */
  }
}
