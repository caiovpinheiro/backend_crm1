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

import { carryContactLastMessage } from "@/lib/conversation-last-message";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { maskPhone } from "@/lib/pii-mask";
import { getLogger } from "@/lib/logger";
import { findExistingContactOnPhone } from "@/services/auto-deals";

const log = getLogger("worker.baileys.lid-resolver");

const channelMaps = new Map<string, Map<string, string>>();

export function isLidJid(jid: string): boolean {
  return jid.endsWith("@lid");
}

/** Devolve `true` quando o par é novo (ou mudou) — quem chama decide se corrige contatos. */
export function registerLidMapping(
  channelId: string,
  lidJid: string,
  phoneJid: string,
): boolean {
  if (!channelMaps.has(channelId)) {
    channelMaps.set(channelId, new Map());
  }
  const lid = lidJid.split("@")[0].split(":")[0];
  const phone = phoneJid.split("@")[0].split(":")[0];
  if (!lid || !phone) return false;
  const map = channelMaps.get(channelId)!;
  if (map.get(lid) === phone) return false;
  map.set(lid, phone);

  persistMapping(channelId, lid, phone).catch((e) =>
    log.warn({ err: e }, "[lid-resolver] persist error"),
  );
  return true;
}

/** `5511…:12@s.whatsapp.net` → `5511…@s.whatsapp.net`; qualquer outra coisa → null. */
function phoneJidOf(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
  const user = jid.split("@")[0].split(":")[0];
  return /^\d{6,}$/.test(user) ? `${user}@s.whatsapp.net` : null;
}

/**
 * Resolve um JID `@lid` para o JID de telefone. Ordem:
 *  1. mapa do canal (agenda sincronizada / mensagens anteriores);
 *  2. `alt` — o telefone que o WhatsApp manda junto na mensagem
 *     (`key.remoteJidAlt` / `key.participantAlt` no Baileys 7);
 *  3. `lookup` — o mapa LID↔telefone da própria sessão do Baileys
 *     (`sock.signalRepository.lidMapping.getPNForLID`).
 * Sem nenhum dos três, `null` (o chamador cai no fallback com o LID).
 * Um par novo é memorizado e o contato criado antes com o LID como
 * telefone é corrigido em segundo plano.
 */
export async function resolveLidJid(
  channelId: string,
  jid: string,
  sources: { alt?: string | null; lookup?: (lid: string) => Promise<string | null | undefined> },
): Promise<string | null> {
  if (!isLidJid(jid)) return jid;
  const known = resolveJid(channelId, jid);
  if (known) return known;

  let phoneJid = phoneJidOf(sources.alt);
  if (!phoneJid && sources.lookup) {
    try {
      phoneJid = phoneJidOf(await sources.lookup(jid));
    } catch (e) {
      log.debug({ err: e instanceof Error ? e.message : e }, "[lid-resolver] lookup do Baileys falhou");
    }
  }
  if (!phoneJid) return null;

  if (registerLidMapping(channelId, jid, phoneJid)) {
    const lid = jid.split("@")[0].split(":")[0];
    fixLidContact(lid, phoneJid.split("@")[0]).catch((e) =>
      log.warn({ lid: maskPhone(lid), err: e }, "[lid-resolver] fixLidContact error"),
    );
  }
  return phoneJid;
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
 * Corrige contatos criados com o LID como telefone (`+<lid>`), para um par
 * LID→telefone. Se já existe contato com o telefone (variantes: com/sem 9º
 * dígito, com/sem +55), as conversas e negócios vão para ele e o contato do
 * LID é apagado; senão, só o telefone é trocado. Devolve quantos corrigiu.
 */
export async function fixLidContact(lid: string, phone: string): Promise<number> {
  const wrongPhone = `+${lid}`;
  const correctPhone = `+${phone}`;
  const contacts = await prisma.contact.findMany({
    where: { phone: wrongPhone },
    select: { id: true },
  });

  let fixed = 0;
  for (const c of contacts) {
    const existing = await findExistingContactOnPhone(correctPhone, c.id);
    if (existing && existing.contactId !== c.id) {
      log.info(
        {
          contactId: c.id,
          lid: maskPhone(lid),
          existingContactId: existing.contactId,
          phone: maskPhone(phone),
        },
        "[lid-resolver] contato com LID já existe com o telefone — merging conversations",
      );
      await prisma.conversation.updateMany({
        where: { contactId: c.id },
        data: { contactId: existing.contactId },
      });
      // A última mensagem (Kanban) acompanha as conversas.
      await carryContactLastMessage({
        fromContactId: c.id,
        toContactId: existing.contactId,
      }).catch(() => {});
      await prisma.deal.updateMany({
        where: { contactId: c.id },
        data: { contactId: existing.contactId },
      });
      await prisma.contact.delete({ where: { id: c.id } }).catch(() => {});
    } else {
      await prisma.contact.update({
        where: { id: c.id },
        data: { phone: correctPhone },
      });
      log.info(
        {
          contactId: c.id,
          wrongPhone: maskPhone(wrongPhone),
          correctPhone: maskPhone(correctPhone),
        },
        "[lid-resolver] corrigido contato",
      );
    }
    fixed++;
  }
  return fixed;
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
    try {
      fixed += await fixLidContact(lid, phone);
    } catch (e) {
      log.warn({ lid: maskPhone(lid), err: e }, "[lid-resolver] fixLidContacts error");
    }
  }
  return fixed;
}
