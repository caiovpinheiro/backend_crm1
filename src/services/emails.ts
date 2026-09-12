import type { EmailFolder } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { withOrg } from "@/lib/prisma-helpers";
import { getRequestContext, runWithContext } from "@/lib/request-context";
import { decryptAccountPassword, type SerializedEmailAccount } from "@/services/email-accounts";
import { sendSmtpMail } from "@/services/email-smtp";
import { applyRulesToEmail } from "@/services/email-rules";

const FOLDERS = new Set<EmailFolder>(["INBOX", "SENT", "TRASH"]);

export type EmailListItemDto = {
  id: string;
  accountId: string;
  folder: EmailFolder;
  customFolderId: string | null;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string | null;
  bodyText: string | null;
  isRead: boolean;
  receivedAt: string | null;
  contact: { id: string; name: string; avatarUrl: string | null } | null;
};

export type EmailDetailDto = EmailListItemDto & {
  bodyHtml: string | null;
  messageId: string | null;
  account: { id: string; email: string; visibility: SerializedEmailAccount["visibility"] };
};

function serializeListItem(row: {
  id: string;
  accountId: string;
  folder: EmailFolder;
  customFolderId: string | null;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string | null;
  bodyText: string | null;
  isRead: boolean;
  receivedAt: Date | null;
  contact: { id: string; name: string; avatarUrl: string | null } | null;
}): EmailListItemDto {
  return {
    id: row.id,
    accountId: row.accountId,
    folder: row.folder,
    customFolderId: row.customFolderId,
    threadId: row.threadId,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    toAddress: row.toAddress,
    subject: row.subject,
    bodyText: row.bodyText,
    isRead: row.isRead,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    contact: row.contact,
  };
}

export async function listEmails(params: {
  accountIds: string[];
  accountId?: string;
  folder?: EmailFolder;
  customFolderId?: string;
  search?: string;
  unreadOnly?: boolean;
  page?: number;
  perPage?: number;
}) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 25));
  const accountId = params.accountId && params.accountIds.includes(params.accountId)
    ? params.accountId
    : undefined;
  const ids = accountId ? [accountId] : params.accountIds;
  if (ids.length === 0) {
    return { emails: [] as EmailListItemDto[], pagination: { page, perPage, total: 0, pages: 1 } };
  }

  const folder = params.folder && FOLDERS.has(params.folder) ? params.folder : undefined;
  const q = params.search?.trim();

  const where = {
    accountId: { in: ids },
    ...(params.customFolderId
      ? { customFolderId: params.customFolderId }
      : folder
        ? { folder, customFolderId: null }
        : {}),
    ...(q
      ? {
          OR: [
            { subject: { contains: q, mode: "insensitive" as const } },
            { fromAddress: { contains: q, mode: "insensitive" as const } },
            { fromName: { contains: q, mode: "insensitive" as const } },
            { bodyText: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(params.unreadOnly ? { isRead: false } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.email.count({ where }),
    prisma.email.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: { contact: { select: { id: true, name: true, avatarUrl: true } } },
    }),
  ]);

  return {
    emails: rows.map(serializeListItem),
    pagination: { page, perPage, total, pages: Math.max(1, Math.ceil(total / perPage)) },
  };
}

export async function getEmail(id: string, accountIds: string[]): Promise<EmailDetailDto | null> {
  const row = await prisma.email.findFirst({
    where: { id, accountId: { in: accountIds } },
    include: {
      contact: { select: { id: true, name: true, avatarUrl: true } },
      account: { select: { id: true, email: true, visibility: true } },
    },
  });
  if (!row) return null;
  return {
    ...serializeListItem(row),
    bodyHtml: row.bodyHtml,
    messageId: row.messageId ?? null,
    account: row.account,
  };
}

export async function markEmailRead(id: string, accountIds: string[], isRead: boolean) {
  const result = await prisma.email.updateMany({
    where: { id, accountId: { in: accountIds } },
    data: { isRead },
  });
  return result.count > 0;
}

export async function moveEmail(
  id: string,
  accountIds: string[],
  input: { systemFolder?: EmailFolder; customFolderId?: string | null },
) {
  const existing = await prisma.email.findFirst({
    where: { id, accountId: { in: accountIds } },
  });
  if (!existing) return false;
  await prisma.email.update({
    where: { id },
    data: {
      ...(input.systemFolder && FOLDERS.has(input.systemFolder) ? { folder: input.systemFolder } : {}),
      ...(input.customFolderId !== undefined ? { customFolderId: input.customFolderId } : {}),
    },
  });
  return true;
}

export async function deleteEmail(id: string, accountIds: string[]) {
  const result = await prisma.email.updateMany({
    where: { id, accountId: { in: accountIds } },
    data: { folder: "TRASH", customFolderId: null },
  });
  return result.count > 0;
}

export async function sendEmail(params: {
  accountId: string;
  to: string;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  inReplyTo?: string;
}) {
  const account = await prisma.emailAccount.findFirst({ where: { id: params.accountId } });
  if (!account) throw new Error("Conta de e-mail não encontrada.");
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
      to: params.to,
      subject: params.subject,
      text: params.bodyText,
      html: params.bodyHtml,
      inReplyTo: params.inReplyTo,
    },
  );
  if (!sent.ok) throw new Error(sent.message);

  const messageId = sent.messageId.replace(/^<|>$/g, "");
  const current = getRequestContext();
  return runWithContext(
    {
      organizationId: account.organizationId,
      userId: current?.userId ?? account.ownerUserId ?? "SYSTEM",
      isSuperAdmin: current?.isSuperAdmin ?? false,
      actor: current?.actor ?? { type: "SYSTEM", label: "email-send" },
    },
    async () => {
      const created = await prisma.email.create({
        data: withOrg(
          {
            accountId: account.id,
            folder: "SENT" as const,
            threadId: params.subject.trim().toLowerCase() || messageId,
            messageId,
            fromAddress: account.email,
            fromName: null,
            toAddress: params.to.trim(),
            subject: params.subject,
            bodyText: params.bodyText ?? null,
            bodyHtml: params.bodyHtml ?? null,
            isRead: true,
            receivedAt: new Date(),
          },
          account.organizationId,
        ),
      });
      await applyRulesToEmail(created);
      return { id: created.id };
    },
  );
}
