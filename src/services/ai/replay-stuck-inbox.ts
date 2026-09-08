/**
 * Replay do Agente IA em conversas com inbound sem resposta.
 * Usado pelo cron `/api/cron/replay-stuck-ai` (imagem de prod) e pelo
 * script local `src/scripts/ops-replay-stuck-ai-inbox.ts`.
 */

import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import { ensureInboundAiAttendance } from "@/services/ai/first-attendance";
import { collectUnansweredInboundText } from "@/services/ai/inbound-debounce";
import { maybeReplyAsAIAgent } from "@/services/ai/inbox-handler";
import { cancelActiveContextsForContact } from "@/services/automation-context";

export type ReplayStuckAiOpts = {
  apply: boolean;
  hours?: number;
  limit?: number;
  organizationId?: string | null;
  numbers?: number[];
};

export type ReplayStuckAiItem = {
  number: number;
  contact: string;
  assignee: string;
  lastInboundAt: string | null;
  preview: string;
  status: "listed" | "replied" | "empty" | "failed";
  error?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function replayStuckAiInbox(
  opts: ReplayStuckAiOpts,
): Promise<{
  apply: boolean;
  hours: number;
  items: ReplayStuckAiItem[];
  ok: number;
  skipped: number;
  failed: number;
}> {
  const hours = Math.max(1, opts.hours ?? 24);
  const limit = Math.max(1, opts.limit ?? 80);
  const numbers = opts.numbers ?? [];
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = await prismaBase.conversation.findMany({
    where: {
      status: "OPEN",
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      ...(numbers.length
        ? { number: { in: numbers } }
        : {
            hasHumanReply: false,
            lastMessageDirection: "in",
            lastInboundAt: { gte: since },
            OR: [{ assignedToId: null }, { assignedTo: { is: { type: "AI" } } }],
          }),
    },
    select: {
      id: true,
      number: true,
      organizationId: true,
      contactId: true,
      assignedToId: true,
      lastInboundAt: true,
      channel: true,
      assignedTo: { select: { name: true, type: true } },
      contact: { select: { name: true } },
      channelRef: {
        select: { provider: true, name: true, phoneNumber: true, config: true },
      },
    },
    orderBy: { lastInboundAt: "desc" },
    take: limit * 3,
  });

  const candidates: typeof rows = [];
  for (const row of rows) {
    if (!row.contactId) continue;
    if (isRetiredWhatsAppChannel(row.channelRef)) continue;
    if (numbers.length || row.assignedTo?.type === "AI") {
      candidates.push(row);
      continue;
    }
    const deal = await prismaBase.deal.findFirst({
      where: { contactId: row.contactId, status: "OPEN" },
      select: {
        stage: {
          select: { name: true, slug: true, pipeline: { select: { name: true } } },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
    const pipe = deal?.stage?.pipeline?.name ?? "";
    const stage = deal?.stage?.name ?? "";
    const slug = deal?.stage?.slug ?? "";
    const academic =
      /academ/i.test(pipe) ||
      slug === "lead-de-entrada" ||
      /^lead de entrada$/i.test(stage);
    if (academic) candidates.push(row);
    if (candidates.length >= limit) break;
  }

  const items: ReplayStuckAiItem[] = [];
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of candidates) {
    const preview = await withSystemContext(c.organizationId, () =>
      collectUnansweredInboundText(c.id),
    );
    const base: ReplayStuckAiItem = {
      number: c.number,
      contact: c.contact?.name ?? "?",
      assignee: c.assignedTo?.name ?? "—",
      lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
      preview: preview.slice(0, 80),
      status: "listed",
    };

    if (!opts.apply) {
      items.push(base);
      continue;
    }
    if (!c.contactId) {
      skipped++;
      items.push({ ...base, status: "empty" });
      continue;
    }

    const channel =
      c.channelRef?.provider === "BAILEYS_MD" || /baileys/i.test(c.channel)
        ? "baileys"
        : "meta";
    try {
      const result = await withSystemContext(
        c.organizationId,
        async () => {
          await cancelActiveContextsForContact(c.contactId!);
          await ensureInboundAiAttendance({
            conversationId: c.id,
            contactId: c.contactId!,
          });
          const text = await collectUnansweredInboundText(c.id);
          if (!text.trim()) return { status: "empty" as const };
          await maybeReplyAsAIAgent({
            conversationId: c.id,
            contactId: c.contactId!,
            userMessage: text,
            channel,
          });
          return { status: "replied" as const };
        },
        { actor: { type: "AI", label: "Agente IA", sublabel: "ops-replay" } },
      );
      if (result.status === "empty") {
        skipped++;
        items.push({ ...base, status: "empty" });
      } else {
        ok++;
        items.push({ ...base, status: "replied" });
      }
    } catch (err) {
      failed++;
      items.push({
        ...base,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(1500);
  }

  return { apply: opts.apply, hours, items, ok, skipped, failed };
}
