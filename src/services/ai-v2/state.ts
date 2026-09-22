/**
 * Persistência do estado da conversa v2.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import type { V2Owner, V2Stage } from "@/lib/ai-v2/types";
import { parseV2Counters, defaultV2Counters, type V2Counters } from "./limits";

export type V2ConversationStateRow = {
  id: string;
  organizationId: string;
  conversationId: string;
  agentId: string;
  stage: string;
  mode?: string | null;
  themeId?: string | null;
  humanActive: boolean;
  owner: string;
  originStageId?: string | null;
  postCloseWindowEndAt?: Date | null;
  closeReason?: string | null;
  versionId?: string | null;
  selectedDealId?: string | null;
  identificationAttempts: number;
  counters: Record<string, unknown>;
};

export async function getV2ConversationState(
  conversationId: string,
): Promise<V2ConversationStateRow | null> {
  const row = await (prisma as unknown as {
    aISimpleConversationState: {
      findUnique: (args: { where: { conversationId: string } }) => Promise<V2ConversationStateRow | null>;
    };
  }).aISimpleConversationState.findUnique({
    where: { conversationId },
  });
  return row;
}

export async function upsertV2ConversationState(args: {
  organizationId: string;
  conversationId: string;
  agentId: string;
  stage?: V2Stage;
  mode?: string | null;
  themeId?: string | null;
  owner?: V2Owner;
  originStageId?: string | null;
  postCloseWindowEndAt?: Date | null;
  closeReason?: string | null;
  versionId?: string | null;
  selectedDealId?: string | null;
  identificationAttempts?: number;
  counters?: V2Counters;
}): Promise<V2ConversationStateRow> {
  const existing = await getV2ConversationState(args.conversationId);
  const data: Record<string, unknown> = {
    stage: args.stage ?? existing?.stage ?? "idle",
    mode: args.mode ?? existing?.mode ?? null,
    themeId: args.themeId ?? existing?.themeId ?? null,
    owner: args.owner ?? existing?.owner ?? "agente",
    originStageId: args.originStageId !== undefined ? args.originStageId : existing?.originStageId ?? null,
    postCloseWindowEndAt: args.postCloseWindowEndAt !== undefined ? args.postCloseWindowEndAt : existing?.postCloseWindowEndAt ?? null,
    closeReason: args.closeReason !== undefined ? args.closeReason : existing?.closeReason ?? null,
    versionId: args.versionId !== undefined ? args.versionId : existing?.versionId ?? null,
    selectedDealId: args.selectedDealId !== undefined ? args.selectedDealId : existing?.selectedDealId ?? null,
    identificationAttempts: args.identificationAttempts ?? existing?.identificationAttempts ?? 0,
      counters: args.counters ? (args.counters as unknown as Record<string, unknown>) : existing?.counters ?? {},
  };

  if (existing) {
    const updated = await (prisma as unknown as {
      aISimpleConversationState: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<V2ConversationStateRow>;
      };
    }).aISimpleConversationState.update({
      where: { id: existing.id },
      data,
    });
    return updated;
  }

  const created = await (prisma as unknown as {
    aISimpleConversationState: {
      create: (args: { data: Record<string, unknown> }) => Promise<V2ConversationStateRow>;
    };
  }).aISimpleConversationState.create({
    data: {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      ...data,
    },
  });
  return created;
}

export async function resetV2Counters(
  conversationId: string,
): Promise<void> {
  await (prisma as unknown as {
    aISimpleConversationState: {
      update: (args: { where: { conversationId: string }; data: Record<string, unknown> }) => Promise<void>;
    };
  }).aISimpleConversationState.update({
    where: { conversationId },
    data: { counters: defaultV2Counters() as unknown as Record<string, unknown> },
  });
}
