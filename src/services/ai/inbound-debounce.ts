/**
 * Utilitários de inbound do Agente IA compartilhados com o `turn-manager`:
 *   - `claimInboundMessageForAi` (claim Redis por messageId)
 *   - `collectUnansweredInboundText` (batch de inbound sem resposta)
 *   - `cancelAiReplyDebounce` (humano assumiu: invalida os turnos abertos)
 *   - `kickAiAfterInboxAssign` (conversa atribuída à IA pelo inbox)
 */

import { cache } from "@/lib/cache";
import { getRequestContext, runWithContext } from "@/lib/request-context";
import { prisma } from "@/lib/prisma";

const MSG_CLAIM_TTL_SEC = 600;

/** Teto temporal do lote de inbound não respondido (minutos). */
export const DEFAULT_INBOUND_BATCH_WINDOW_MINUTES = 15;

function logAi(event: string, payload: Record<string, unknown>) {
  console.info(
    "[ai-attend]",
    JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
}

/**
 * Claim de mensagem inbound (webhook repetido / multi-pod).
 * Sem messageId, sempre permite (texto-only paths).
 */
export async function claimInboundMessageForAi(
  messageId: string | null | undefined,
): Promise<boolean> {
  if (!messageId) return true;
  const ok = await cache.tryClaim(`ai:msg-claim:${messageId}`, MSG_CLAIM_TTL_SEC);
  if (!ok) {
    logAi("msg_claim_blocked", { messageId });
  }
  return ok;
}

/**
 * Humano assumiu / enviou mensagem: invalida os `ConversationTurn` ainda
 * acumulando da conversa, para a IA não responder por cima.
 */
export function cancelAiReplyDebounce(
  conversationId: string,
  reason: string,
): void {
  // Import dinâmico: turn-manager importa este módulo (claim + coletor de
  // texto), então o estático fecharia ciclo.
  void import("@/services/ai/turn-manager")
    .then(({ invalidateOpenTurns }) =>
      invalidateOpenTurns(conversationId, reason),
    )
    .catch((err) => {
      console.error("[ai-attend] invalidateOpenTurns falhou", {
        conversationId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  logAi("debounce_cancelled", { conversationId, reason });
}

/**
 * Depois de atribuir/transferir no inbox para um User type=AI: responde
 * inbound sem resposta, ou manda a saudação se o contato ainda não falou.
 * Fire-and-forget — o HTTP do assign não espera o LLM.
 */
export function kickAiAfterInboxAssign(args: {
  conversationId: string;
  contactId: string;
}): void {
  // Captura o ALS agora: o assign HTTP já pode ter encerrado quando o
  // primeiro `await` abaixo roda, e o prisma scoped explode sem org.
  const ctx = getRequestContext();
  void (async () => {
    const run = async () => {
      try {
        const text = await collectUnansweredInboundText(args.conversationId);
        if (text.trim()) {
          const { onInboundMessageForAi } = await import(
            "@/services/ai/turn-manager"
          );
          await onInboundMessageForAi({
            conversationId: args.conversationId,
            contactId: args.contactId,
            userMessage: text,
            channel: "meta",
          });
          return;
        }
        const conv = await prisma.conversation.findUnique({
          where: { id: args.conversationId },
          select: { assignedToId: true },
        });
        if (!conv?.assignedToId) return;
        const { triggerAgentOpeningForContact } = await import(
          "@/services/ai/piloting-actions"
        );
        await triggerAgentOpeningForContact({
          contactId: args.contactId,
          agentUserId: conv.assignedToId,
          channel: "meta",
        });
      } catch (e) {
        console.error("[ai-attend] kickAiAfterInboxAssign failed", e);
      }
    };
    if (ctx) {
      await runWithContext(ctx, run);
      return;
    }
    await run();
  })();
}

/**
 * Concatena mensagens inbound do cliente desde a última outbound
 * (humano/bot), em ordem cronológica.
 *
 * Tem TETO TEMPORAL. Sem ele um "oi" às 16:43 arrastava mensagens de 16:13
 * para o mesmo turno: o agente respondia perguntas velhas e um lote antigo
 * casava com palavra-chave, disparando transferência indevida. A janela é
 * ancorada na mensagem mais NOVA do lote (não em `now`), porque o worker
 * pode processar o turno minutos depois de o cliente escrever.
 */
export async function collectUnansweredInboundText(
  conversationId: string,
  opts?: { windowMinutes?: number },
): Promise<string> {
  const windowMinutes =
    opts?.windowMinutes ?? DEFAULT_INBOUND_BATCH_WINDOW_MINUTES;

  const lastOut = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: "out",
      isPrivate: false,
      messageType: { not: "note" },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  const inbound = await prisma.message.findMany({
    where: {
      conversationId,
      direction: "in",
      ...(lastOut ? { createdAt: { gt: lastOut.createdAt } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 30,
    select: {
      content: true,
      authorType: true,
      messageType: true,
      createdAt: true,
    },
  });

  const fromClient = inbound.filter(
    (m) =>
      m.authorType !== "bot" &&
      m.authorType !== "system" &&
      m.messageType !== "note" &&
      (m.content ?? "").trim().length > 0,
  );

  const newest = fromClient[fromClient.length - 1]?.createdAt;
  const cutoff =
    windowMinutes > 0 && newest
      ? newest.getTime() - windowMinutes * 60_000
      : null;

  const parts: string[] = [];
  for (const m of fromClient) {
    if (cutoff !== null && m.createdAt.getTime() < cutoff) continue;
    parts.push((m.content ?? "").trim());
  }
  return parts.join("\n");
}
