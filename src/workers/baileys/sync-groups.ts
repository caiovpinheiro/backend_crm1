import type { GroupMetadata, WASocket } from "@whiskeysockets/baileys";

import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import {
  replaceChannelGroups,
  type BaileysGroupSnapshot,
} from "@/services/whatsapp-groups";
import type { BaileysManager } from "./baileys-manager";

function phoneFromJid(jid: string): string | null {
  const [user, server] = jid.split("@");
  if (!user) return null;
  if (server === "s.whatsapp.net" || server === "c.us") {
    const digits = user.replace(/\D/g, "");
    return digits || user;
  }
  return null;
}

function snapshotFromMeta(meta: GroupMetadata): BaileysGroupSnapshot {
  const members = (meta.participants ?? []).map((p) => ({
    jid: p.id,
    phone: phoneFromJid(p.id),
    name: null,
    isAdmin: p.admin === "admin" || p.admin === "superadmin",
    isSuperAdmin: p.admin === "superadmin",
  }));
  return {
    jid: meta.id,
    name: meta.subject ?? "",
    description: meta.desc ?? null,
    ownerJid: meta.owner ?? null,
    members,
  };
}

export async function fetchParticipatingGroups(sock: WASocket): Promise<BaileysGroupSnapshot[]> {
  const map = await sock.groupFetchAllParticipating();
  return Object.values(map).map(snapshotFromMeta);
}

export async function syncChannelGroups(manager: BaileysManager, channelId: string): Promise<number> {
  const session = manager.getSession(channelId);
  const sock = session?.socket;
  if (!sock) {
    throw new Error("Sessão Baileys não está conectada");
  }

  const ch = await prismaBase.channel.findUnique({
    where: { id: channelId },
    select: { organizationId: true, provider: true },
  });
  if (!ch || ch.provider !== "BAILEYS_MD") {
    throw new Error("Canal ausente ou não é BAILEYS_MD");
  }

  const snapshots = await fetchParticipatingGroups(sock);
  const count = await withSystemContext(ch.organizationId, () =>
    replaceChannelGroups(ch.organizationId, channelId, snapshots),
  );
  console.info(`[baileys:${channelId}] ${count} grupo(s) sincronizado(s)`);
  return count;
}
