/**
 * Log de turno da v2 simples.
 *
 * Guarda prompt, saída do LLM, ações executadas/descartadas, resposta,
 * handoff e métricas para depuração e tela de log por conversa.
 */

import { prismaBase } from "@/lib/prisma-base";
import type { Prisma } from "@prisma/client";
import type { SimpleAction, SimpleLLMOutput } from "@/lib/ai-simple/types";

export type SimpleTurnLogRow = {
  id: string;
  organizationId: string;
  conversationId: string;
  agentId: string;
  turnId: string | null;
  inboundText: string;
  contextSnapshot: Prisma.JsonValue;
  prompt: string;
  llmOutput: Prisma.JsonValue | null;
  discardedActions: Prisma.JsonValue;
  executedActions: Prisma.JsonValue;
  reply: string | null;
  handoff: boolean;
  error: string | null;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
};

type SimpleLogDb = {
  create: (args: { data: unknown }) => Promise<SimpleTurnLogRow>;
  findMany: (args: unknown) => Promise<SimpleTurnLogRow[]>;
  findFirst: (args: unknown) => Promise<SimpleTurnLogRow | null>;
};

function db(): SimpleLogDb {
  return (prismaBase as unknown as { aISimpleTurnLog: SimpleLogDb }).aISimpleTurnLog;
}

export type CreateSimpleLogInput = {
  organizationId: string;
  conversationId: string;
  agentId: string;
  turnId?: string | null;
  inboundText: string;
  contextSnapshot: Record<string, unknown>;
  prompt: string;
  llmOutput?: SimpleLLMOutput | null;
  discardedActions?: SimpleAction[];
  executedActions?: SimpleAction[];
  reply?: string | null;
  handoff?: boolean;
  error?: string | null;
  latencyMs?: number | null;
  inputTokens?: number;
  outputTokens?: number;
};

export async function createSimpleTurnLog(
  input: CreateSimpleLogInput,
): Promise<SimpleTurnLogRow> {
  return db().create({
    data: {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      turnId: input.turnId ?? null,
      inboundText: input.inboundText,
      contextSnapshot: input.contextSnapshot as Prisma.InputJsonValue,
      prompt: input.prompt,
      llmOutput: (input.llmOutput ?? null) as Prisma.InputJsonValue,
      discardedActions: (input.discardedActions ?? []) as Prisma.InputJsonValue,
      executedActions: (input.executedActions ?? []) as Prisma.InputJsonValue,
      reply: input.reply ?? null,
      handoff: input.handoff ?? false,
      error: input.error ?? null,
      latencyMs: input.latencyMs ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
    },
  });
}

export async function listSimpleTurnLogs(
  organizationId: string,
  filters: { conversationId?: string; agentId?: string },
  take = 50,
): Promise<SimpleTurnLogRow[]> {
  const where: Record<string, unknown> = { organizationId };
  if (filters.conversationId) where.conversationId = filters.conversationId;
  if (filters.agentId) where.agentId = filters.agentId;
  return db().findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function getLatestSimpleTurnLog(
  organizationId: string,
  conversationId: string,
): Promise<SimpleTurnLogRow | null> {
  const logs = await listSimpleTurnLogs(organizationId, { conversationId }, 1);
  return logs[0] ?? null;
}
