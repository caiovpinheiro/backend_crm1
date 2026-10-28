/**
 * Webchat v2 — nota interna do site na conversa (docs/decisoes/webchat-widget.md
 * §9.3 e §9.6): evento importante (`track`) e texto do servidor a servidor
 * viram nota privada (`messageType: "note"`, `isPrivate: true`) — o widget
 * nunca lê nota. Inclui a busca do ticket webchat ativo do contato no canal
 * (sem criar; para criar use `findOrCreateWebchatConversation` de
 * `lib/webchat/inbound.ts`). Roda no contexto de org.
 */
import { noteMessageChange } from "@/lib/cache/message-versions";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { publishNewMessage } from "@/lib/realtime-events";
import { activeConversationOnAccountWhere } from "@/services/conversations";

const log = getLogger("webchat-notes");

/** Autor padrão das notas do site (o mesmo da nota de possível duplicado). */
export const WEBCHAT_SITE_NOTE_SENDER = "Webchat";
/** Teto do texto de uma nota do site. */
export const WEBCHAT_NOTE_MAX_CHARS = 4000;

/** Ticket webchat ativo do contato neste canal (ou `null`). Não cria. */
export async function findActiveWebchatConversation(
  contactId: string,
  channelId: string,
): Promise<{ id: string; number: number } | null> {
  return prisma.conversation.findFirst({
    where: activeConversationOnAccountWhere({ contactId, channel: "webchat", channelId }),
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, number: true },
  });
}

/**
 * Grava a nota privada e publica no SSE do inbox (best-effort). Devolve o
 * id da mensagem. O texto é cortado em `WEBCHAT_NOTE_MAX_CHARS`.
 */
export async function createWebchatSiteNote(args: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  content: string;
  senderName?: string;
}): Promise<string> {
  const content = args.content.slice(0, WEBCHAT_NOTE_MAX_CHARS);
  const senderName = args.senderName ?? WEBCHAT_SITE_NOTE_SENDER;
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: args.conversationId,
      content,
      direction: "out",
      messageType: "note",
      isPrivate: true,
      senderName,
    }),
    select: { id: true, organizationId: true, conversationId: true, externalId: true, createdAt: true },
  });
  void noteMessageChange(saved.organizationId, saved.conversationId, "new", saved.id, saved.externalId);
  try {
    publishNewMessage({
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      direction: "out",
      messageType: "note",
      content,
      senderName,
      timestamp: saved.createdAt,
    });
  } catch (err) {
    log.debug({ err }, "SSE da nota do site falhou (não-fatal)");
  }
  return saved.id;
}
