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
  const inherit = await inheritContactAssigneeWithViaForNewTicket(contactId);
  return inherit?.userId ?? null;
}

/**
 * Herança com a origem da atribuição (`assignedVia`): a conversa nova que
 * herda o dono do contato recebe a mesma marca (ex.: lead atribuído pelo modo
 * leads antes de ter conversa) — é a MESMA atribuição, não uma nova.
 */
export async function inheritContactAssigneeWithViaForNewTicket(
  contactId: string,
): Promise<{ userId: string; via: string | null } | null> {
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
  const userId = contact.assignedToId;
  // A marca mora na entidade atribuída (deal/conversa), não no contato.
  // Origem da herança: deal OPEN com esse owner, senão a conversa ativa.
  const [dealVia, convVia] = await Promise.all([
    prisma.deal.findFirst({
      where: { contactId, status: "OPEN", ownerId: userId, assignedVia: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { assignedVia: true },
    }),
    prisma.conversation.findFirst({
      where: {
        contactId,
        status: { not: "RESOLVED" },
        assignedToId: userId,
        assignedVia: { not: null },
      },
      orderBy: { updatedAt: "desc" },
      select: { assignedVia: true },
    }),
  ]);
  return { userId, via: dealVia?.assignedVia ?? convVia?.assignedVia ?? null };
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
