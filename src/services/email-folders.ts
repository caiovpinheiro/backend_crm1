import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

export type EmailCustomFolderDto = {
  id: string;
  accountId: string;
  name: string;
  color: string | null;
  createdAt: string;
  unreadCount: number;
};

export async function listEmailCustomFolders(accountId?: string): Promise<EmailCustomFolderDto[]> {
  const folders = await prisma.emailCustomFolder.findMany({
    where: accountId ? { accountId } : undefined,
    orderBy: { createdAt: "asc" },
  });
  if (folders.length === 0) return [];

  const unread = await prisma.email.groupBy({
    by: ["customFolderId"],
    where: {
      customFolderId: { in: folders.map((f) => f.id) },
      isRead: false,
    },
    _count: { _all: true },
  });
  const byFolder = new Map(unread.map((r) => [r.customFolderId, r._count._all]));

  return folders.map((f) => ({
    id: f.id,
    accountId: f.accountId,
    name: f.name,
    color: f.color,
    createdAt: f.createdAt.toISOString(),
    unreadCount: byFolder.get(f.id) ?? 0,
  }));
}

export async function createEmailCustomFolder(input: {
  accountId: string;
  name: string;
  color?: string | null;
}): Promise<EmailCustomFolderDto> {
  const created = await prisma.emailCustomFolder.create({
    data: withOrgFromCtx({
      accountId: input.accountId,
      name: input.name.trim(),
      color: input.color ?? null,
    }),
  });
  return {
    id: created.id,
    accountId: created.accountId,
    name: created.name,
    color: created.color,
    createdAt: created.createdAt.toISOString(),
    unreadCount: 0,
  };
}

export async function updateEmailCustomFolder(
  id: string,
  input: { name?: string; color?: string | null },
): Promise<EmailCustomFolderDto | null> {
  const existing = await prisma.emailCustomFolder.findFirst({ where: { id } });
  if (!existing) return null;
  const updated = await prisma.emailCustomFolder.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    },
  });
  return {
    id: updated.id,
    accountId: updated.accountId,
    name: updated.name,
    color: updated.color,
    createdAt: updated.createdAt.toISOString(),
    unreadCount: 0,
  };
}

export async function deleteEmailCustomFolder(id: string): Promise<boolean> {
  const result = await prisma.emailCustomFolder.deleteMany({ where: { id } });
  return result.count > 0;
}
