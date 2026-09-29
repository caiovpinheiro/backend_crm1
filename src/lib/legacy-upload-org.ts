import { prismaBase } from "@/lib/prisma-base";

/**
 * Resolve o tenant dono de um arquivo em `public/uploads` a partir das
 * referências no banco (mensagem, avatar de user, avatar de contato).
 * Órfão → null (não servir).
 */
export async function resolveLegacyUploadOrgId(
  filenameRelative: string,
): Promise<string | null> {
  const candidates = [
    `/uploads/${filenameRelative}`,
    `/uploads/${filenameRelative}?`,
  ];

  for (const url of candidates) {
    const msg = await prismaBase.message.findFirst({
      where: {
        OR: [{ mediaUrl: url }, { mediaUrl: { startsWith: url } }],
      },
      select: { conversation: { select: { organizationId: true } } },
    });
    if (msg?.conversation?.organizationId) {
      return msg.conversation.organizationId;
    }
  }

  const userMatch = await prismaBase.user.findFirst({
    where: { avatarUrl: { startsWith: candidates[0] } },
    select: { organizationId: true },
  });
  if (userMatch?.organizationId) return userMatch.organizationId;

  const contactMatch = await prismaBase.contact.findFirst({
    where: { avatarUrl: { startsWith: candidates[0] } },
    select: { organizationId: true },
  });
  if (contactMatch?.organizationId) return contactMatch.organizationId;

  return null;
}
