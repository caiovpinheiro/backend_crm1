/**
 * Orquestrador: escolhe o especialista no código, troca o dono e o
 * destino atende no mesmo turno. Roda no coordenador e de novo no
 * especialista se o assunto mudar (ex.: cancelar no meio do atendimento).
 * O LLM só fica com saudação, recado sem assunto ou pedido de humano.
 */

import { prisma } from "@/lib/prisma";
import {
  suggestCoordinatorAiAgent,
  type PeerAiAgent,
} from "@/lib/ai-agents/coordinator-route";
import {
  normalizeInboxPolicy,
  normalizeToolConfig,
} from "@/lib/ai-agents/steering";
import { executeOrchestratedHandoff } from "@/services/ai/agent-handoff";
import {
  humanQueueContextFromAgent,
  userWantsHumanDistribution,
} from "@/services/ai/human-queue-policy";
import { isIdleOrchestrationMessage } from "@/services/ai/transfer-gate";
import type { RunArgs, RunResult } from "@/services/ai/runner";

type CoordinatorAgent = {
  id: string;
  userId: string;
  organizationId: string;
  archetype: string | null;
  inboxPolicy: unknown;
  verticalPack: string | null;
  toolConfig: unknown;
  user: { id: string; name: string | null } | null;
};

export async function maybeOrchestrateCoordinatorTurn(args: {
  runArgs: RunArgs;
  agent: CoordinatorAgent;
  runNested: (next: RunArgs) => Promise<RunResult>;
}): Promise<RunResult | null> {
  const { runArgs, agent, runNested } = args;
  if (runArgs.skipCoordinatorOrchestration) return null;
  if (
    agent.archetype === "TABULACAO" ||
    agent.archetype === "ENCERRAMENTO"
  ) {
    return null;
  }
  if (isIdleOrchestrationMessage(runArgs.userMessage)) return null;

  const policy = normalizeInboxPolicy(agent.inboxPolicy, agent.verticalPack);
  if (
    userWantsHumanDistribution(
      runArgs.userMessage,
      humanQueueContextFromAgent({ inboxPolicy: policy }),
    )
  ) {
    return null;
  }

  const rows = await prisma.aIAgentConfig.findMany({
    where: { organizationId: agent.organizationId, active: true },
    select: {
      id: true,
      archetype: true,
      inboxPolicy: true,
      user: { select: { name: true } },
    },
  });
  const peers: PeerAiAgent[] = rows.map((row) => ({
    id: row.id,
    name: row.user?.name?.trim() || "Agente",
    archetype: row.archetype,
    routingScope: normalizeInboxPolicy(row.inboxPolicy, agent.verticalPack)
      .routingScope,
  }));
  const dest = suggestCoordinatorAiAgent(
    runArgs.userMessage,
    peers,
    agent.verticalPack,
  );
  if (!dest || dest.id === agent.id) return null;

  if (runArgs.conversationId && runArgs.contactId) {
    const announce = policy.announceAiTransfer;
    const canned = policy.announceAiTransferMessage?.trim();
    if (announce) {
      const notice =
        (canned
          ? canned.replaceAll("{{target_agent}}", dest.name)
          : `Vou te passar para ${dest.name}, que segue com você daqui.`) ||
        null;
      if (notice) {
        const { sendAgentMessage } = await import(
          "@/services/ai/piloting-actions"
        );
        const me = await prisma.user.findUnique({
          where: { id: agent.userId },
          select: { aiAgentConfig: { select: { autonomyMode: true } } },
        });
        const sent = await sendAgentMessage({
          conversationId: runArgs.conversationId,
          contactId: runArgs.contactId,
          agentUserId: agent.userId,
          autonomyMode: me?.aiAgentConfig?.autonomyMode ?? "AUTONOMOUS",
          text: notice,
        });
        if (sent.status === "skipped") return null;
      }
    }

    const tools = normalizeToolConfig(agent.toolConfig);
    const handed = await executeOrchestratedHandoff({
      conversationId: runArgs.conversationId,
      contactId: runArgs.contactId,
      dealId: runArgs.dealId ?? null,
      fromAgentUserId: agent.userId,
      fromAgentName: agent.user?.name ?? null,
      target: "ai_agent",
      name: dest.name,
      reason: "Orquestração por assunto",
      userMessage: runArgs.userMessage,
      policy,
      toolPolicy: tools.transfer_conversation ?? null,
      handoffBy: "orchestrator_code",
    });
    if (!handed.assigned) return null;
  }

  const nested = await runNested({
    ...runArgs,
    agentId: dest.id,
    skipCoordinatorOrchestration: true,
  });

  return {
    ...nested,
    routing: {
      by: "orchestrator_code",
      fromAgentId: agent.id,
      toAgentId: dest.id,
      reason: "orquestracao_por_assunto",
    },
  };
}
