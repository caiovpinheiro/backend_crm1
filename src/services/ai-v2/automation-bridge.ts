/**
 * Bridge automação ↔ v2 (SPEC 3.3).
 * - Ao entrar: lê AutomationContext ativo e variáveis.
 * - Ao encerrar: chama continueFromStep quando configurado.
 * Nenhum domínio de cliente.
 */

import { getContactActiveContexts } from "@/services/automation-context";
import { continueFromStep } from "@/services/automation-executor";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

export type V2AutomationBridgeResult = {
  automationId?: string;
  stepId?: string;
  variables: Record<string, unknown>;
};

type ActiveContext = Awaited<ReturnType<typeof getContactActiveContexts>>[number];

export async function loadV2AutomationBridge(contactId: string): Promise<V2AutomationBridgeResult> {
  const contexts = await getContactActiveContexts(contactId);
  const ctx = contexts[0]; // mais recente
  if (!ctx) return { variables: {} };
  return {
    automationId: ctx.automationId,
    stepId: ctx.currentStepId ?? undefined,
    variables: ((ctx.variables as Record<string, unknown>) ?? {}),
  };
}

export function mapAutomationVariables(
  bridge: V2AutomationBridgeResult,
  config: V2AgentConfig,
): Record<string, unknown> {
  const mapping = config.entry.automationVariablesMapping;
  const out: Record<string, unknown> = {};
  for (const [autoKey, agentKey] of Object.entries(mapping)) {
    if (bridge.variables[autoKey] !== undefined) {
      out[agentKey] = bridge.variables[autoKey];
    }
  }
  return out;
}

export async function continueV2AutomationOnClose(args: {
  config: V2AgentConfig;
  contactId: string;
  collectedVariables: Record<string, unknown>;
}): Promise<void> {
  const nextStepId = args.config.closure.nextAutomationStepId;
  if (!nextStepId) return;

  const contexts = await getContactActiveContexts(args.contactId);
  const ctx = contexts[0];
  if (!ctx) return;

  const variables = {
    ...((ctx.variables as Record<string, unknown>) ?? {}),
    ...args.collectedVariables,
  };

  await continueFromStep(ctx.automationId, args.contactId, nextStepId, variables);
}

