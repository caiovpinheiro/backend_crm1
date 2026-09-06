/**
 * Persiste AIAgentRun quando o inbox curto-circuita ANTES do runner/LLM.
 * Neutro em comportamento — só observabilidade (Onda 0).
 */

import type { Prisma } from "@prisma/client";

import {
  behaviorSliceFromAgent,
  hashAgentBehaviorConfig,
} from "@/lib/ai-agents/observability";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

export async function recordInboxInterceptRun(args: {
  agentId?: string | null;
  /** Alternativa quando só temos o User type=AI. */
  agentUserId?: string | null;
  conversationId: string;
  contactId: string;
  interceptName: string;
  configHash?: string | null;
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

    await prisma.aIAgentRun.create({
      data: withOrgFromCtx({
        agentId,
        source: "inbox",
        conversationId: args.conversationId,
        contactId: args.contactId,
        status: "COMPLETED" as const,
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
