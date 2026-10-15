/**
 * Envio de mensagens Facebook Messenger / Instagram Direct via Meta Graph.
 *
 * Analogo a `send-whatsapp.ts` — devolve `{ externalId, failed, error }` e
 * atualiza `Message.sendStatus/sendError` em caso de falha imediata.
 */
import { messagingClientFromConfig } from "@/lib/meta-messaging/client";
import { formatMetaSendError } from "@/lib/meta-whatsapp/client";
import { prisma } from "@/lib/prisma";
import { logMessageFailed } from "@/services/activity-log";
import { noteMessageRowChange } from "@/lib/cache/message-versions";

type Platform = "messenger" | "instagram";

type ChannelInfo = {
  id: string;
  config: unknown;
} | null | undefined;

type SendOpts = {
  conversationId: string;
  contactId: string;
  channelRef: ChannelInfo;
  content: string;
  messageId: string;
  platform: Platform;
};

type SendResult = {
  externalId: string | null;
  failed: boolean;
  error: string | null;
};

async function markFailed(opts: SendOpts, error: string): Promise<SendResult> {
  const failedRow = await prisma.message
    .update({
      where: { id: opts.messageId },
      data: { sendStatus: "failed", sendError: error },
    })
    .catch(() => null);
  void noteMessageRowChange(failedRow, "upd");
  void (async () => {
    const contact = await prisma.contact
      .findUnique({
        where: { id: opts.contactId },
        select: { name: true, phone: true },
      })
      .catch(() => null);
    await logMessageFailed({
      messageId: opts.messageId,
      conversationId: opts.conversationId,
      contactId: opts.contactId,
      contactLabel: contact?.name ?? null,
      contactSublabel: contact?.phone ?? null,
      error,
      source: "api",
      channel: opts.platform === "instagram" ? "Instagram" : "Messenger",
    });
  })();
  return { externalId: null, failed: true, error };
}

export async function sendMessengerOrInstagramText(opts: SendOpts): Promise<SendResult> {
  if (!opts.channelRef?.config) {
    return markFailed(opts, "Canal sem configuracao.");
  }
  const client = messagingClientFromConfig(
    opts.channelRef.config as Record<string, unknown>,
  );
  if (!client.configured) {
    return markFailed(opts, "Canal Meta Messaging nao configurado (accessToken/pageId ausente).");
  }

  const field = opts.platform === "instagram" ? "instagramIgsid" : "messengerPsid";
  const contact = await prisma.contact.findUnique({
    where: { id: opts.contactId },
    select: { messengerPsid: true, instagramIgsid: true },
  });
  const recipientId =
    field === "instagramIgsid" ? contact?.instagramIgsid : contact?.messengerPsid;
  if (!recipientId) {
    return markFailed(
      opts,
      opts.platform === "instagram"
        ? "Contato sem IGSID (Instagram) — a conversa precisa ter sido iniciada pelo cliente."
        : "Contato sem PSID (Messenger) — a conversa precisa ter sido iniciada pelo cliente.",
    );
  }

  try {
    const result = await client.sendText(recipientId, opts.content);
    const externalId = result.message_id ?? null;
    if (externalId) {
      const sentRow = await prisma.message.update({
        where: { id: opts.messageId },
        data: { externalId, sendStatus: "sent" },
      });
      void noteMessageRowChange(sentRow, "upd");
    }
    return { externalId, failed: false, error: null };
  } catch (err) {
    return markFailed(opts, formatMetaSendError(err));
  }
}

/**
 * Deriva a plataforma a partir do `conversation.channel` (slug lowercase).
 */
export function platformFromConversationChannel(
  channel: string | null | undefined,
): Platform | null {
  const c = (channel ?? "").toLowerCase();
  if (c === "messenger" || c === "facebook") return "messenger";
  if (c === "instagram") return "instagram";
  return null;
}
