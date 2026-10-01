/**
 * Encerra o burst de tickets reabertos após reconnect/register de um
 * número Meta (ex.: CSV Atendimento). Usado pelo cron
 * `/api/cron/halt-inbound-burst` e pelo script `scripts/ops-halt-inbound-burst.mjs`.
 */

import { prismaBase } from "@/lib/prisma-base";
import { invalidateInboxTabCounts } from "@/lib/cache/keys";
import { withSystemContext } from "@/lib/webhook-context";
import { cancelAiReplyDebounce } from "@/services/ai/inbound-debounce";
import { RETIRED_CSV_ATENDIMENTO_PHONE_NUMBER_ID } from "@/lib/channels/retired-whatsapp";

export const DEFAULT_BURST_PHONE_NUMBER_ID =
  RETIRED_CSV_ATENDIMENTO_PHONE_NUMBER_ID;
const HANDOFF_SNIPPET = "já pedi para a equipe";
const CHUNK = 50;

export type HaltInboundBurstOpts = {
  apply: boolean;
  hours?: number;
  phoneNumberId?: string;
  organizationId?: string | null;
  /** Se true, só encerra tickets cuja última msg contém o aviso de fila da IA. */
  requireHandoffPreview?: boolean;
};

export type HaltInboundBurstItem = {
  id: string;
  number: number;
  contact: string;
  preview: string | null;
};

export async function haltInboundBurst(opts: HaltInboundBurstOpts): Promise<{
  apply: boolean;
  hours: number;
  phoneNumberId: string;
  channels: { id: string; name: string; status: string }[];
  matched: number;
  resolved: number;
  items: HaltInboundBurstItem[];
}> {
  const hours = Math.max(1, opts.hours ?? 6);
  const phoneNumberId = (opts.phoneNumberId ?? DEFAULT_BURST_PHONE_NUMBER_ID).trim();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const requireHandoff = opts.requireHandoffPreview !== false;

  const channels = await prismaBase.channel.findMany({
    where: {
      provider: "META_CLOUD_API",
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      config: { path: ["phoneNumberId"], equals: phoneNumberId },
    },
    select: { id: true, name: true, status: true, organizationId: true },
  });

  if (channels.length === 0) {
    return {
      apply: opts.apply,
      hours,
      phoneNumberId,
      channels: [],
      matched: 0,
      resolved: 0,
      items: [],
    };
  }

  const channelIds = channels.map((c) => c.id);
  const convs = await prismaBase.conversation.findMany({
    where: {
      channelId: { in: channelIds },
      status: "OPEN",
      OR: [{ lastInboundAt: { gte: since } }, { updatedAt: { gte: since } }],
    },
    select: {
      id: true,
      number: true,
      organizationId: true,
      contact: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 5000,
  });

  const selected: typeof convs = [];
  const previewById = new Map<string, string | null>();
  for (const c of convs) {
    const msg = await prismaBase.message.findFirst({
      where: { conversationId: c.id },
      orderBy: { createdAt: "desc" },
      select: { content: true },
    });
    const preview = msg?.content ?? "";
    previewById.set(c.id, preview);
    if (!requireHandoff || preview.toLowerCase().includes(HANDOFF_SNIPPET)) {
      selected.push(c);
    }
  }

  const items: HaltInboundBurstItem[] = selected.map((c) => ({
    id: c.id,
    number: c.number,
    contact: c.contact?.name ?? "?",
    preview: (previewById.get(c.id) ?? "").slice(0, 80) || null,
  }));

  if (!opts.apply) {
    return {
      apply: false,
      hours,
      phoneNumberId,
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
      })),
      matched: items.length,
      resolved: 0,
      items: items.slice(0, 40),
    };
  }

  let resolved = 0;
  const orgIds = [...new Set(selected.map((c) => c.organizationId))];
  for (const orgId of orgIds) {
    const ids = selected.filter((c) => c.organizationId === orgId).map((c) => c.id);
    await withSystemContext(orgId, async () => {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        for (const id of chunk) cancelAiReplyDebounce(id, "halt-inbound-burst");
        const result = await prismaBase.conversation.updateMany({
          where: { id: { in: chunk }, status: { not: "RESOLVED" } },
          data: {
            status: "RESOLVED",
            closedAt: new Date(),
            hasError: false,
            assignedToId: null,
          },
        });
        resolved += result.count;
      }
      await invalidateInboxTabCounts(orgId);
    });
  }

  return {
    apply: true,
    hours,
    phoneNumberId,
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
    })),
    matched: items.length,
    resolved,
    items: items.slice(0, 40),
  };
}
