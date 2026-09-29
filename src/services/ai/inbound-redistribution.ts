/**
 * Segunda passada da distribuição depois de um inbound, com o Agente IA
 * desligado na organização (`ai.newAttendanceEnabled`).
 *
 * Os ingests já distribuem na chegada. Esta passada roda alguns segundos
 * depois, quando salesbot e automações do `message_received` já agiram, e
 * pega a conversa que ficou sem responsável nesse meio-tempo. Mensagens em
 * sequência da mesma conversa viram uma passada só; se alguém respondeu no
 * intervalo, não faz nada.
 */

import { getRequestContext, runWithContext } from "@/lib/request-context";
import { prisma } from "@/lib/prisma";
import { collectUnansweredInboundText } from "@/services/ai/inbound-debounce";

export const INBOUND_REDISTRIBUTION_DELAY_MS = 5000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleInboundRedistribution(args: {
  conversationId: string;
  contactId: string;
}): void {
  const existing = timers.get(args.conversationId);
  if (existing) clearTimeout(existing);

  // Captura o ALS agora: o webhook já terminou quando o timer dispara.
  const ctx = getRequestContext();
  const run = async () => {
    try {
      const pending = await collectUnansweredInboundText(args.conversationId);
      if (!pending.trim()) return;
      const conv = await prisma.conversation.findUnique({
        where: { id: args.conversationId },
        select: { assignedToId: true },
      });
      const { maybeDistributeNewInboundTicket } = await import(
        "@/services/distribution"
      );
      await maybeDistributeNewInboundTicket({
        conversationId: args.conversationId,
        contactId: args.contactId,
        assignedToId: conv?.assignedToId ?? null,
      });
    } catch (err) {
      console.error("[inbound-redistribution] falhou", {
        conversationId: args.conversationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const timer = setTimeout(() => {
    timers.delete(args.conversationId);
    void (ctx ? runWithContext(ctx, run) : run());
  }, INBOUND_REDISTRIBUTION_DELAY_MS);
  timer.unref?.();
  timers.set(args.conversationId, timer);
}
