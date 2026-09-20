/**
 * Pesquisa de satisfação (SPEC 3.21).
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import type { V2AgentConfig, V2SurveyType } from "@/lib/ai-v2/types";

export function buildSurveyMessage(config: V2AgentConfig): string | null {
  if (!config.survey.enabled) return null;
  return config.survey.question;
}

export function parseSurveyScore(text: string, type: V2SurveyType): number | null {
  const normalized = text.trim().toLowerCase();
  if (type === "binary") {
    if (/\b(sim|gostei|ótimo|bom|excelente|ok|yes)\b/.test(normalized)) return 1;
    if (/\b(não|nao|nÃo|gostei n|ruim|péssimo|no)\b/.test(normalized)) return 0;
    return null;
  }
  const match = normalized.match(/\b(\d+)\b/);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (type === "nps") {
    if (n >= 0 && n <= 10) return n;
  }
  if (type === "csat") {
    if (n >= 1 && n <= 5) return n;
  }
  return null;
}

export async function recordSurveyResponse(args: {
  organizationId: string;
  contactId: string;
  dealId?: string;
  agentId: string;
  score: number;
  reason?: string;
}): Promise<void> {
  await (prisma as unknown as {
    aIAgentSurveyResponse: {
      create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    };
  }).aIAgentSurveyResponse.create({
    data: {
      organizationId: args.organizationId,
      contactId: args.contactId,
      dealId: args.dealId ?? null,
      agentId: args.agentId,
      score: args.score,
      reason: args.reason ?? null,
    },
  }).catch(() => {
    // Tabela pode não existir; não quebra o fluxo.
  });
}
