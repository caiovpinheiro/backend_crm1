/**
 * Orquestrador: escolhe o especialista no código, troca o dono e o
 * destino atende no mesmo turno. Roda no coordenador e de novo no
 * especialista se o assunto mudar (ex.: cancelar no meio do atendimento).
 * O LLM só fica com saudação, recado sem assunto ou pedido de humano.
 */

import { prisma } from "@/lib/prisma";
import {
  isReplyToAgentQuestion,
  suggestCoordinatorAiAgent,
  type PeerAiAgent,
} from "@/lib/ai-agents/coordinator-route";
import {
  normalizeInboxPolicy,
  normalizeToolConfig,
} from "@/lib/ai-agents/steering";
import {
  aiHandoffCapReached,
  executeOrchestratedHandoff,
} from "@/services/ai/agent-handoff";
import {
  loadConversationPeerHistory,
  peerAlreadyAttended,
} from "@/services/ai/conversation-peers";
import { executeDepartmentHandoff } from "@/services/ai/department-handoff";
import {
  humanQueueContextFromAgent,
  userWantsHumanDistribution,
} from "@/services/ai/human-queue-policy";
import { recordInboxInterceptRun } from "@/services/ai/record-intercept-run";
import { isIdleOrchestrationMessage } from "@/services/ai/transfer-gate";
import type { InboxPolicy } from "@/lib/ai-agents/steering";
import type { RunArgs, RunResult } from "@/services/ai/runner";
import { getVerticalPack } from "@/verticals";

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

/**
 * Saída do contrato de atendimento quando o roteamento fica sem destino IA.
 *
 * Manda para a Distribuição Inteligente (mesmo caminho da tool
 * `transfer_to_human`) e grava o run — sem o run, o `inbox-handler` não sabe
 * que houve handoff e o contato fica sem a mensagem de fila. `llmInvoked`
 * fica falso porque o modelo não chegou a rodar neste turno.
 */
async function escalateToHumanQueue(args: {
  runArgs: RunArgs;
  agent: CoordinatorAgent;
  policy: InboxPolicy;
  reason: string;
}): Promise<RunResult | null> {
  const { runArgs, agent, policy, reason } = args;
  if (!runArgs.conversationId || !runArgs.contactId) return null;

  const handed = await executeDepartmentHandoff({
    ops: getVerticalPack(agent.verticalPack)?.ops ?? null,
    conversationId: runArgs.conversationId,
    contactId: runArgs.contactId,
    dealId: runArgs.dealId ?? null,
    // Sem nome: o motor infere o departamento pelo contexto da conversa.
    departmentName: null,
    userMessage: runArgs.userMessage,
    reason,
    policy,
  }).catch(() => null);
  if (!handed) return null;

  const runId = await recordInboxInterceptRun({
    agentId: agent.id,
    conversationId: runArgs.conversationId,
    contactId: runArgs.contactId,
    interceptName: "no_ai_destination",
  });
  if (!runId) return null;

  const cfg = await prisma.aIAgentConfig.findUnique({
    where: { id: agent.id },
    select: { autonomyMode: true },
  });

  // Texto vazio de propósito: quem escreve a mensagem de fila é o
  // `inbox-handler`, com a cópia configurada pelo tenant.
  return {
    runId,
    text: "",
    status: "HANDOFF",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    autonomyMode: cfg?.autonomyMode ?? "AUTONOMOUS",
    toolCalls: [],
  };
}

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

  // Especialista já atendendo: responder à pergunta dele não é assunto
  // novo. No coordenador vale o contrário — perguntar "como posso ajudar?"
  // e rotear pela resposta é exatamente o trabalho dele.
  if (agent.archetype !== "COORDENADOR") {
    const lastOut = await prisma.message.findFirst({
      where: {
        conversationId: runArgs.conversationId ?? undefined,
        direction: "out",
        isPrivate: false,
      },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });
    if (isReplyToAgentQuestion(runArgs.userMessage, lastOut?.content)) {
      return null;
    }
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
  // Duas passadas: a primeira diz se este turno tem assunto para rotear, a
  // segunda escolhe entre quem ainda não tentou. Sem separar as duas, "nada
  // a rotear" e "não sobrou ninguém" ficam indistinguíveis — e o segundo
  // caso é o que precisa acabar em humano.
  const wanted = suggestCoordinatorAiAgent(
    runArgs.userMessage,
    peers,
    agent.verticalPack,
  );
  if (!wanted || wanted.id === agent.id) return null;

  const history = await loadConversationPeerHistory(runArgs.conversationId);
  const available = peers.filter((p) => !peerAlreadyAttended(history, p));
  const dest = suggestCoordinatorAiAgent(
    runArgs.userMessage,
    available,
    agent.verticalPack,
  );
  // Antes do anúncio: o handoff também recusa no teto, mas lá o contato já
  // teria lido "vou te passar para X" sem ninguém assumir.
  const capReached = await aiHandoffCapReached(runArgs.conversationId);
  if (!dest || dest.id === agent.id || capReached) {
    // O assunto é de outro agente, e não sobrou agente para ele. Devolver
    // para quem já tentou é o pingue-pongue; ficar calado é pior. A saída
    // do contrato de atendimento é a fila humana.
    return escalateToHumanQueue({
      runArgs,
      agent,
      policy,
      reason: capReached
        ? "Teto de transferências entre agentes atingido"
        : `Assunto de ${wanted.name}, que já atendeu esta conversa`,
    });
  }

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
