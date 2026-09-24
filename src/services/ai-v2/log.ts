/**
 * Gravação do trace por turno da v2.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { estimateCost } from "@/lib/ai-agents/pricing";
import type { V2Action, V2CRMContext, V2LLMOutput, V2Owner, V2Stage } from "@/lib/ai-v2/types";
import type { V2ActionResult } from "./actions";
import { takeV2TraceForLog } from "./trace";
import { ensureV2AgentSchema } from "./ensure-schema";
import { maskSensitive, maskSensitiveDeep } from "./sensitive";
export async function logV2Turn(args: {
  organizationId: string;
  conversationId: string;
  agentId: string;
  turnId?: string;
  inboundText: string;
  crmContext: V2CRMContext;
  prompt: string;
  llmOutput?: V2LLMOutput;
  executedActions: V2ActionResult[];
  discardedActions: V2Action[];
  reply?: string;
  handoff: boolean;
  closed?: boolean;
  error?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  owner: V2Owner;
  stage: V2Stage;
  themeId?: string;
  appliedRuleId?: string;
  versionId?: string;
  toolCalls?: unknown[];
  governorStats?: Record<string, unknown>;
}): Promise<void> {
  const model = "gpt-4o-mini"; // Simplificado; idealmente receber da config.
  const trace = takeV2TraceForLog();
  // DEV não aplica migrations: a coluna `feedback` pode ainda não existir e
  // o create devolveria (RETURNING) todas as colunas do model.
  await ensureV2AgentSchema().catch(() => undefined);
  const costUsd = estimateCost(model, args.inputTokens, args.outputTokens);
  await (prisma as unknown as {
    aISimpleTurnLog: {
      create: (args: { data: Record<string, unknown>; select: { id: true } }) => Promise<unknown>;
    };
  }).aISimpleTurnLog.create({
    data: {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      turnId: args.turnId ?? null,
      // Log e telas de teste guardam só a versão mascarada: documento,
      // e-mail, senha e cartão do cliente não ficam gravados aqui.
      inboundText: maskSensitive(args.inboundText).text,
      contextSnapshot: maskSensitiveDeep({
        ...(args.crmContext as unknown as Record<string, unknown>),
        ...(args.toolCalls ? { toolCalls: args.toolCalls } : {}),
        ...(args.governorStats ? { governorStats: args.governorStats } : {}),
        ...(trace ? { trace } : {}),
        stage: args.stage,
        owner: args.owner,
        ...(args.themeId ? { themeId: args.themeId } : {}),
        ...(args.appliedRuleId ? { appliedRuleId: args.appliedRuleId } : {}),
        ...(args.closed ? { closed: true } : {}),
      }),
      prompt: maskSensitive(args.prompt).text,
      llmOutput: maskSensitiveDeep(args.llmOutput ?? null) as Record<string, unknown> | null,
      executedActions: maskSensitiveDeep(args.executedActions) as unknown as Record<string, unknown>,
      discardedActions: maskSensitiveDeep(args.discardedActions) as unknown as Record<string, unknown>,
      reply: args.reply ? maskSensitive(args.reply).text : null,
      handoff: args.handoff,
      error: args.error ? maskSensitive(args.error).text : null,
      latencyMs: args.latencyMs,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      // Extra fields não colunados; persistidos em JSON no contextSnapshot ou podemos usar coluna adicional.
      // Colocamos metadados em contextSnapshot para manter compatibilidade.
    },
    select: { id: true },
  });
}

export async function listV2TurnLogs(args: {
  organizationId: string;
  agentId: string;
  conversationId?: string;
  take?: number;
  skip?: number;
}) {
  return (prisma as unknown as {
    aISimpleTurnLog: {
      findMany: (args: {
        where: Record<string, unknown>;
        orderBy: { createdAt: "desc" };
        take?: number;
        skip?: number;
      }) => Promise<unknown[]>;
    };
  }).aISimpleTurnLog.findMany({
    where: {
      organizationId: args.organizationId,
      agentId: args.agentId,
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: args.take ?? 50,
    skip: args.skip ?? 0,
  });
}
