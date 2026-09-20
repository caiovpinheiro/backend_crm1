/**
 * Estado persistente por conversa da v2 simples.
 *
 * Usa `prismaBase` com cast porque o model é novo e ainda não foi gerado
 * no cliente tipado. O `organizationId` é passado explicitamente em todas
 * as queries (cross-tenant seguro).
 */

import { prismaBase } from "@/lib/prisma-base";
import type { Prisma } from "@prisma/client";
import type { SimpleStage } from "@/lib/ai-simple/types";

export type SimpleConversationStateRow = {
  id: string;
  organizationId: string;
  conversationId: string;
  agentId: string;
  stage: string;
  mode: string | null;
  humanActive: boolean;
  identificationAttempts: number;
  createdAt: Date;
  updatedAt: Date;
};

type SimpleStateDb = {
  findUnique: (args: unknown) => Promise<SimpleConversationStateRow | null>;
  upsert: (args: unknown) => Promise<SimpleConversationStateRow>;
  updateMany: (args: unknown) => Promise<Prisma.BatchPayload>;
  deleteMany: (args: unknown) => Promise<Prisma.BatchPayload>;
};

function db(): SimpleStateDb {
  return (
    prismaBase as unknown as { aISimpleConversationState: SimpleStateDb }
  ).aISimpleConversationState;
}

export async function getSimpleState(
  organizationId: string,
  conversationId: string,
): Promise<SimpleConversationStateRow | null> {
  return db().findUnique({
    where: { conversationId },
  });
}

export async function ensureSimpleState(
  organizationId: string,
  conversationId: string,
  agentId: string,
): Promise<SimpleConversationStateRow> {
  const existing = await getSimpleState(organizationId, conversationId);
  if (existing) return existing;

  return db().upsert({
    where: { conversationId },
    create: {
      organizationId,
      conversationId,
      agentId,
      stage: "new",
      mode: null,
      humanActive: false,
      identificationAttempts: 0,
    },
    update: {},
  });
}

export async function updateSimpleState(
  organizationId: string,
  conversationId: string,
  patch: {
    stage?: SimpleStage;
    mode?: string | null;
    humanActive?: boolean;
    identificationAttempts?: number;
  },
): Promise<void> {
  await db().updateMany({
    where: { organizationId, conversationId },
    data: {
      ...(patch.stage ? { stage: patch.stage } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.humanActive !== undefined ? { humanActive: patch.humanActive } : {}),
      ...(patch.identificationAttempts !== undefined
        ? { identificationAttempts: patch.identificationAttempts }
        : {}),
      updatedAt: new Date(),
    },
  });
}

export async function resetSimpleStateHumanActive(
  organizationId: string,
  conversationId: string,
): Promise<void> {
  await db().updateMany({
    where: { organizationId, conversationId },
    data: { humanActive: false, updatedAt: new Date() },
  });
}

export async function deleteSimpleState(
  organizationId: string,
  conversationId: string,
): Promise<void> {
  await db().deleteMany({
    where: { organizationId, conversationId },
  });
}
