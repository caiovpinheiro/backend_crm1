/**
 * Mensagens interativas da v2: botões, listas, fallback numerado (SPEC 3.12).
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import type { V2Action, V2PendingInteractiveOption } from "@/lib/ai-v2/types";

export type V2InteractiveFormat = "buttons" | "list" | "numbered_text";

export function decideInteractiveFormat(options: V2PendingInteractiveOption[], sessionWindowOpen: boolean): V2InteractiveFormat {
  if (!sessionWindowOpen) return "numbered_text";
  if (options.length <= 3) return "buttons";
  if (options.length <= 10) return "list";
  return "numbered_text";
}

export function buildInteractiveText(options: V2PendingInteractiveOption[]): string {
  return options
    .map((opt, i) => `${i + 1}. ${opt.label}`)
    .join("\n");
}

function truncateLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

export function normalizeInteractiveOptions(
  options: V2PendingInteractiveOption[],
): V2PendingInteractiveOption[] {
  const seen = new Set<string>();
  const out: V2PendingInteractiveOption[] = [];
  for (const opt of options) {
    const label = truncateLabel(opt.label, 20);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ ...opt, label });
  }
  return out.slice(0, 10);
}

export async function persistPendingInteractive(args: {
  organizationId: string;
  conversationId: string;
  turnId?: string;
  messageId?: string;
  validUntil: Date;
  options: V2PendingInteractiveOption[];
}): Promise<string> {
  const row = await (prisma as unknown as {
    aIV2PendingInteractive: {
      create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    };
  }).aIV2PendingInteractive.create({
    data: {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      turnId: args.turnId ?? null,
      messageId: args.messageId ?? null,
      validUntil: args.validUntil,
      options: args.options as unknown as Record<string, unknown>,
    },
  });
  return row.id;
}

export async function resolvePendingInteractive(args: {
  organizationId: string;
  conversationId: string;
  buttonId?: string;
  textReply?: string;
}): Promise<{ action: V2Action | null; expired: boolean; notFound: boolean }> {
  const rows = await (prisma as unknown as {
    aIV2PendingInteractive: {
      findMany: (args: {
        where: { organizationId: string; conversationId: string; resolvedAt: null };
        orderBy: { createdAt: "desc" };
        take: number;
      }) => Promise<
        Array<{
          id: string;
          validUntil: Date;
          options: unknown;
        }>
      >;
    };
  }).aIV2PendingInteractive.findMany({
    where: {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      resolvedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  if (rows.length === 0) return { action: null, expired: false, notFound: true };

  const now = new Date();
  for (const row of rows) {
    if (row.validUntil < now) continue;
    const options = (row.options ?? []) as V2PendingInteractiveOption[];

    if (args.buttonId) {
      const match = options.find((o) => o.id === args.buttonId);
      if (match) {
        await markResolved(row.id, args.buttonId);
        return { action: match.target, expired: false, notFound: false };
      }
    }

    if (args.textReply) {
      const normalized = args.textReply.toLowerCase().trim();
      // Resposta por número
      const numberMatch = normalized.match(/^\d+$/);
      if (numberMatch) {
        const idx = Number.parseInt(normalized, 10) - 1;
        if (idx >= 0 && idx < options.length) {
          await markResolved(row.id, options[idx].id);
          return { action: options[idx].target, expired: false, notFound: false };
        }
      }
      // Resposta por rótulo
      const labelMatch = options.find((o) => o.label.toLowerCase().trim() === normalized);
      if (labelMatch) {
        await markResolved(row.id, labelMatch.id);
        return { action: labelMatch.target, expired: false, notFound: false };
      }
    }
  }

  return { action: null, expired: true, notFound: true };
}

async function markResolved(id: string, resolvedTarget: string): Promise<void> {
  await (prisma as unknown as {
    aIV2PendingInteractive: {
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<void>;
    };
  }).aIV2PendingInteractive.update({
    where: { id },
    data: {
      resolvedAt: new Date(),
      resolvedTarget,
    },
  });
}
