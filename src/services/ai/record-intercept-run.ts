/**
 * Persiste AIAgentRun quando o inbox curto-circuita ANTES do runner/LLM.
 * Só observabilidade — não muda o atendimento.
 *
 * O `outcome` nunca era preenchido: todo intercepto ficava
 * `status=COMPLETED, outcome=null`, então a única transferência que de fato
 * funcionou (áudio → humano) era indistinguível de uma resposta qualquer.
 * Agora o desfecho é OBSERVADO do estado final (assignee da conversa + fila
 * de distribuição), não declarado pelo intercepto.
 */

import type { AIAgentRunOutcome, Prisma } from "@prisma/client";

import {
  behaviorSliceFromAgent,
  hashAgentBehaviorConfig,
} from "@/lib/ai-agents/observability";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { statusForOutcome } from "@/services/ai/run-outcome";

/**
 * Desfecho a partir do estado final da conversa. Escopo de tenant vem do
 * `prisma` scoped — nenhuma query cruza organização.
 */
export async function observeInterceptOutcome(args: {
  conversationId: string;
  contactId: string;
}): Promise<AIAgentRunOutcome> {
  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: { assignedTo: { select: { type: true } } },
  });
  const assigneeType = conv?.assignedTo?.type ?? null;
  if (assigneeType && assigneeType !== "AI") return "HANDOFF_COMPLETED";

  const queued = await prisma.distributionPending.findFirst({
    where: {
      status: "PENDING",
      OR: [
        { conversationId: args.conversationId },
        { contactId: args.contactId },
      ],
    },
    select: { id: true },
  });
  if (queued) return "HANDOFF_QUEUED";

  return "ANSWERED";
}

export async function recordInboxInterceptRun(args: {
  agentId?: string | null;
  /** Alternativa quando só temos o User type=AI. */
  agentUserId?: string | null;
  conversationId: string;
  contactId: string;
  interceptName: string;
  configHash?: string | null;
  /**
   * Desfecho explícito. Use quando o intercepto SABE que nada foi entregue
   * (ex.: anexo ignorado por configuração). Omitido = observa o estado final.
   */
  outcome?: AIAgentRunOutcome | null;
  /** Motivo persistido quando `outcome=RESPONSE_DISCARDED`. */
  discardReason?: string | null;
}): Promise<void> {
  try {
    let agentId = args.agentId ?? null;
    if (!agentId && args.agentUserId) {
      const cfg = await prisma.aIAgentConfig.findUnique({
        where: { userId: args.agentUserId },
        select: { id: true },
      });
      agentId = cfg?.id ?? null;
    }
    if (!agentId) return;

    let configHash = args.configHash ?? null;
    if (!configHash) {
      const agent = await prisma.aIAgentConfig.findUnique({
        where: { id: agentId },
        select: {
          archetype: true,
          model: true,
          temperature: true,
          maxTokens: true,
          systemPromptTemplate: true,
          systemPromptOverride: true,
          productPolicy: true,
          steeringRules: true,
          tone: true,
          language: true,
          autonomyMode: true,
          enabledTools: true,
          outputStyle: true,
          qualificationQuestions: true,
          toolConfig: true,
          inboxPolicy: true,
          autoClosePolicy: true,
          keywordHandoffs: true,
          openingMessage: true,
        },
      });
      if (agent) {
        configHash = hashAgentBehaviorConfig(behaviorSliceFromAgent(agent));
      }
    }

    const outcome =
      args.outcome ??
      (await observeInterceptOutcome({
        conversationId: args.conversationId,
        contactId: args.contactId,
      }).catch(() => "ANSWERED" as AIAgentRunOutcome));

    await prisma.aIAgentRun.create({
      data: withOrgFromCtx({
        agentId,
        source: "inbox",
        conversationId: args.conversationId,
        contactId: args.contactId,
        status: statusForOutcome(outcome),
        outcome,
        handoffReason:
          outcome === "HANDOFF_COMPLETED"
            ? `intercept:${args.interceptName}`
            : outcome === "HANDOFF_QUEUED"
              ? `intercept_queued:${args.interceptName}`
              : null,
        errorMessage:
          outcome === "RESPONSE_DISCARDED"
            ? `[descartada] ${args.discardReason ?? args.interceptName}`.slice(
                0,
                500,
              )
            : null,
        llmInvoked: false,
        stepCountReached: false,
        interceptsFired: [args.interceptName] as unknown as Prisma.InputJsonValue,
        configHash,
        finishedAt: new Date(),
        responsePreview: `[intercept:${args.interceptName}]`,
      }),
    });
  } catch (err) {
    console.warn("[ai] recordInboxInterceptRun failed", {
      intercept: args.interceptName,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
