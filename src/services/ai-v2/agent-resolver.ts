/**
 * Resolve se uma conversa deve ser atendida pelo motor v2.
 * - Se a conversa já está atribuída a um agente com engine = "simple", retorna esse agente.
 * - Se não tem responsável e existe um agente v2 ativo na org, atribui e retorna.
 * - Caso contrário retorna null (caminho v1).
 */

import { prismaBase } from "@/lib/prisma-base";

export type ResolvedV2Agent = {
  userId: string;
  agentConfigId: string;
  wasAssigned: boolean;
};

export async function resolveV2AgentForConversation(
  conversationId: string,
): Promise<ResolvedV2Agent | null> {
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

  const updated = await (prismaBase as unknown as {
    conversation: {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
  }).conversation.updateMany({
    where: { id: conversationId, assignedToId: null },
    data: { assignedToId: agent.id },
  });

  if (updated.count === 0) {
    return resolveV2AgentForConversation(conversationId);
  }

  return {
    userId: agent.id,
    agentConfigId: agent.aiAgentConfig.id,
    wasAssigned: true,
  };
}

export function resetV2AgentResolverCache(): void {
  // Hook para testes.
}

/** True se a conversa está atribuída a um agente com engine "simple". */
export async function isSimpleEngineConversation(conversationId: string): Promise<boolean> {
  const conv = await (prismaBase as unknown as {
    conversation: {
      findUnique: (args: unknown) => Promise<{
        assignedTo?: { aiAgentConfig?: { engine?: string | null } } | null;
      } | null>;
    };
  }).conversation.findUnique({
    where: { id: conversationId },
    select: {
      assignedTo: {
        select: {
          aiAgentConfig: { select: { engine: true } },
        },
      },
    },
  });
  return conv?.assignedTo?.aiAgentConfig?.engine === "simple";
}
