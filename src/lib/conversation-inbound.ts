import { touchContactLastMessage } from "@/lib/conversation-last-message";
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
 *
 * Grava também `lastMessageAt` (ordem da lista do inbox — ver
 * `lib/conversation-last-message.ts`) na mesma instrução, sem andar para
 * trás: webhook atrasado não rebaixa a conversa. Só é chamado para
 * mensagem de chat do cliente (o recorte da prévia do card).
 *
 * Em seguida grava a última mensagem do CONTATO (`contacts.lastMessageAt` /
 * `lastMessageDirection = 'in'`, Kanban) — instrução própria, também sem
 * andar para trás (`touchContactLastMessage`).
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
      "firstInboundAt" = COALESCE("firstInboundAt", ${args.at}),
      "lastMessageAt" = GREATEST("lastMessageAt", ${args.at})
    WHERE id = ${args.conversationId}
  `;
  await touchContactLastMessage({
    conversationId: args.conversationId,
    at: args.at,
    direction: "in",
    tx: args.tx,
  });
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
