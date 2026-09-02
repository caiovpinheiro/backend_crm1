/**
 * Org setting: contar outbound de agente/automação/IA nos filtros de inbox
 * (Aguardando/Respondidas) e na marcação denormalizada `lastMessageDirection`
 * / `hasAgentReply`.
 *
 * Default OFF — só reply humano altera abas e (para bots) a marcação.
 */

import type { Prisma } from "@prisma/client";

import { getOrgSettingFor } from "@/lib/org-settings";
import { getOrgIdOrNull } from "@/lib/request-context";

export const COUNT_AGENT_REPLY_SETTING_KEY =
  "conversation.countAgentReplyAsAnswered";

export type BotOutboundReplyMark = {
  lastMessageDirection: "out";
  hasAgentReply: true;
};

/** Outbound de consultor humano (inbox, template, flow, texto). */
export const HUMAN_OUTBOUND_REPLY_MARK = {
  lastMessageDirection: "out" as const,
  hasAgentReply: true as const,
  hasHumanReply: true as const,
};

export async function countAgentReplyAsAnswered(
  orgId?: string | null,
): Promise<boolean> {
  const id = orgId ?? getOrgIdOrNull();
  if (!id) return false;
  const raw = await getOrgSettingFor(id, COUNT_AGENT_REPLY_SETTING_KEY);
  return raw === "true";
}

/**
 * Campos a mesclar no `conversation.update` após outbound não-humano.
 * Vazio quando o setting está off (não marca direção / hasAgentReply).
 */
export async function botOutboundReplyMark(
  orgId?: string | null,
): Promise<BotOutboundReplyMark | Record<string, never>> {
  if (await countAgentReplyAsAnswered(orgId)) {
    return { lastMessageDirection: "out", hasAgentReply: true };
  }
  return {};
}

/** Reply que conta para Aguardando/Respondidas (humano; + agente se setting ON). */
export function countableReplyWhere(
  countAgent: boolean,
): Prisma.ConversationWhereInput {
  return countAgent
    ? { OR: [{ hasHumanReply: true }, { hasAgentReply: true }] }
    : { hasHumanReply: true };
}

export function noCountableReplyWhere(
  countAgent: boolean,
): Prisma.ConversationWhereInput {
  return countAgent
    ? { hasHumanReply: false, hasAgentReply: false }
    : { hasHumanReply: false };
}

/** Chave do card da inbox: 1 por contato+canal (ticket sem contato conta sozinho). */
export function inboxCardGroupKey(row: {
  id: string;
  contactId: string | null;
  channel?: string | null;
}): string {
  return row.contactId
    ? `c:${row.contactId}::${row.channel ?? ""}`
    : `id:${row.id}`;
}
