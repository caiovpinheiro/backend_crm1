/**
 * Handoff único da v2.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { executeDistribution } from "@/services/distribution";
import { isAgentAvailable } from "@/services/lead-distribution";
import type { V2Destination } from "@/lib/ai-v2/types";

export async function simpleHandoff(args: {
  conversationId: string;
  contactId?: string | null;
  dealId?: string | null;
  destination: V2Destination;
}): Promise<void> {
  const destination = args.destination;

  if (destination.type === "department") {
    await executeDistribution({
      conversationId: args.conversationId,
      contactId: args.contactId ?? null,
      dealId: args.dealId ?? null,
      triggerSource: "AI_AGENT",
      departmentId: destination.id ?? null,
      reassign: true,
      allowOrgWideFallback: false,
    });
    return;
  }

  if (destination.type === "user") {
    if (!destination.id) throw new Error("Handoff para usuário sem id");
    await assignConversation(args.conversationId, destination.id);
    return;
  }

  if (destination.type === "ai_agent") {
    if (!destination.id) throw new Error("Handoff para agente de IA sem id");
    const agent = await (prisma as any).aIAgentConfig.findUnique({
      where: { id: destination.id },
      select: { userId: true },
    });
    if (!agent?.userId) throw new Error("Agente de IA destino não encontrado");
    await assignConversation(args.conversationId, agent.userId);
    return;
  }

  if (destination.type === "distribution_rule") {
    if (!destination.id) throw new Error("Handoff para regra de distribuição sem id");
    const userId = await assignByDistributionRule(destination.id);
    if (!userId) {
      // Sem membro disponível: cai na fila via distribuição sem departamento.
      await executeDistribution({
        conversationId: args.conversationId,
        contactId: args.contactId ?? null,
        dealId: args.dealId ?? null,
        triggerSource: "AI_AGENT",
        reassign: true,
        allowOrgWideFallback: false,
      });
      return;
    }
    await assignConversation(args.conversationId, userId);
    return;
  }

  // automation / fallback desconhecido: por segurança, fila humana.
  await executeDistribution({
    conversationId: args.conversationId,
    contactId: args.contactId ?? null,
    dealId: args.dealId ?? null,
    triggerSource: "AI_AGENT",
    reassign: true,
    allowOrgWideFallback: false,
  });
}

async function assignConversation(conversationId: string, userId: string): Promise<void> {
  await (prisma as any).conversation.update({
    where: { id: conversationId },
    data: { assignedToId: userId },
  });
}

async function assignByDistributionRule(ruleId: string): Promise<string | null> {
  const rule = await (prisma as any).distributionRule.findUnique({
    where: { id: ruleId },
    include: { members: { include: { user: { select: { id: true } } } } },
  });
  if (!rule || rule.members.length === 0) return null;

  if (rule.mode === "ROUND_ROBIN") {
    const total = rule.members.length;
    for (let attempt = 0; attempt < total; attempt++) {
      const nextIndex = (rule.lastIndex + 1 + attempt) % total;
      const member = rule.members[nextIndex];
      if (await isAgentAvailable(member.userId)) {
        await (prisma as any).distributionRule.update({
          where: { id: rule.id },
          data: { lastIndex: nextIndex },
        });
        return member.userId;
      }
    }
    return null;
  }

  for (const member of rule.members) {
    if (await isAgentAvailable(member.userId)) return member.userId;
  }
  return null;
}
