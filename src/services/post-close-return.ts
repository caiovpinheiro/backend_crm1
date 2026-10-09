/**
 * Regra "a IA só entra quando o atendimento é dela", parte 1: o que fazer
 * com a mensagem que chega logo depois de uma conversa encerrada.
 *
 * - Cortesia ("ok", "obrigado", 👍) nos N minutos após o encerramento, de
 *   quem quer que tenha encerrado (pessoa, fluxo ou agente): fica registrada
 *   na conversa encerrada. Não abre ticket, não chama a IA, não dispara
 *   fluxo. Antes virava ticket novo, herdava o agente de IA do contato e o
 *   agente respondia "posso ajudar em mais alguma coisa?" a um "obrigado".
 * - Mensagem com conteúdo nos M minutos após um atendimento feito por uma
 *   pessoa: o ticket novo não herda o agente de IA — vai para a equipe
 *   (distribuição), que tem o contexto.
 *
 * Janelas por organização: `conversation.postCloseCourtesyMinutes` (padrão
 * 15) e `conversation.postCloseReturnToHumanMinutes` (padrão 60); "0"
 * desliga. Independe do "Protocolo de encerramento". Nenhum domínio de
 * cliente.
 */

import { isIdleClosingText, messageHasMedia } from "@/lib/ai-agents/tabulation-classify-policy";
import { getLogger } from "@/lib/logger";
import { getOrgSettingOrDefault } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";

const log = getLogger("post-close-return");

export const POST_CLOSE_COURTESY_MINUTES_KEY = "conversation.postCloseCourtesyMinutes";
export const POST_CLOSE_RETURN_TO_HUMAN_MINUTES_KEY = "conversation.postCloseReturnToHumanMinutes";
export const POST_CLOSE_COURTESY_MINUTES_DEFAULT = 15;
export const POST_CLOSE_RETURN_TO_HUMAN_MINUTES_DEFAULT = 60;

export type RecentResolvedConversation = {
  id: string;
  organizationId: string;
  channelId: string | null;
  closedAt: Date | null;
  hasHumanReply: boolean;
};

export type PostCloseInbound =
  | { kind: "courtesy"; conversation: RecentResolvedConversation; windowMinutes: number }
  | { kind: "return_to_human"; conversation: RecentResolvedConversation; windowMinutes: number };

/** Minutos de uma configuração da org; inválido cai no padrão, negativo vira 0. */
export async function postCloseWindowMinutes(key: string, fallback: number): Promise<number> {
  const raw = await getOrgSettingOrDefault(key, String(fallback));
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, n);
}

/** Só texto curto de cortesia: sem mídia, sem pergunta, sem pedido. */
export function isCourtesyOnlyInbound(text: string | null | undefined, messageType: string | null | undefined): boolean {
  const content = (text ?? "").trim();
  if (!content) return false;
  if (messageHasMedia({ direction: "in", content: "", messageType: messageType ?? "" })) return false;
  return isIdleClosingText(content);
}

export async function findRecentResolvedConversation(args: {
  contactId: string;
  channel: string;
  channelId: string | null;
  withinMs: number;
  now?: Date;
}): Promise<RecentResolvedConversation | null> {
  const now = args.now ?? new Date();
  const since = new Date(now.getTime() - args.withinMs);
  const row = await prisma.conversation.findFirst({
    where: {
      contactId: args.contactId,
      channel: args.channel,
      status: "RESOLVED",
      closedAt: { gte: since },
      ...(args.channelId ? { channelId: args.channelId } : {}),
    },
    orderBy: { closedAt: "desc" },
    select: { id: true, organizationId: true, channelId: true, closedAt: true, hasHumanReply: true },
  });
  return row ?? null;
}

/**
 * Decide, antes de abrir um ticket novo, se a mensagem pertence ao
 * atendimento que acabou de encerrar. Nunca lança: na dúvida, segue o
 * caminho normal.
 */
export async function resolvePostCloseInbound(args: {
  contactId: string;
  channel: string;
  channelId: string | null;
  text: string | null | undefined;
  messageType: string | null | undefined;
  now?: Date;
}): Promise<PostCloseInbound | null> {
  try {
    const courtesyMinutes = await postCloseWindowMinutes(POST_CLOSE_COURTESY_MINUTES_KEY, POST_CLOSE_COURTESY_MINUTES_DEFAULT);
    if (courtesyMinutes > 0 && isCourtesyOnlyInbound(args.text, args.messageType)) {
      const recent = await findRecentResolvedConversation({
        contactId: args.contactId,
        channel: args.channel,
        channelId: args.channelId,
        withinMs: courtesyMinutes * 60_000,
        now: args.now,
      });
      if (recent) {
        log.info(
          { contactId: args.contactId, conversationId: recent.id, windowMinutes: courtesyMinutes },
          "[pós-encerramento] cortesia fica na conversa encerrada; sem ticket novo e sem IA",
        );
        return { kind: "courtesy", conversation: recent, windowMinutes: courtesyMinutes };
      }
    }
    const returnMinutes = await postCloseWindowMinutes(POST_CLOSE_RETURN_TO_HUMAN_MINUTES_KEY, POST_CLOSE_RETURN_TO_HUMAN_MINUTES_DEFAULT);
    if (returnMinutes > 0) {
      const recent = await findRecentResolvedConversation({
        contactId: args.contactId,
        channel: args.channel,
        channelId: args.channelId,
        withinMs: returnMinutes * 60_000,
        now: args.now,
      });
      if (recent?.hasHumanReply) {
        log.info(
          { contactId: args.contactId, conversationId: recent.id, windowMinutes: returnMinutes },
          "[pós-encerramento] último atendimento foi de uma pessoa; ticket novo vai para a equipe, não para a IA",
        );
        return { kind: "return_to_human", conversation: recent, windowMinutes: returnMinutes };
      }
    }
    return null;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "[pós-encerramento] decisão falhou; caminho normal");
    return null;
  }
}
