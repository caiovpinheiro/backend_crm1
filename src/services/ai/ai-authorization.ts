import { prisma } from "@/lib/prisma";

/**
 * Confirma que a conversa ainda está com o agente IA esperado e que
 * nenhum humano respondeu depois do início do processamento.
 */
export async function assertAiStillAuthorized(args: {
  conversationId: string;
  expectedAgentUserId: string;
  since?: Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      assignedToId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!conversation?.assignedToId) {
    return { ok: false, reason: "unassigned" };
  }
  if (conversation.assignedToId !== args.expectedAgentUserId) {
    return { ok: false, reason: "assignee_changed" };
  }
  if (conversation.assignedTo?.type !== "AI") {
    return { ok: false, reason: "assignee_not_ai" };
  }

  // Humano falou depois do início deste processamento?
  if (args.since) {
    const humanOut = await prisma.message.findFirst({
      where: {
        conversationId: args.conversationId,
        direction: "out",
        authorType: "human",
        isPrivate: false,
        createdAt: { gte: args.since },
      },
      select: { id: true },
    });
    if (humanOut) return { ok: false, reason: "human_replied_during_run" };
  }

  return { ok: true };
}
