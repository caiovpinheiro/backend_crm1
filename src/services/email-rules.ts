import type { Email, EmailAccount, EmailRule } from "@prisma/client";

import { decryptAccountPassword } from "@/services/email-accounts";
import {
  ensureEmailOutlookColumns,
  isMissingEmailOutlookColumn,
} from "@/services/email-schema-ensure";
import { sendSmtpMail } from "@/services/email-smtp";
import { prisma } from "@/lib/prisma";
import { withOrg } from "@/lib/prisma-helpers";
import { getRequestContext, runWithContext } from "@/lib/request-context";

export const RULE_FIELDS = ["FROM", "TO", "SUBJECT", "BODY", "ALWAYS"] as const;
export const RULE_ACTIONS = ["MOVE", "TRASH", "SPAM", "FORWARD", "REPLY", "MARK_READ"] as const;

export type EmailRuleField = (typeof RULE_FIELDS)[number];
export type EmailRuleAction = (typeof RULE_ACTIONS)[number];

export type EmailRuleDto = {
  id: string;
  accountId: string;
  name: string;
  isActive: boolean;
  conditionField: EmailRuleField;
  conditionValue: string;
  action: EmailRuleAction;
  targetFolderId: string | null;
  actionTarget: string | null;
  actionBody: string | null;
  priority: number;
  createdAt: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTO_SUBJECT_RE =
  /^\s*(auto:|automatic reply|resposta autom[aá]tica|out of office|fora do escrit[oó]rio)/i;

export function isRuleField(v: unknown): v is EmailRuleField {
  return typeof v === "string" && (RULE_FIELDS as readonly string[]).includes(v);
}

export function isRuleAction(v: unknown): v is EmailRuleAction {
  return typeof v === "string" && (RULE_ACTIONS as readonly string[]).includes(v);
}

const RULE_BASE_SELECT = {
  id: true,
  accountId: true,
  name: true,
  isActive: true,
  conditionField: true,
  conditionValue: true,
  action: true,
  targetFolderId: true,
  priority: true,
  createdAt: true,
} as const;

function serializeRule(rule: Pick<EmailRule, keyof EmailRuleDto> & Partial<Pick<EmailRule, "actionTarget" | "actionBody">>): EmailRuleDto {
  return {
    id: rule.id,
    accountId: rule.accountId,
    name: rule.name,
    isActive: rule.isActive,
    conditionField: rule.conditionField as EmailRuleField,
    conditionValue: rule.conditionValue,
    action: rule.action as EmailRuleAction,
    targetFolderId: rule.targetFolderId,
    actionTarget: rule.actionTarget ?? null,
    actionBody: rule.actionBody ?? null,
    priority: rule.priority,
    createdAt: rule.createdAt.toISOString(),
  };
}

export async function listEmailRules(accountId?: string): Promise<EmailRuleDto[]> {
  await ensureEmailOutlookColumns();
  const where = accountId ? { accountId } : undefined;
  const orderBy = [{ priority: "asc" as const }, { createdAt: "asc" as const }];
  try {
    const rules = await prisma.emailRule.findMany({
      where,
      orderBy,
      select: { ...RULE_BASE_SELECT, actionTarget: true, actionBody: true },
    });
    return rules.map(serializeRule);
  } catch (e) {
    if (!isMissingEmailOutlookColumn(e)) throw e;
    const rules = await prisma.emailRule.findMany({
      where,
      orderBy,
      select: RULE_BASE_SELECT,
    });
    return rules.map((rule) => serializeRule({ ...rule, actionTarget: null, actionBody: null }));
  }
}

export async function createEmailRule(input: {
  accountId: string;
  name: string;
  isActive?: boolean;
  conditionField: EmailRuleField;
  conditionValue: string;
  action: EmailRuleAction;
  targetFolderId?: string | null;
  actionTarget?: string | null;
  actionBody?: string | null;
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
        conditionValue: input.conditionField === "ALWAYS" ? "*" : input.conditionValue.trim(),
        action: input.action,
        targetFolderId: input.action === "MOVE" ? input.targetFolderId ?? null : null,
        actionTarget: input.action === "FORWARD" ? input.actionTarget?.trim() || null : null,
        actionBody: input.action === "REPLY" ? input.actionBody?.trim() || null : null,
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
    conditionField: EmailRuleField;
    conditionValue: string;
    action: EmailRuleAction;
    targetFolderId: string | null;
    actionTarget: string | null;
    actionBody: string | null;
    priority: number;
  }>,
): Promise<EmailRuleDto | null> {
  const existing = await prisma.emailRule.findFirst({ where: { id } });
  if (!existing) return null;
  const action = input.action ?? (existing.action as EmailRuleAction);
  const updated = await prisma.emailRule.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.conditionField !== undefined ? { conditionField: input.conditionField } : {}),
      ...(input.conditionValue !== undefined
        ? {
            conditionValue:
              (input.conditionField ?? existing.conditionField) === "ALWAYS"
                ? "*"
                : input.conditionValue.trim(),
          }
        : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.targetFolderId !== undefined || input.action !== undefined
        ? { targetFolderId: action === "MOVE" ? input.targetFolderId ?? existing.targetFolderId : null }
        : {}),
      ...(input.actionTarget !== undefined || input.action !== undefined
        ? { actionTarget: action === "FORWARD" ? input.actionTarget?.trim() || null : null }
        : {}),
      ...(input.actionBody !== undefined || input.action !== undefined
        ? { actionBody: action === "REPLY" ? input.actionBody?.trim() || null : null }
        : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  });
  return serializeRule(updated);
}

export async function deleteEmailRule(id: string): Promise<boolean> {
  const result = await prisma.emailRule.deleteMany({ where: { id } });
  return result.count > 0;
}

function fieldValue(
  email: Pick<Email, "fromAddress" | "toAddress" | "subject" | "bodyText">,
  field: string,
) {
  if (field === "FROM") return email.fromAddress ?? "";
  if (field === "TO") return email.toAddress ?? "";
  if (field === "BODY") return email.bodyText ?? "";
  return email.subject ?? "";
}

export function matchEmailRule(
  email: Pick<Email, "fromAddress" | "toAddress" | "subject" | "bodyText">,
  rule: EmailRule,
): boolean {
  if (rule.conditionField === "ALWAYS") return true;
  const hay = fieldValue(email, rule.conditionField).toLowerCase();
  const needle = rule.conditionValue.trim().toLowerCase();
  if (!needle) return false;
  return hay.includes(needle);
}

function looksAutomated(email: Pick<Email, "fromAddress" | "subject">, accountEmail: string) {
  if (!email.fromAddress) return true;
  if (email.fromAddress.trim().toLowerCase() === accountEmail.trim().toLowerCase()) return true;
  return AUTO_SUBJECT_RE.test(email.subject ?? "");
}

function oooIsActive(account: EmailAccount, now = new Date()) {
  if (!account.oooEnabled) return false;
  if (account.oooStartsAt && account.oooStartsAt.getTime() > now.getTime()) return false;
  if (account.oooEndsAt && account.oooEndsAt.getTime() < now.getTime()) return false;
  return true;
}

async function recordOutgoing(
  account: EmailAccount,
  mail: { to: string; subject: string; bodyText: string; inReplyTo?: string | null },
) {
  const password = decryptAccountPassword(account);
  const sent = await sendSmtpMail(
    {
      email: account.email,
      password,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpEncryption: account.smtpEncryption,
    },
    {
      to: mail.to,
      subject: mail.subject,
      text: mail.bodyText,
      inReplyTo: mail.inReplyTo ?? undefined,
    },
  );
  if (!sent.ok) return false;

  const messageId = sent.messageId.replace(/^<|>$/g, "");
  const current = getRequestContext();
  await runWithContext(
    {
      organizationId: account.organizationId,
      userId: current?.userId ?? account.ownerUserId ?? "SYSTEM",
      isSuperAdmin: current?.isSuperAdmin ?? false,
      actor: current?.actor ?? { type: "SYSTEM", label: "email-rule" },
    },
    () =>
      prisma.email.create({
        data: withOrg(
          {
            accountId: account.id,
            folder: "SENT" as const,
            threadId: mail.subject.trim().toLowerCase() || messageId,
            messageId,
            fromAddress: account.email,
            fromName: null,
            toAddress: mail.to,
            subject: mail.subject,
            bodyText: mail.bodyText,
            isRead: true,
            autoHandled: true,
            receivedAt: new Date(),
          },
          account.organizationId,
        ),
      }),
  );
  return true;
}

export function normalizeSenderAddress(raw: string): string {
  const trimmed = raw.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  return (angle?.[1] ?? trimmed).trim().toLowerCase();
}

export async function setSenderSpamRule(
  accountId: string,
  fromAddress: string,
  active: boolean,
): Promise<boolean> {
  const addr = normalizeSenderAddress(fromAddress);
  if (!addr.includes("@")) return false;
  await ensureEmailOutlookColumns();

  const account = await prisma.emailAccount.findFirst({
    where: { id: accountId },
    select: { id: true, organizationId: true },
  });
  if (!account) return false;

  const existing = await prisma.emailRule.findFirst({
    where: {
      accountId,
      action: "SPAM",
      conditionField: "FROM",
      conditionValue: { equals: addr, mode: "insensitive" },
    },
    select: { id: true, isActive: true },
  });
  if (existing) {
    if (existing.isActive !== active) {
      await prisma.emailRule.update({
        where: { id: existing.id },
        data: { isActive: active },
      });
    }
    return true;
  }
  if (!active) return false;

  await prisma.emailRule.create({
    data: withOrg(
      {
        accountId,
        name: `Spam: ${addr}`,
        isActive: true,
        conditionField: "FROM",
        conditionValue: addr,
        action: "SPAM",
        priority: 0,
      },
      account.organizationId,
    ),
  });
  return true;
}

async function applyAction(email: Email, account: EmailAccount, rule: EmailRule): Promise<Email> {
  if (rule.action === "TRASH") {
    return prisma.email.update({
      where: { id: email.id },
      data: { folder: "TRASH", customFolderId: null },
    });
  }
  if (rule.action === "SPAM") {
    return prisma.email.update({
      where: { id: email.id },
      data: { folder: "SPAM", customFolderId: null, isRead: true },
    });
  }
  if (rule.action === "MOVE" && rule.targetFolderId) {
    return prisma.email.update({
      where: { id: email.id },
      data: { customFolderId: rule.targetFolderId },
    });
  }
  if (rule.action === "MARK_READ") {
    return prisma.email.update({
      where: { id: email.id },
      data: { isRead: true },
    });
  }
  if (email.autoHandled || email.folder !== "INBOX") return email;

  if (rule.action === "FORWARD") {
    const to = rule.actionTarget?.trim() ?? "";
    if (!EMAIL_RE.test(to)) return email;
    const subject = email.subject?.startsWith("Enc:") ? email.subject : `Enc: ${email.subject || "(sem assunto)"}`;
    const body = [
      `Encaminhado automaticamente de ${email.fromAddress}.`,
      "",
      email.bodyText?.trim() || "(sem conteúdo)",
    ].join("\n");
    const ok = await recordOutgoing(account, { to, subject, bodyText: body });
    if (!ok) return email;
    return prisma.email.update({
      where: { id: email.id },
      data: { autoHandled: true },
    });
  }

  if (rule.action === "REPLY") {
    if (looksAutomated(email, account.email)) return email;
    const body = rule.actionBody?.trim();
    if (!body) return email;
    const subject = email.subject?.toLowerCase().startsWith("re:")
      ? email.subject
      : `Re: ${email.subject || "(sem assunto)"}`;
    const ok = await recordOutgoing(account, {
      to: email.fromAddress,
      subject,
      bodyText: body,
      inReplyTo: email.messageId,
    });
    if (!ok) return email;
    return prisma.email.update({
      where: { id: email.id },
      data: { autoHandled: true },
    });
  }

  return email;
}

async function applyOoo(email: Email, account: EmailAccount): Promise<Email> {
  if (email.autoHandled || email.folder !== "INBOX") return email;
  if (!oooIsActive(account)) return email;
  if (looksAutomated(email, account.email)) return email;
  const body =
    account.oooMessage?.trim() ||
    "Estou fora do escritório e retorno em breve. Obrigado pelo contato.";
  const subject = email.subject?.toLowerCase().startsWith("re:")
    ? email.subject
    : `Re: ${email.subject || "(sem assunto)"}`;
  const ok = await recordOutgoing(account, {
    to: email.fromAddress,
    subject,
    bodyText: body,
    inReplyTo: email.messageId,
  });
  if (!ok) return email;
  return prisma.email.update({
    where: { id: email.id },
    data: { autoHandled: true },
  });
}

export async function applyRulesToEmail(email: Email): Promise<Email> {
  await ensureEmailOutlookColumns();
  if (email.folder === "SENT") return email;

  const account = await prisma.emailAccount.findFirst({ where: { id: email.accountId } });
  if (!account) return email;

  const rules = await prisma.emailRule.findMany({
    where: { accountId: email.accountId, isActive: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });

  let current = email;
  for (const rule of rules) {
    if (!matchEmailRule(current, rule)) continue;
    current = await applyAction(current, account, rule);
  }
  return applyOoo(current, account);
}

export type EmailOooInput = {
  oooEnabled: boolean;
  oooMessage?: string | null;
  oooStartsAt?: string | null;
  oooEndsAt?: string | null;
};

export function serializeOoo(account: EmailAccount) {
  return {
    oooEnabled: account.oooEnabled,
    oooMessage: account.oooMessage,
    oooStartsAt: account.oooStartsAt?.toISOString() ?? null,
    oooEndsAt: account.oooEndsAt?.toISOString() ?? null,
  };
}

export async function updateEmailAccountOoo(
  accountId: string,
  input: EmailOooInput,
): Promise<ReturnType<typeof serializeOoo> | null> {
  const existing = await prisma.emailAccount.findFirst({ where: { id: accountId } });
  if (!existing) return null;
  const updated = await prisma.emailAccount.update({
    where: { id: accountId },
    data: {
      oooEnabled: input.oooEnabled,
      oooMessage: input.oooMessage?.trim() || null,
      oooStartsAt: input.oooStartsAt ? new Date(input.oooStartsAt) : null,
      oooEndsAt: input.oooEndsAt ? new Date(input.oooEndsAt) : null,
    },
  });
  return serializeOoo(updated);
}
