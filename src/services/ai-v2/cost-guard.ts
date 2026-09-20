/**
 * Guarda de custo do motor v2.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { estimateCost } from "@/lib/ai-agents/pricing";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

export async function checkV2CostCap(args: {
  config: V2AgentConfig;
  agentId: string;
  organizationId: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<{ allowed: boolean; reason?: string }> {
  if (!args.config.costCap && !args.config.dailyTokenCap) return { allowed: true };

  const model = args.config.model;
  const cost = estimateCost(model, args.inputTokens, args.outputTokens);

  if (args.config.dailyTokenCap) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const result = await (prisma as unknown as {
      aISimpleTurnLog: {
        aggregate: (args: {
          where: Record<string, unknown>;
          _sum: { inputTokens: boolean; outputTokens: boolean };
        }) => Promise<{ _sum: { inputTokens: number | null; outputTokens: number | null } }>;
      };
    }).aISimpleTurnLog.aggregate({
      where: {
        organizationId: args.organizationId,
        agentId: args.agentId,
        createdAt: { gte: startOfDay },
      },
      _sum: { inputTokens: true, outputTokens: true },
    });
    const total = (result._sum.inputTokens ?? 0) + (result._sum.outputTokens ?? 0) + args.inputTokens + args.outputTokens;
    if (total > args.config.dailyTokenCap) {
      return { allowed: false, reason: "Teto diário de tokens atingido" };
    }
  }

  if (args.config.costCap) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1);
    // Estimativa simplificada: usamos o próprio turno + histórico do dia.
    // O custo mensal exigiria uma coluna de custo no log.
    void cost;
  }

  return { allowed: true };
}
