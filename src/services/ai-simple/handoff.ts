/**
 * Handoff único da v2 simples.
 *
 * Reaproveita a distribuição/fila existente e adiciona a tag
 * "precisa_humano" no deal para visibilidade na inbox.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { executeDistribution } from "@/services/distribution";
import { addTagToContact } from "@/services/tags";

export type SimpleHandoffInput = {
  organizationId: string;
  conversationId: string;
  contactId: string;
  dealId?: string | null;
  agentUserId: string;
  queue?: string | null;
  reason?: string;
};

export type SimpleHandoffResult = {
  ok: boolean;
  queuedWaiting: boolean;
  assignedUserId?: string | null;
  assignedUserName?: string | null;
  distributionReason?: string | null;
  error?: string | null;
};

export async function simpleHandoff(input: SimpleHandoffInput): Promise<SimpleHandoffResult> {
  await tagDealAsNeedsHuman(input);

  const departmentId = await resolveDepartmentIdByName(
    input.organizationId,
    input.queue?.trim(),
  );

  const result = await executeDistribution({
    conversationId: input.conversationId,
    contactId: input.contactId,
    dealId: input.dealId ?? null,
    triggerSource: "AI_AGENT",
    departmentId,
    reassign: true,
  });

  return {
    ok: result.success,
    queuedWaiting: result.reason === "NO_ELIGIBLE_RESPONSIBLE" || result.reason === "NO_DEPARTMENT",
    assignedUserId: result.selectedUserId ?? null,
    assignedUserName: result.selectedUserName ?? null,
    distributionReason: result.reason ?? null,
    error: result.success ? null : result.reason ?? "falha na distribuição",
  };
}

async function resolveDepartmentIdByName(
  organizationId: string,
  name?: string | null,
): Promise<string | null> {
  if (!name) return null;
  const dept = await prisma.department.findFirst({
    where: {
      organizationId,
      name: { equals: name, mode: "insensitive" },
    },
    select: { id: true },
  });
  return dept?.id ?? null;
}

async function tagDealAsNeedsHuman(input: SimpleHandoffInput): Promise<void> {
  if (!input.dealId) return;

  const tagName = "precisa_humano";
  let tag = await prisma.tag.findFirst({
    where: {
      organizationId: input.organizationId,
      name: { equals: tagName, mode: "insensitive" },
    },
    select: { id: true },
  });

  if (!tag) {
    tag = await prisma.tag.create({
      data: withOrgFromCtx({ name: tagName, color: "#ef4444" }),
      select: { id: true },
    });
  }

  const already = await prisma.tagOnContact.findFirst({
    where: { contactId: input.contactId, tagId: tag.id },
    select: { contactId: true },
  });

  if (!already) {
    await addTagToContact(input.contactId, tag.id).catch(() => null);
  }
}
