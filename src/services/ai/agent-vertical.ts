/**
 * Resolve o vertical pack A PARTIR DO AGENTE — nunca por nome fixo.
 *
 * Sete serviços genéricos chamavam `getVerticalPack("academic")` direto.
 * Em um CRM multi-tenant isso significa que o agente de SAC de outra
 * organização executava (ou tentava executar) regras acadêmicas, e o
 * agente sem vertical caía em `undefined` no meio do caminho. Aqui o
 * pack, a `inboxPolicy` e o horário saem da configuração do agente que
 * está atendendo aquela conversa/organização.
 *
 * Sem agente ou sem pack, o retorno é o contexto vazio: `ops` = `{}` e
 * `inboxPolicy` = defaults. Quem consome segue pelo caminho genérico.
 *
 * `prismaBase` com `organizationId` explícito porque estes serviços rodam
 * em cron/worker, fora de RequestContext. Nenhuma query sem filtro de org.
 */

import { normalizeInboxPolicy, type InboxPolicy } from "@/lib/ai-agents/steering";
import {
  normalizeBusinessHours,
  type BusinessHoursConfig,
} from "@/lib/ai-agents/piloting";
import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrNull } from "@/lib/request-context";
import {
  humanQueueContextFromAgent,
  type HumanQueueContext,
} from "@/services/ai/human-queue-policy";
import { getVerticalPack } from "@/verticals";
import type { VerticalPack, VerticalPackOps } from "@/verticals/types";

export type AgentVertical = {
  agentId: string | null;
  agentUserId: string | null;
  verticalPack: string | null;
  pack: VerticalPack | null;
  /// Ops do pack. `{}` quando o agente não tem vertical.
  ops: VerticalPackOps;
  inboxPolicy: InboxPolicy;
  businessHours: BusinessHoursConfig | null;
};

const AGENT_SELECT = {
  id: true,
  userId: true,
  verticalPack: true,
  inboxPolicy: true,
  businessHours: true,
} as const;

type AgentRow = {
  id: string;
  userId: string;
  verticalPack: string | null;
  inboxPolicy: unknown;
  businessHours: unknown;
};

/** Contexto de quem não tem agente resolvido: tudo genérico. */
export function emptyAgentVertical(): AgentVertical {
  return {
    agentId: null,
    agentUserId: null,
    verticalPack: null,
    pack: null,
    ops: {},
    inboxPolicy: normalizeInboxPolicy(null, null),
    businessHours: null,
  };
}

function fromRow(row: AgentRow | null | undefined): AgentVertical {
  if (!row) return emptyAgentVertical();
  const pack = getVerticalPack(row.verticalPack);
  return {
    agentId: row.id,
    agentUserId: row.userId,
    verticalPack: row.verticalPack ?? null,
    pack,
    ops: pack?.ops ?? {},
    inboxPolicy: normalizeInboxPolicy(row.inboxPolicy, row.verticalPack),
    businessHours: normalizeBusinessHours(row.businessHours),
  };
}

/** Contexto de fila/horário humano do agente (Fase 3). */
export function humanQueueContextOf(agent: AgentVertical): HumanQueueContext {
  return humanQueueContextFromAgent({
    inboxPolicy: agent.inboxPolicy,
    businessHours: agent.businessHours,
  });
}

export async function resolveAgentVerticalByAgentId(
  agentId: string | null | undefined,
  organizationId?: string | null,
): Promise<AgentVertical> {
  if (!agentId) return emptyAgentVertical();
  const orgId = organizationId ?? getOrgIdOrNull();
  if (!orgId) return emptyAgentVertical();
  const row = await prismaBase.aIAgentConfig.findFirst({
    where: { id: agentId, organizationId: orgId },
    select: AGENT_SELECT,
  });
  return fromRow(row);
}

/** `userId` = o User de tipo AI que está atribuído à conversa. */
export async function resolveAgentVerticalByAgentUserId(
  agentUserId: string | null | undefined,
  organizationId?: string | null,
): Promise<AgentVertical> {
  if (!agentUserId) return emptyAgentVertical();
  const orgId = organizationId ?? getOrgIdOrNull();
  if (!orgId) return emptyAgentVertical();
  const row = await prismaBase.aIAgentConfig.findFirst({
    where: { userId: agentUserId, organizationId: orgId, active: true },
    select: AGENT_SELECT,
  });
  return fromRow(row);
}

/**
 * Agente default da organização: o primeiro ATENDIMENTO autônomo ativo e,
 * na falta dele, qualquer autônomo ativo. Mesma ordem que o inbox usa
 * quando a conversa está sem assignee.
 */
export async function resolveAgentVerticalForOrganization(
  organizationId?: string | null,
): Promise<AgentVertical> {
  const orgId = organizationId ?? getOrgIdOrNull();
  if (!orgId) return emptyAgentVertical();
  const preferred = await prismaBase.aIAgentConfig.findFirst({
    where: {
      organizationId: orgId,
      active: true,
      autonomyMode: "AUTONOMOUS",
      archetype: "ATENDIMENTO",
    },
    orderBy: { createdAt: "asc" },
    select: AGENT_SELECT,
  });
  if (preferred) return fromRow(preferred);
  const any = await prismaBase.aIAgentConfig.findFirst({
    where: { organizationId: orgId, active: true, autonomyMode: "AUTONOMOUS" },
    orderBy: { createdAt: "asc" },
    select: AGENT_SELECT,
  });
  return fromRow(any);
}

/**
 * Pack da conversa: o agente atribuído a ela; se a conversa está sem IA,
 * o agente default da organização.
 */
export async function resolveAgentVerticalForConversation(
  conversationId: string | null | undefined,
  organizationId?: string | null,
): Promise<AgentVertical> {
  if (!conversationId) {
    return resolveAgentVerticalForOrganization(organizationId);
  }
  const orgId = organizationId ?? getOrgIdOrNull();
  if (!orgId) return emptyAgentVertical();
  const conv = await prismaBase.conversation.findFirst({
    where: { id: conversationId, organizationId: orgId },
    select: {
      assignedToId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (conv?.assignedToId && conv.assignedTo?.type === "AI") {
    const byUser = await resolveAgentVerticalByAgentUserId(
      conv.assignedToId,
      orgId,
    );
    if (byUser.agentId) return byUser;
  }
  return resolveAgentVerticalForOrganization(orgId);
}
