/**
 * Kill-switch de atendimento IA: novos chats NÃO entram em Agente IA.
 *
 * Default OFF. Um agente com `AIAgentConfig.active=true` sobra no banco
 * e mesmo assim não assume inbound. Reativar sem deploy:
 * `OrganizationSetting` `ai.newAttendanceEnabled=true`.
 */
import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";

export const AI_NEW_ATTENDANCE_SETTING = "ai.newAttendanceEnabled";

export async function isAiAttendanceEnabled(): Promise<boolean> {
  try {
    return await getOrgSettingBool(AI_NEW_ATTENDANCE_SETTING, false);
  } catch {
    return false;
  }
}

/** Herança do contato no ticket novo: nunca copia responsável IA com o gate off. */
export async function inheritContactAssigneeForNewTicket(
  contactId: string,
): Promise<string | null> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: {
      assignedToId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!contact?.assignedToId) return null;
  if (contact.assignedTo?.type === "AI" && !(await isAiAttendanceEnabled())) {
    return null;
  }
  return contact.assignedToId;
}

/** Se o gate estiver off e o responsável for IA, zera assignee (vai pra Entrada). */
export async function releaseAiAssigneeIfDisabled(args: {
  conversationId: string;
  contactId?: string | null;
}): Promise<boolean> {
  if (await isAiAttendanceEnabled()) return false;

  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      assignedToId: true,
      contactId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!conv?.assignedToId || conv.assignedTo?.type !== "AI") return false;

  const contactId = args.contactId ?? conv.contactId;
  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: { assignedToId: null },
    });
    if (!contactId) return;
    const contact = await tx.contact.findUnique({
      where: { id: contactId },
      select: {
        assignedToId: true,
        assignedTo: { select: { type: true } },
      },
    });
    if (contact?.assignedTo?.type === "AI") {
      await tx.contact.update({
        where: { id: contactId },
        data: { assignedToId: null },
      });
    }
  });
  return true;
}
