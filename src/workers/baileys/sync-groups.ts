import type { GroupMetadata, WASocket } from "@whiskeysockets/baileys";
import { getBinaryNodeChild, getBinaryNodeChildren, type BinaryNode } from "@whiskeysockets/baileys";

import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import {
  upsertChannelGroupSnapshots,
  type BaileysGroupSnapshot,
} from "@/services/whatsapp-groups";
import type { BaileysManager } from "./baileys-manager";
import { getLogger } from "@/lib/logger";

const log = getLogger("worker.baileys.sync-groups");

const EMPTY_RETRY_MS = 4_000;
const SUBGROUPS_TIMEOUT_MS = 12_000;
/** Sem flag de comunidade, só os menores jids são sondados. */
const UNFLAGGED_PROBE_LIMIT = 5;

type LinkedGroupNode = {
  id?: string;
  subject?: string;
  owner?: string;
  size?: number;
};

type QuerySocket = WASocket & {
  query?: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  communityFetchAllParticipating?: () => Promise<Record<string, GroupMetadata>>;
};

function phoneFromJid(jid: string | undefined): string | null {
  if (!jid) return null;
  const [user, server] = jid.split("@");
  if (!user) return null;
  if (server === "s.whatsapp.net" || server === "c.us") {
    const digits = user.replace(/\D/g, "");
    return digits || null;
  }
  return null;
}

function asGroupJid(id: string | undefined): string | null {
  if (!id) return null;
  const user = id.split("@")[0]?.trim();
  if (!user) return null;
  return `${user}@g.us`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function snapshotFromMeta(meta: GroupMetadata): BaileysGroupSnapshot {
  const members = [];
  for (const p of meta.participants ?? []) {
    const jid = p.id || p.phoneNumber || p.lid;
    if (!jid) continue;
    const phoneSource =
      p.phoneNumber && !p.phoneNumber.endsWith("@lid") ? p.phoneNumber : p.id;
    members.push({
      jid,
      phone: phoneFromJid(phoneSource),
      name: p.name || p.notify || null,
      isAdmin: p.admin === "admin" || p.admin === "superadmin",
      isSuperAdmin: p.admin === "superadmin",
    });
  }
  const size =
    typeof meta.size === "number" && Number.isFinite(meta.size) ? meta.size : members.length;
  return {
    jid: asGroupJid(meta.id) ?? meta.id,
    name: meta.subject ?? "",
    description: meta.desc ?? null,
    ownerJid: meta.owner ?? null,
    size,
    members,
  };
}

function remember(
  byId: Map<string, GroupMetadata>,
  meta: GroupMetadata | undefined,
  onMeta?: (meta: GroupMetadata) => void,
): void {
  const jid = asGroupJid(meta?.id);
  if (!meta || !jid) return;
  const normalized = jid === meta.id ? meta : { ...meta, id: jid };
  byId.set(jid, normalized);
  onMeta?.(normalized);
}

async function querySubGroups(sock: QuerySocket, communityJid: string): Promise<LinkedGroupNode[]> {
  if (!sock.query) return [];
  const result = await sock.query(
    {
      tag: "iq",
      attrs: { type: "get", xmlns: "w:g2", to: communityJid },
      content: [{ tag: "sub_groups", attrs: {} }],
    },
    SUBGROUPS_TIMEOUT_MS,
  );
  const sub = getBinaryNodeChild(result, "sub_groups");
  if (!sub) return [];
  return getBinaryNodeChildren(sub, "group").map((node) => ({
    id: node.attrs.id || node.attrs.jid,
    subject: node.attrs.subject || "",
    owner: node.attrs.creator,
    size: node.attrs.size ? Number(node.attrs.size) : undefined,
  }));
}

function stubFromLinked(jid: string, hint: LinkedGroupNode): GroupMetadata {
  return {
    id: jid,
    subject: hint.subject || "",
    owner: hint.owner,
    participants: [],
    size: hint.size,
  };
}

async function loadParticipating(
  sock: WASocket,
  onMeta?: (meta: GroupMetadata) => void,
): Promise<Map<string, GroupMetadata>> {
  const byId = new Map<string, GroupMetadata>();
  const map = await sock.groupFetchAllParticipating();
  for (const meta of Object.values(map)) remember(byId, meta, onMeta);

  const ext = sock as QuerySocket;
  if (ext.communityFetchAllParticipating) {
    try {
      const communities = await ext.communityFetchAllParticipating();
      for (const meta of Object.values(communities ?? {})) remember(byId, meta, onMeta);
    } catch (err) {
      log.warn({ err: errText(err) }, "[baileys] comunidades não listadas");
    }
  }

  const parents = new Set<string>();
  const addParent = (meta: GroupMetadata) => {
    if (meta.isCommunity) parents.add(meta.id);
    const parent = asGroupJid(meta.linkedParent);
    if (parent) parents.add(parent);
  };
  for (const meta of byId.values()) addParent(meta);

  const speculative: string[] = [];
  if (parents.size === 0) {
    const candidates = [...byId.values()]
      .sort((a, b) => (a.size ?? a.participants.length) - (b.size ?? b.participants.length))
      .slice(0, UNFLAGGED_PROBE_LIMIT);
    for (const meta of candidates) speculative.push(meta.id);
  }

  const absorb = async (parent: string) => {
    try {
      const linked = await querySubGroups(ext, parent);
      for (const group of linked) {
        const jid = asGroupJid(group.id);
        if (!jid || byId.has(jid)) continue;
        remember(byId, stubFromLinked(jid, group), onMeta);
      }
    } catch (err) {
      log.warn({ jid: parent, err: errText(err) }, "[baileys] subgrupos da comunidade falharam");
    }
  };

  for (const parent of parents) await absorb(parent);
  for (const jid of speculative) {
    if (!parents.has(jid)) await absorb(jid);
  }

  return byId;
}

export async function fetchParticipatingGroups(
  sock: WASocket,
  onMeta?: (meta: GroupMetadata) => void,
): Promise<BaileysGroupSnapshot[]> {
  let byId = await loadParticipating(sock, onMeta);
  if (byId.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, EMPTY_RETRY_MS));
    byId = await loadParticipating(sock, onMeta);
  }
  return [...byId.values()].map(snapshotFromMeta);
}

export async function syncChannelGroups(manager: BaileysManager, channelId: string): Promise<number> {
  const session = manager.getSession(channelId);
  const sock = session?.socket;
  if (!session || !sock) {
    throw new Error("Sessão Baileys não está conectada");
  }

  const ch = await prismaBase.channel.findUnique({
    where: { id: channelId },
    select: { organizationId: true, provider: true },
  });
  if (!ch || ch.provider !== "BAILEYS_MD") {
    throw new Error("Canal ausente ou não é BAILEYS_MD");
  }

  const fetched = await fetchParticipatingGroups(sock, (meta) => session.rememberGroup(meta));
  const byJid = new Map<string, BaileysGroupSnapshot>();
  for (const snap of fetched) {
    if (snap.jid.endsWith("@g.us")) byJid.set(snap.jid, snap);
  }
  for (const extra of session.discoveredGroupSnapshots()) {
    if (!byJid.has(extra.jid)) byJid.set(extra.jid, extra);
  }
  const snapshots = [...byJid.values()];
  if (snapshots.length === 0) {
    log.warn({ channelId }, "[baileys] sincronização sem grupos — lista atual preservada");
    return 0;
  }

  // Só acrescenta. Uma resposta incompleta não apaga grupo que já estava na lista.
  const count = await withSystemContext(ch.organizationId, async () => {
    await upsertChannelGroupSnapshots(ch.organizationId, channelId, snapshots);
    return snapshots.length;
  });
  log.info({ channelId, count }, "[baileys] grupo(s) sincronizado(s)");
  return count;
}
