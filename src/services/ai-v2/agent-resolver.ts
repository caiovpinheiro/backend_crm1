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
  /**
   * Conversa transferida para pessoas, ainda na fila: o agente que transferiu
   * só manda o aviso de fila, sem assumir a conversa (ela segue sem
   * responsável, esperando a equipe).
   */
  queueOnly?: boolean;
};

type ConversationForResolve = {
  id: string;
  organizationId: string;
  assignedToId: string | null;
  closedAt?: Date | null;
  channelId?: string | null;
  contact?: { phone: string | null } | null;
  assignedTo?: {
    id: string;
    aiAgentConfig?: { id: string; engine?: string | null; active?: boolean | null } | null;
  } | null;
};

/**
 * Conversa que a IA transferiu para humano (`owner = pessoa`) continua
 * sendo de humano até ser encerrada, dentro ou fora do horário. Sem isso,
 * um handoff que caía na fila de espera (sem ninguém elegível →
 * `assignedToId = null`) era desfeito na mensagem seguinte do cliente: o
 * resolver via a conversa sem responsável e devolvia para a IA. A
 * distribuição consulta o mesmo antes de entregar o ticket ao 1º
 * atendimento por IA.
 */
export async function conversationHandedOffToHuman(conv: { id: string; closedAt?: Date | null }): Promise<boolean> {
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

/**
 * Qual agente v2 assume a conversa nova. Antes era sempre o mais antigo da
 * org: com dois agentes, os "Canais vinculados" do outro não valiam. Agora
 * vence o agente vinculado ao canal da conversa; sem vínculo, o primeiro
 * agente sem canais (atende qualquer canal). A lista de números de teste
 * de cada agente continua valendo.
 */
export function pickAgentForConversation<T extends { aiAgentConfig?: { simpleConfig?: unknown } | null }>(
  agents: T[],
  channelId: string | null,
  phone: string | null | undefined,
): T | null {
  const channelsOf = (a: T) => {
    const raw = (a.aiAgentConfig?.simpleConfig as { channelIds?: unknown } | null | undefined)?.channelIds;
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
  };
  const eligible = agents.filter((a) => a.aiAgentConfig && phoneAllowedForAgent(a.aiAgentConfig.simpleConfig, phone));
  if (!channelId) return eligible[0] ?? null;
  return (
    eligible.find((a) => channelsOf(a).includes(channelId)) ??
    eligible.find((a) => channelsOf(a).length === 0) ??
    null
  );
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
      channelId: true,
      contact: { select: { phone: true } },
      assignedTo: {
        select: {
          id: true,
          aiAgentConfig: { select: { id: true, engine: true, active: true } },
        },
      },
    },
  });

  if (!conv) return null;

  const assignedAi = conv.assignedTo?.aiAgentConfig;
  // Responsável é um agente de IA desligado (herdado do contato/negócio, por
  // exemplo): ninguém respondia e o cliente ficava sem retorno. A conversa é
  // solta e segue como sem responsável — agente ativo ou fila da equipe.
  if (assignedAi && assignedAi.active === false && conv.assignedToId) {
    const released = await (prismaBase as unknown as {
      conversation: { updateMany: (args: unknown) => Promise<{ count: number }> };
    }).conversation.updateMany({
      where: { id: conversationId, assignedToId: conv.assignedToId },
      data: { assignedToId: null },
    });
    if (released.count === 0) return resolveV2AgentForConversation(conversationId);
    conv.assignedToId = null;
    conv.assignedTo = null;
  } else if (assignedAi?.engine === "simple" && conv.assignedTo) {
    return {
      userId: conv.assignedTo.id,
      agentConfigId: assignedAi.id,
      wasAssigned: false,
    };
  }

  if (conv.assignedToId) return null;

  // Kill-switch da org (`ai.newAttendanceEnabled`): o v1 não deixa chat novo
  // entrar em Agente IA com ele desligado; o v2 segue a mesma regra.
  if (!(await isAiAttendanceEnabled())) return null;
  if (await conversationHandedOffToHuman(conv)) return queueNoticeAgent(conv.id);

  const agents = await (prismaBase as unknown as {
    user: {
      findMany: (args: unknown) => Promise<Array<{
        id: string;
        aiAgentConfig?: { id: string; simpleConfig?: unknown } | null;
      }>>;
    };
  }).user.findMany({
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

  const agent = pickAgentForConversation(agents, conv.channelId ?? null, conv.contact?.phone);
  // Fora da lista de números de teste a conversa segue o fluxo normal, em
  // vez de ficar presa num agente que nunca vai responder.
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

/**
 * Cliente escrevendo numa conversa que a IA transferiu e que espera na fila
 * (pendência de distribuição aberta, sem responsável): o agente que
 * transferiu responde só o aviso de fila, sem assumir. Sem isso o cliente
 * escrevia na fila e ninguém respondia nada até alguém da equipe pegar.
 */
async function queueNoticeAgent(conversationId: string): Promise<ResolvedV2Agent | null> {
  const db = prismaBase as unknown as {
    aISimpleConversationState: { findUnique: (args: unknown) => Promise<{ agentId: string | null } | null> };
    distributionPending: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
    user: { findFirst: (args: unknown) => Promise<{ id: string; aiAgentConfig?: { id: string } | null } | null> };
  };
  try {
    const state = await db.aISimpleConversationState.findUnique({ where: { conversationId }, select: { agentId: true } });
    if (!state?.agentId) return null;
    const pending = await db.distributionPending.findFirst({ where: { status: "PENDING", conversationId }, select: { id: true } });
    if (!pending) return null;
    const agent = await db.user.findFirst({
      where: { type: "AI", aiAgentConfig: { is: { id: state.agentId, active: true, engine: "simple" } } },
      select: { id: true, aiAgentConfig: { select: { id: true } } },
    });
    if (!agent?.aiAgentConfig) return null;
    return { userId: agent.id, agentConfigId: agent.aiAgentConfig.id, wasAssigned: false, queueOnly: true };
  } catch {
    return null;
  }
}

/**
 * Sem efeito colateral (não atribui nada): a conversa está transferida para
 * pessoas, sem responsável, esperando na fila — devolve o agente que só
 * manda o aviso de fila. Usado por quem executa o turno.
 */
export async function queueOnlyV2Agent(conversationId: string): Promise<ResolvedV2Agent | null> {
  try {
    const conv = await (prismaBase as unknown as {
      conversation: { findUnique: (args: unknown) => Promise<{ id: string; assignedToId: string | null; closedAt?: Date | null } | null> };
    }).conversation.findUnique({ where: { id: conversationId }, select: { id: true, assignedToId: true, closedAt: true } });
    if (!conv || conv.assignedToId) return null;
    if (!(await conversationHandedOffToHuman(conv))) return null;
    return queueNoticeAgent(conversationId);
  } catch {
    return null;
  }
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
