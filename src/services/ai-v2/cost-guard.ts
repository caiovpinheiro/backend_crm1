/**
 * Guarda de custo do motor v2: teto de tokens por dia e de gasto (US$) por
 * dia e por mês, contados no fuso do horário de atendimento do agente.
 * Antes só o teto de tokens valia; o de US$ tinha a tela prevista e nada
 * era conferido. Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { estimateCost } from "@/lib/ai-agents/pricing";
import { v2ModelInfo } from "@/lib/ai-v2/models";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

type Usage = { inputTokens: number; outputTokens: number };

/** Início do dia ou do mês no fuso indicado, como instante UTC. */
export function startOfPeriod(unit: "day" | "month", timeZone: string, now = new Date()): Date {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return timeZone === "America/Sao_Paulo" ? new Date(now) : startOfPeriod(unit, "America/Sao_Paulo", now);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000;
  const start = unit === "day" ? Date.UTC(get("year"), get("month") - 1, get("day")) : Date.UTC(get("year"), get("month") - 1, 1);
  return new Date(start - offset);
}

/**
 * Custo estimado em US$ pelo preço do modelo do agente. O log do turno não
 * guarda o modelo de cada chamada (a checagem usa um auxiliar mais barato):
 * a estimativa pelo modelo principal fica do lado seguro.
 */
export function estimateV2Cost(model: string, usage: Usage): number {
  const info = v2ModelInfo(model);
  if (info) return (usage.inputTokens / 1_000_000) * info.inputPer1M + (usage.outputTokens / 1_000_000) * info.outputPer1M;
  return estimateCost(model, usage.inputTokens, usage.outputTokens);
}

async function usageSince(organizationId: string, agentId: string, since: Date): Promise<Usage> {
  const result = await (prisma as unknown as {
    aISimpleTurnLog: {
      aggregate: (args: {
        where: Record<string, unknown>;
        _sum: { inputTokens: boolean; outputTokens: boolean };
      }) => Promise<{ _sum: { inputTokens: number | null; outputTokens: number | null } }>;
    };
  }).aISimpleTurnLog.aggregate({
    where: { organizationId, agentId, createdAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return { inputTokens: result._sum.inputTokens ?? 0, outputTokens: result._sum.outputTokens ?? 0 };
}

export async function checkV2CostCap(args: {
  config: V2AgentConfig;
  agentId: string;
  organizationId: string;
  inputTokens: number;
  outputTokens: number;
  now?: Date;
}): Promise<{ allowed: boolean; reason?: string }> {
  const perDayUsd = args.config.costCap?.maxUsdPerDay ?? 0;
  const perMonthUsd = args.config.costCap?.maxUsdPerMonth ?? 0;
  const tokenCap = args.config.dailyTokenCap ?? 0;
  if (tokenCap <= 0 && perDayUsd <= 0 && perMonthUsd <= 0) return { allowed: true };

  const timeZone = args.config.businessHours?.timezone || "America/Sao_Paulo";
  const now = args.now ?? new Date();
  const withTurn = (u: Usage): Usage => ({ inputTokens: u.inputTokens + args.inputTokens, outputTokens: u.outputTokens + args.outputTokens });

  if (tokenCap > 0 || perDayUsd > 0) {
    const today = withTurn(await usageSince(args.organizationId, args.agentId, startOfPeriod("day", timeZone, now)));
    if (tokenCap > 0 && today.inputTokens + today.outputTokens > tokenCap) {
      return { allowed: false, reason: "Teto diário de tokens atingido" };
    }
    if (perDayUsd > 0) {
      const usd = estimateV2Cost(args.config.model, today);
      if (usd > perDayUsd) return { allowed: false, reason: `Teto diário de gasto atingido (≈ US$ ${usd.toFixed(2)} de US$ ${perDayUsd})` };
    }
  }

  if (perMonthUsd > 0) {
    const month = withTurn(await usageSince(args.organizationId, args.agentId, startOfPeriod("month", timeZone, now)));
    const usd = estimateV2Cost(args.config.model, month);
    if (usd > perMonthUsd) return { allowed: false, reason: `Teto mensal de gasto atingido (≈ US$ ${usd.toFixed(2)} de US$ ${perMonthUsd})` };
  }

  return { allowed: true };
}
