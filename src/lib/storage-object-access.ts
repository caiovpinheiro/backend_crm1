import { prismaBase } from "@/lib/prisma-base";

export type StorageAuthzSession = {
  userId: string;
  organizationId: string | null;
  isSuperAdmin?: boolean;
  role?: string | null;
};

export type StorageObjectLookup = {
  findKeepOwnerUserId: (orgId: string, fileName: string) => Promise<string | null>;
  findExportOwnerUserId: (orgId: string, fileName: string) => Promise<string | null>;
  findTeamChatRoomId: (orgId: string, fileName: string) => Promise<string | null>;
  isRoomMember: (roomId: string, userId: string) => Promise<boolean>;
};

function likeNeedle(fileName: string): string {
  return `%${fileName.replace(/[%_\\]/g, "")}%`;
}

export const defaultStorageObjectLookup: StorageObjectLookup = {
  async findKeepOwnerUserId(orgId, fileName) {
    const row = await prismaBase.keepAttachment.findFirst({
      where: { organizationId: orgId, storageKey: fileName },
      select: { userId: true },
    });
    return row?.userId ?? null;
  },
  async findExportOwnerUserId(orgId, fileName) {
    const row = await prismaBase.dataRequest.findFirst({
      where: {
        organizationId: orgId,
        downloadKey: { contains: fileName },
      },
      select: { userId: true },
    });
    return row?.userId ?? null;
  },
  async findTeamChatRoomId(orgId, fileName) {
    const needle = likeNeedle(fileName);
    if (needle === "%%") return null;
    const rows = await prismaBase.$queryRaw<{ roomId: string }[]>`
      SELECT "roomId" FROM team_chat_messages
      WHERE "organizationId" = ${orgId}
        AND attachments::text LIKE ${needle}
      LIMIT 1
    `;
    return rows[0]?.roomId ?? null;
  },
  async isRoomMember(roomId, userId) {
    const m = await prismaBase.teamChatMember.findFirst({
      where: { roomId, userId },
      select: { id: true },
    });
    return Boolean(m);
  },
};

function canImportFiles(session: StorageAuthzSession): boolean {
  if (session.isSuperAdmin) return true;
  return session.role === "ADMIN" || session.role === "MANAGER";
}

/**
 * Depois do isolamento de org: Keeps (dono), export LGPD (alvo),
 * imports (ADMIN/MANAGER), anexo de sala privada (membro).
 * Inbox / inbound-media / recordings / automation-media / avatars
 * permanecem por organização.
 */
export async function authorizeStorageObject(
  session: StorageAuthzSession,
  parsed: { orgId: string; bucket: string; fileName: string },
  lookup: StorageObjectLookup = defaultStorageObjectLookup,
): Promise<boolean> {
  if (session.isSuperAdmin) return true;
  if (!session.organizationId || session.organizationId !== parsed.orgId) {
    return false;
  }

  switch (parsed.bucket) {
    case "keeps": {
      const owner = await lookup.findKeepOwnerUserId(parsed.orgId, parsed.fileName);
      return owner === session.userId;
    }
    case "data-exports": {
      const owner = await lookup.findExportOwnerUserId(parsed.orgId, parsed.fileName);
      return owner === session.userId;
    }
    case "imports":
      return canImportFiles(session);
    case "attachments": {
      const roomId = await lookup.findTeamChatRoomId(parsed.orgId, parsed.fileName);
      if (!roomId) return true;
      return lookup.isRoomMember(roomId, session.userId);
    }
    default:
      return true;
  }
}
