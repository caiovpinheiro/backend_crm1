/**
 * Handoff único da v2.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { executeDistribution } from "@/services/distribution";
import { isAgentAvailable } from "@/services/lead-distribution";
import type { V2Destination } from "@/lib/ai-v2/types";
import { traceStep } from "./trace";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai-v2.handoff");

type HandoffArgs = {
  conversationId: string;
  contactId?: string | null;
  dealId?: string | null;
  destination: V2Destination;
  /** Turno em andamento: com destino agente de IA, ele responde as mesmas mensagens. */
  turnId?: string;
};

export async function simpleHandoff(args: HandoffArgs): Promise<void> {
  try {
    await routeHandoff(args);
  } catch (err) {
    // Destino inválido (id ausente, agente apagado) ou distribuição fora do
    // ar: o aviso ao cliente já saiu. Antes a exceção derrubava o turno, a
    // fila repetia a execução e a conversa continuava com a IA. Agora ela
    // vai para a fila da equipe (sem responsável) e o rastro explica.
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "[ai-v2] transferência falhou; conversa devolvida à fila da equipe");
    traceStep("transferência", `Transferência para ${args.destination.type}${args.destination.id ? ` (${args.destination.id})` : ""} falhou (${msg}) → conversa devolvida à fila da equipe`);
    await releaseFromAi(args.conversationId).catch(() => undefined);
    return;
  }
  if (args.destination.type !== "ai_agent") {
    await releaseFromAi(args.conversationId);
    return;
  }
  // Outro agente de IA assumiu: antes ele só respondia quando o cliente
  // escrevia de novo ("???"), sem ter respondido a pergunta que motivou a
  // transferência.
  if (args.turnId) {
    try {
      const { requeueTurnForAssignee } = await import("@/services/ai/turn-manager");
      await requeueTurnForAssignee(args.turnId);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[ai-v2] turno para o agente de destino não foi criado",
      );
    }
  }
}

/**
 * Handoff para humano/fila nunca pode deixar a conversa com um usuário IA.
 * A distribuição não mexe no responsável quando está desligada
 * (SMART_DISTRIBUTION_NOT_ENABLED / DISTRIBUTION_DISABLED): o agente dizia
 * "vou transferir", continuava dono e voltava a responder no turno seguinte.
 * Sem responsável, a conversa aparece na Entrada para a equipe.
 */
async function releaseFromAi(conversationId: string): Promise<void> {
  await (prisma as any).conversation.updateMany({
    where: { id: conversationId, assignedTo: { type: "AI" } },
    data: { assignedToId: null },
  });
}

async function routeHandoff(args: HandoffArgs): Promise<void> {
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
      select: { userId: true, engine: true, active: true },
    });
    if (!agent?.userId) throw new Error("Agente de IA destino não encontrado");
    // Destino salvo antes pode apontar para um agente do motor antigo ou
    // desligado: quem responde depois não é o agente que se esperava.
    if (agent.engine !== "simple") traceStep("transferência", `Atenção: o agente de destino (${destination.id}) usa o motor antigo — é ele que vai responder`);
    if (agent.active === false) traceStep("transferência", `Atenção: o agente de destino (${destination.id}) está desligado — ninguém vai responder`);
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
