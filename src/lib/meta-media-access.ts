import type { ChannelProvider } from "@prisma/client";

import { getDecryptedChannelConfig } from "@/lib/channels/config";
import { isAllowedMetaMediaUrl } from "@/lib/meta-media-url";
import { prismaBase } from "@/lib/prisma-base";

export type MetaMediaChannel = {
  provider: ChannelProvider;
  config: unknown;
};

export type MetaMediaLookup = {
  findMessageChannel: (
    orgId: string,
    mediaUrl: string,
  ) => Promise<MetaMediaChannel | null>;
  findContactAvatar: (orgId: string, mediaUrl: string) => Promise<boolean>;
  findOrgMetaChannel: (orgId: string) => Promise<MetaMediaChannel | null>;
};

export function tokenFromChannel(channel: MetaMediaChannel | null): string {
  if (!channel) return "";
  const cfg = getDecryptedChannelConfig(channel);
  return typeof cfg.accessToken === "string" ? cfg.accessToken.trim() : "";
}

export const defaultMetaMediaLookup: MetaMediaLookup = {
  async findMessageChannel(orgId, mediaUrl) {
    const msg = await prismaBase.message.findFirst({
      where: {
        conversation: { organizationId: orgId },
        OR: [{ mediaUrl }, { mediaUrl: { contains: mediaUrl.slice(0, 180) } }],
      },
      select: {
        conversation: {
          select: {
            channel: { select: { provider: true, config: true } },
          },
        },
      },
    });
    const ch = msg?.conversation?.channel;
    return ch ?? null;
  },
  async findContactAvatar(orgId, mediaUrl) {
    const hit = await prismaBase.contact.findFirst({
      where: { organizationId: orgId, avatarUrl: mediaUrl },
      select: { id: true },
    });
    return Boolean(hit);
  },
  async findOrgMetaChannel(orgId) {
    return prismaBase.channel.findFirst({
      where: {
        organizationId: orgId,
        provider: { in: ["META_CLOUD_API", "META_INSTAGRAM_LOGIN"] },
      },
      select: { provider: true, config: true },
    });
  },
};

/**
 * A URL Meta só é servida se pertencer à org (mensagem ou avatar).
 * Token: canal da conversa; fallback env da plataforma.
 */
export async function resolveMetaMediaAccess(
  orgId: string,
  mediaUrl: string,
  lookup: MetaMediaLookup = defaultMetaMediaLookup,
  envToken: string | undefined = process.env.META_WHATSAPP_ACCESS_TOKEN,
): Promise<{ token: string } | null> {
  if (!orgId || !isAllowedMetaMediaUrl(mediaUrl)) return null;

  const fromMessage = await lookup.findMessageChannel(orgId, mediaUrl);
  const known =
    Boolean(fromMessage) || (await lookup.findContactAvatar(orgId, mediaUrl));
  if (!known) return null;

  let token = tokenFromChannel(fromMessage);
  if (!token) {
    token = tokenFromChannel(await lookup.findOrgMetaChannel(orgId));
  }
  if (!token) token = envToken?.trim() ?? "";
  if (!token) return null;
  return { token };
}
