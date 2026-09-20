/**
 * Motor do fluxo "Primeiros dias" (SPEC 3.23).
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import type {
  V2AgentConfig,
  V2CRMContext,
  V2LLMOutput,
  V2OnboardingConfig,
  V2OnboardingStep,
} from "@/lib/ai-v2/types";

export type V2OnboardingState = {
  currentStepId: string | null;
  stepAttempts: Record<string, number>;
  completedStepIds: string[];
};

export function parseV2OnboardingState(raw: unknown): V2OnboardingState {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    currentStepId: typeof r.currentStepId === "string" ? r.currentStepId : null,
    stepAttempts: typeof r.stepAttempts === "object" && r.stepAttempts != null ? (r.stepAttempts as Record<string, number>) : {},
    completedStepIds: Array.isArray(r.completedStepIds) ? r.completedStepIds as string[] : [],
  };
}

export function currentV2OnboardingStep(
  config: V2OnboardingConfig,
  state: V2OnboardingState,
): V2OnboardingStep | null {
  for (const step of config.steps) {
    if (!state.completedStepIds.includes(step.id)) {
      return step;
    }
  }
  return null;
}

export function isV2OnboardingStepCompleted(
  step: V2OnboardingStep,
  context: V2CRMContext,
  llmOutput: V2LLMOutput,
): boolean {
  const criteria = step.completionCriteria;
  switch (criteria.type) {
    case "field_filled":
      if (!criteria.field) return false;
      return (
        (context.contact?.[criteria.field] != null && String(context.contact[criteria.field]).trim() !== "") ||
        (context.selectedDeal?.[criteria.field] != null && String(context.selectedDeal[criteria.field]).trim() !== "")
      );
    case "client_reply":
      return llmOutput.reply.length > 0;
    case "stage":
      return context.selectedDeal?.stageName === criteria.value;
    case "action":
      return llmOutput.actions.some((a) => a.type === criteria.action);
  }
}

export function shouldHandoffOnboardingStep(
  step: V2OnboardingStep,
  state: V2OnboardingState,
): boolean {
  const attempts = state.stepAttempts[step.id] ?? 0;
  return attempts >= step.maxAttempts;
}

export function advanceV2OnboardingState(
  config: V2OnboardingConfig,
  state: V2OnboardingState,
  completedStepId: string,
): V2OnboardingState {
  return {
    ...state,
    currentStepId: config.steps.find((s) => !state.completedStepIds.includes(s.id) && s.id !== completedStepId)?.id ?? null,
    completedStepIds: [...state.completedStepIds, completedStepId],
    stepAttempts: { ...state.stepAttempts, [completedStepId]: 0 },
  };
}

export function incrementStepAttempt(state: V2OnboardingState, stepId: string): V2OnboardingState {
  return {
    ...state,
    stepAttempts: {
      ...state.stepAttempts,
      [stepId]: (state.stepAttempts[stepId] ?? 0) + 1,
    },
  };
}

export async function recordV2KnowledgeGap(args: {
  organizationId: string;
  agentId: string;
  themeId?: string;
  question: string;
}): Promise<void> {
  const existing = await (prisma as unknown as {
    aIV2KnowledgeGap: {
      findFirst: (args: { where: Record<string, unknown> }) => Promise<{ id: string; frequency: number } | null>;
    };
  }).aIV2KnowledgeGap.findFirst({
    where: {
      organizationId: args.organizationId,
      agentId: args.agentId,
      question: args.question,
    },
  });

  if (existing) {
    await (prisma as unknown as {
      aIV2KnowledgeGap: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<void>;
      };
    }).aIV2KnowledgeGap.update({
      where: { id: existing.id },
      data: { frequency: existing.frequency + 1, updatedAt: new Date() },
    });
    return;
  }

  await (prisma as unknown as {
    aIV2KnowledgeGap: {
      create: (args: { data: Record<string, unknown> }) => Promise<void>;
    };
  }).aIV2KnowledgeGap.create({
    data: {
      organizationId: args.organizationId,
      agentId: args.agentId,
      themeId: args.themeId ?? null,
      question: args.question,
      frequency: 1,
      status: "pending",
    },
  });
}
