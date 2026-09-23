/**
 * Resolve se uma conversa deve ser atendida pelo motor v2.
 * - Se a conversa já está atribuída a um agente com engine = "simple", retorna esse agente.
 * - Se não tem responsável e existe um agente v2 ativo na org que PODE assumir
 *   (atendimento IA ligado, conversa não transferida para humano, telefone
 *   dentro da lista de teste), atribui e retorna.
 * - Caso contrário retorna null (caminho v1).
 */

import { prismaBase } from "@/lib/prisma-base";
import { phoneMatchesAllowlist, normalizePhoneDigits } from "@/services/ai/phone-allowlist";
import { isAiAttendanceEnabled } from "@/services/ai/attendance-gate";

export type ResolvedV2Agent = {
  userId: string;
  agentConfigId: string;
  wasAssigned: boolean;
};

type ConversationForResolve = {
  id: string;
  organizationId: string;
  assignedToId: string | null;
  closedAt?: Date | null;
  contact?: { phone: string | null } | null;
  assignedTo?: {
    id: string;
    aiAgentConfig?: { id: string; engine?: string | null } | null;
  } | null;
};

/**
 * Conversa que a IA transferiu para humano (`owner = pessoa`) continua
 * sendo de humano até ser encerrada. Sem isso, um handoff que caía na fila
 * de espera (sem ninguém elegível → `assignedToId = null`) era desfeito na
 * mensagem seguinte do cliente: o resolver via a conversa sem responsável e
 * devolvia para a IA.
 */
async function wasHandedOffToHuman(conv: ConversationForResolve): Promise<boolean> {
  const state = await (prismaBase as unknown as {
    aISimpleConversationState: {
      findUnique: (args: unknown) => Promise<{ owner: string; updatedAt: Date } | null>;
    };
  }).aISimpleConversationState.findUnique({
    where: { conversationId: conv.id },
    select: { owner: true, updatedAt: true },
  });
  if (!state || state.owner !== "pessoa") return false;
  // Encerrada depois do handoff → o atendimento humano terminou e um
  // retorno do cliente pode voltar para a IA.
  if (conv.closedAt && new Date(conv.closedAt) > new Date(state.updatedAt)) return false;
  return true;
}

/** Agente com lista de números de teste só assume conversas desses números. */
function phoneAllowedForAgent(simpleConfig: unknown, phone: string | null | undefined): boolean {
  const raw = (simpleConfig as { allowedPhoneNumbers?: unknown } | null)?.allowedPhoneNumbers;
  const allowed = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  if (allowed.length === 0) return true;
  if (!phone) return false;
  const set = new Set(allowed.map((a) => normalizePhoneDigits(a)).filter(Boolean));
  return phoneMatchesAllowlist(phone, set);
}

export async function resolveV2AgentForConversation(
  conversationId: string,
): Promise<ResolvedV2Agent | null> {
  const conv = await (prismaBase as unknown as {
    conversation: {
      findUnique: (args: unknown) => Promise<ConversationForResolve | null>;
    };
  }).conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      organizationId: true,
      assignedToId: true,
      closedAt: true,
      contact: { select: { phone: true } },
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

  // Kill-switch da org (`ai.newAttendanceEnabled`): o v1 não deixa chat novo
  // entrar em Agente IA com ele desligado; o v2 segue a mesma regra.
  if (!(await isAiAttendanceEnabled())) return null;
  if (await wasHandedOffToHuman(conv)) return null;

  const agent = await (prismaBase as unknown as {
    user: {
      findFirst: (args: unknown) => Promise<{
        id: string;
        aiAgentConfig?: { id: string; simpleConfig?: unknown } | null;
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
      aiAgentConfig: { select: { id: true, simpleConfig: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!agent?.aiAgentConfig) return null;

  // Fora da lista de números de teste a conversa segue o fluxo normal, em
  // vez de ficar presa num agente que nunca vai responder.
  if (!phoneAllowedForAgent(agent.aiAgentConfig.simpleConfig, conv.contact?.phone)) {
    return null;
  }

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
