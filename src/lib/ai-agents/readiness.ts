import type { AIAgentAutonomy } from "@prisma/client";

import {
  isUnrestrictedScope,
  normalizeInboxPolicy,
} from "@/lib/ai-agents/steering";

export const AUTONOMOUS_READINESS_MSG =
  "Para ligar Autônomo (ou ativar um agente autônomo), configure escopo mínimo (funil/etapa/tag) ou adicione ao menos 1 documento na base de conhecimento.";

export class AgentReadinessError extends Error {
  constructor(message = AUTONOMOUS_READINESS_MSG) {
    super(message);
    this.name = "AgentReadinessError";
  }
}

export function isAutonomousReady(args: {
  inboxPolicy: unknown;
  knowledgeDocsCount: number;
}): boolean {
  const policy = normalizeInboxPolicy(args.inboxPolicy);
  return !isUnrestrictedScope(policy.scope) || args.knowledgeDocsCount > 0;
}

/** Gate: AUTONOMOUS exige escopo ou KB. */
export function assertAutonomousReadiness(args: {
  nextAutonomy: AIAgentAutonomy;
  nextActive: boolean;
  inboxPolicy: unknown;
  knowledgeDocsCount: number;
}): void {
  if (args.nextAutonomy !== "AUTONOMOUS") return;
  if (
    !isAutonomousReady({
      inboxPolicy: args.inboxPolicy,
      knowledgeDocsCount: args.knowledgeDocsCount,
    })
  ) {
    throw new AgentReadinessError();
  }
}
