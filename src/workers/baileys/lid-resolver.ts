/**
 * Resolves WhatsApp LID (Linked ID) JIDs to phone-based JIDs.
 *
 * WhatsApp is transitioning from phone-based JIDs (5535999821871@s.whatsapp.net)
 * to LIDs (139620998221871@lid). This module maintains a per-channel mapping
 * populated from Baileys contacts events so we can match incoming LID messages
 * to existing CRM contacts by phone number.
 *
 * Mappings are persisted to the database (baileys_auth_keys, keyType="lid-map")
 * so they survive worker restarts.
 */

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { maskPhone } from "@/lib/pii-mask";
import { getLogger } from "@/lib/logger";

const log = getLogger("worker.baileys.lid-resolver");

const channelMaps = new Map<string, Map<string, string>>();

export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

export function registerLidMapping(
  channelId: string,
  lidJid: string,
  phoneJid: string,
) {
  if (!channelMaps.has(channelId)) {
    channelMaps.set(channelId, new Map());
  }
  const lid = lidJid.split("@")[0].split(":")[0];
  const phone = phoneJid.split("@")[0].split(":")[0];
  if (lid && phone) {
    const map = channelMaps.get(channelId)!;
    const existing = map.get(lid);
    if (existing === phone) return;
    map.set(lid, phone);

    persistMapping(channelId, lid, phone).catch((e) =>
      log.warn({ err: e }, "[lid-resolver] persist error"),
    );
  }
}

export function resolveJid(channelId: string, jid: string): string | null {
  if (!isLidJid(jid)) return jid;

  const lid = jid.split("@")[0].split(":")[0];
  const phone = channelMaps.get(channelId)?.get(lid);
  if (phone) {
    return `${phone}@s.whatsapp.net`;
  }
  return null;
}

export function clearChannelMap(channelId: string) {
  channelMaps.delete(channelId);
}

export function getMapSize(channelId: string): number {
  return channelMaps.get(channelId)?.size ?? 0;
}

/**
 * Load persisted LID→phone mappings from the database for a given channel.
 * Should be called when a session starts.
 */
export async function loadPersistedMappings(channelId: string): Promise<number> {
  try {
    const rows = await prisma.baileysAuthKey.findMany({
      where: { channelId, keyType: "lid-map" },
      select: { keyId: true, value: true },
    });

    if (rows.length === 0) return 0;

    if (!channelMaps.has(channelId)) {
      channelMaps.set(channelId, new Map());
    }
    const map = channelMaps.get(channelId)!;
    for (const row of rows) {
      const val = row.value as { phone?: string };
      if (val.phone) {
        map.set(row.keyId, val.phone);
      }
    }
    return rows.length;
  } catch (e) {
    log.warn({ err: e }, "[lid-resolver] loadPersistedMappings error");
    return 0;
  }
}

async function persistMapping(channelId: string, lid: string, phone: string) {
  const id = `${channelId}:lid-map:${lid}`;
  const channelRow = await prismaBase.channel.findUnique({
    where: { id: channelId },
    select: { organizationId: true },
  });
  const organizationId = channelRow?.organizationId ?? "";
  await prisma.baileysAuthKey.upsert({
    where: { id },
    create: {
      id,
      organizationId,
      channelId,
      keyType: "lid-map",
      keyId: lid,
      value: { phone },
    },
    update: {
      value: { phone },
    },
  });
}

/**
 * Fix contacts whose phone is actually a LID (wrong number).
 * Called after contacts sync populates the LID map.
 */
export async function fixLidContacts(channelId: string): Promise<number> {
  const map = channelMaps.get(channelId);
  if (!map || map.size === 0) return 0;

  let fixed = 0;
  for (const [lid, phone] of map) {
    const wrongPhone = `+${lid}`;
    const correctPhone = `+${phone}`;

    try {
      const contacts = await prisma.contact.findMany({
        where: { phone: wrongPhone },
        select: { id: true },
      });

      for (const c of contacts) {
        const existing = await prisma.contact.findFirst({
          where: { phone: correctPhone },
          select: { id: true },
        });

        if (existing && existing.id !== c.id) {
          log.info(
            {
              contactId: c.id,
              lid: maskPhone(lid),
              existingContactId: existing.id,
              phone: maskPhone(phone),
            },
            "[lid-resolver] contato com LID já existe com o telefone — merging conversations",
          );
          await prisma.conversation.updateMany({
            where: { contactId: c.id },
            data: { contactId: existing.id },
          });
          await prisma.deal.updateMany({
            where: { contactId: c.id },
            data: { contactId: existing.id },
          });
          await prisma.contact.delete({ where: { id: c.id } }).catch(() => {});
          fixed++;
        } else {
          await prisma.contact.update({
            where: { id: c.id },
            data: { phone: correctPhone },
          });
          fixed++;
          log.info(
            {
              contactId: c.id,
              wrongPhone: maskPhone(wrongPhone),
              correctPhone: maskPhone(correctPhone),
            },
            "[lid-resolver] corrigido contato",
          );
        }
      }
    } catch (e) {
      log.warn({ lid: maskPhone(lid), err: e }, "[lid-resolver] fixLidContacts error");
    }
  }
  return fixed;
}
