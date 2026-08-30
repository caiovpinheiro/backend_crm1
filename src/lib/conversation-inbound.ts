import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const log = getLogger("conversation-inbound");

type InboundWriter = {
  $executeRaw: typeof prisma.$executeRaw;
};

/**
 * Único escritor de `lastInboundAt` / `firstInboundAt` no ingest inbound.
 *
 * `firstInboundAt` só grava se ainda for NULL (primeira inbound deste
 * conversationId — semântica A). COALESCE no SQL, sem read-then-write.
 *
 * Não chamar em findOrCreate / ensure / reopen: ticket sem inbound
 * nasce NULL de propósito.
 */
export async function touchInbound(args: {
  conversationId: string;
  at: Date;
  tx?: InboundWriter;
}): Promise<void> {
  const db = args.tx ?? prisma;
  await db.$executeRaw`
    UPDATE conversations
    SET
      "lastInboundAt" = ${args.at},
      "firstInboundAt" = COALESCE("firstInboundAt", ${args.at})
    WHERE id = ${args.conversationId}
  `;
}

export function warnTouchInboundFailed(
  err: unknown,
  ctx: { conversationId: string; channel: string | null | undefined },
): void {
  log.warn(
    { conversationId: ctx.conversationId, channel: ctx.channel ?? null, err },
    "touchInbound failed",
  );
}
