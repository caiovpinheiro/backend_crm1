/**
 * Resolve se uma conversa deve ser atendida pelo motor v2 simples.
 *
 * - Se a conversa já está atribuída a um agente com `engine = "simple"`, retorna esse agente.
 * - Se a conversa não tem responsável e existe um agente simple ativo na
 *   organização, atribui a conversa a ele e retorna o agente.
 * - Caso contrário retorna null (caminho v1).
 */

import { prismaBase } from "@/lib/prisma-base";

type ResolvedSimpleAgent = {
  userId: string;
  agentConfigId: string;
  wasAssigned: boolean;
};

export async function resolveSimpleAgentForConversation(
  conversationId: string,
): Promise<ResolvedSimpleAgent | null> {
  const conv = await (prismaBase as unknown as {
    conversation: {
      findUnique: (args: unknown) => Promise<{
        id: string;
        organizationId: string;
        assignedToId: string | null;
        assignedTo?: {
          id: string;
          aiAgentConfig?: { id: string; engine?: string | null } | null;
        } | null;
      } | null>;
    };
  }).conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      organizationId: true,
      assignedToId: true,
      assignedTo: {
        select: {
          id: true,
          aiAgentConfig: { select: { id: true, engine: true } },
        },
      },
    },
  });

  if (!conv) return null;

  if (conv.assignedTo?.aiAgentConfig?.engine === "simple") {
    return {
      userId: conv.assignedTo.id,
      agentConfigId: conv.assignedTo.aiAgentConfig.id,
      wasAssigned: false,
    };
  }

  // Já atribuída a um humano ou agente legacy: não interfere.
  if (conv.assignedToId) return null;

  const agent = await (prismaBase as unknown as {
    user: {
      findFirst: (args: unknown) => Promise<{
        id: string;
        aiAgentConfig?: { id: string } | null;
      } | null>;
    };
  }).user.findFirst({
    where: {
      organizationId: conv.organizationId,
      type: "AI",
      aiAgentConfig: {
        is: {
          active: true,
          engine: "simple",
        },
      },
    },
    select: {
      id: true,
      aiAgentConfig: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!agent?.aiAgentConfig) return null;

  // Atribuição atômica: só ganha quem ainda está sem responsável.
  const updated = await (prismaBase as unknown as {
    conversation: {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
  }).conversation.updateMany({
    where: { id: conversationId, assignedToId: null },
    data: { assignedToId: agent.id },
  });

  if (updated.count === 0) {
    // Outro processo atribuiu primeiro; reavalia na próxima volta.
    return resolveSimpleAgentForConversation(conversationId);
  }

  return {
    userId: agent.id,
    agentConfigId: agent.aiAgentConfig.id,
    wasAssigned: true,
  };
}

export function resetSimpleAgentResolverCache(): void {
  // Sem cache por enquanto; hook para testes se necessário.
}
