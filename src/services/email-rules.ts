import type { Email, EmailRule } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { withOrg } from "@/lib/prisma-helpers";

export type EmailRuleDto = {
  id: string;
  accountId: string;
  name: string;
  isActive: boolean;
  conditionField: "FROM" | "TO" | "SUBJECT";
  conditionValue: string;
  action: "MOVE" | "TRASH";
  targetFolderId: string | null;
  priority: number;
  createdAt: string;
};

function serializeRule(rule: EmailRule): EmailRuleDto {
  return {
    id: rule.id,
    accountId: rule.accountId,
    name: rule.name,
    isActive: rule.isActive,
    conditionField: rule.conditionField as EmailRuleDto["conditionField"],
    conditionValue: rule.conditionValue,
    action: rule.action as EmailRuleDto["action"],
    targetFolderId: rule.targetFolderId,
    priority: rule.priority,
    createdAt: rule.createdAt.toISOString(),
  };
}

export async function listEmailRules(accountId?: string): Promise<EmailRuleDto[]> {
  const rules = await prisma.emailRule.findMany({
    where: accountId ? { accountId } : undefined,
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return rules.map(serializeRule);
}

export async function createEmailRule(input: {
  accountId: string;
  name: string;
  isActive?: boolean;
  conditionField: EmailRuleDto["conditionField"];
  conditionValue: string;
  action: EmailRuleDto["action"];
  targetFolderId?: string | null;
  priority?: number;
  organizationId: string;
}): Promise<EmailRuleDto> {
  const created = await prisma.emailRule.create({
    data: withOrg(
      {
        accountId: input.accountId,
        name: input.name.trim(),
        isActive: input.isActive !== false,
        conditionField: input.conditionField,
        conditionValue: input.conditionValue.trim(),
        action: input.action,
        targetFolderId: input.action === "MOVE" ? input.targetFolderId ?? null : null,
        priority: input.priority ?? 0,
      },
      input.organizationId,
    ),
  });
  return serializeRule(created);
}

export async function updateEmailRule(
  id: string,
  input: Partial<{
    name: string;
    isActive: boolean;
    conditionField: EmailRuleDto["conditionField"];
    conditionValue: string;
    action: EmailRuleDto["action"];
    targetFolderId: string | null;
    priority: number;
  }>,
): Promise<EmailRuleDto | null> {
  const existing = await prisma.emailRule.findFirst({ where: { id } });
  if (!existing) return null;
  const updated = await prisma.emailRule.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.conditionField !== undefined ? { conditionField: input.conditionField } : {}),
      ...(input.conditionValue !== undefined ? { conditionValue: input.conditionValue.trim() } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.targetFolderId !== undefined ? { targetFolderId: input.targetFolderId } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  });
  return serializeRule(updated);
}

export async function deleteEmailRule(id: string): Promise<boolean> {
  const result = await prisma.emailRule.deleteMany({ where: { id } });
  return result.count > 0;
}

function fieldValue(email: Pick<Email, "fromAddress" | "toAddress" | "subject">, field: string) {
  if (field === "FROM") return email.fromAddress ?? "";
  if (field === "TO") return email.toAddress ?? "";
  return email.subject ?? "";
}

export function matchEmailRule(
  email: Pick<Email, "fromAddress" | "toAddress" | "subject">,
  rule: EmailRule,
): boolean {
  const hay = fieldValue(email, rule.conditionField).toLowerCase();
  return hay.includes(rule.conditionValue.trim().toLowerCase());
}

export async function applyRulesToEmail(email: Email): Promise<Email> {
  const rules = await prisma.emailRule.findMany({
    where: { accountId: email.accountId, isActive: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  const hit = rules.find((r) => matchEmailRule(email, r));
  if (!hit) return email;
  if (hit.action === "TRASH") {
    return prisma.email.update({
      where: { id: email.id },
      data: { folder: "TRASH", customFolderId: null },
    });
  }
  if (hit.action === "MOVE" && hit.targetFolderId) {
    return prisma.email.update({
      where: { id: email.id },
      data: { customFolderId: hit.targetFolderId },
    });
  }
  return email;
}
