import {
  metaWhatsApp,
  metaClientFromConfig,
  formatMetaSendError,
} from "@/lib/meta-whatsapp/client";
import { getContactWhatsAppTargets } from "@/lib/contact-whatsapp-target";
import { enqueueBaileysOutbound } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import { logMessageFailed } from "@/services/activity-log";

type ChannelInfo = {
  id: string;
  provider: string;
} | null | undefined;

type SendTextOpts = {
  conversationId: string;
  contactId: string;
  channelRef: ChannelInfo;
  content: string;
  messageId: string;
  replyContextWamid?: string | null;
  waJid?: string | null;
};

type SendTextResult = {
  externalId: string | null;
  failed: boolean;
  error: string | null;
};

/**
 * Marca a mensagem como falha (sendStatus/sendError) e registra o evento
 * `MESSAGE_FAILED` no Activity Log (feed `/logs` + estatisticas). Ponto
 * unico para todas as falhas imediatas de envio de texto (Meta e Baileys).
 * O log busca o nome do contato (Origem) de forma fire-and-forget.
 */
async function markFailed(
  opts: SendTextOpts,
  error: string,
  source: "api" | "baileys",
): Promise<SendTextResult> {
  await prisma.message
    .update({
      where: { id: opts.messageId },
      data: { sendStatus: "failed", sendError: error },
    })
    .catch(() => {});
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
      source,
      channel: "WhatsApp",
    });
  })();
  return { externalId: null, failed: true, error };
}

/**
 * Sends a WhatsApp text message via the appropriate provider
 * (Meta Cloud API or Baileys), determined by the conversation's channel.
 */
export async function sendWhatsAppText(opts: SendTextOpts): Promise<SendTextResult> {
  const provider = opts.channelRef?.provider;

  if (provider === "BAILEYS_MD" && opts.channelRef) {
    return sendViaBaileys(opts);
  }

  return sendViaMeta(opts);
}

async function getMetaClient(channelRef: ChannelInfo) {
  if (channelRef?.id) {
    const ch = await prisma.channel.findUnique({
      where: { id: channelRef.id },
      select: { config: true },
    });
    const cfg = ch?.config as Record<string, unknown> | null | undefined;
    const client = metaClientFromConfig(cfg);
    if (client.configured) return client;
  }
  return metaWhatsApp;
}

async function sendViaMeta(opts: SendTextOpts): Promise<SendTextResult> {
  const client = await getMetaClient(opts.channelRef);

  if (!client.configured) {
    return markFailed(opts, "Meta WhatsApp API não configurada.", "api");
  }

  const waTarget = await getContactWhatsAppTargets(opts.contactId);
  if (!waTarget) {
    return markFailed(opts, "Contato sem telefone nem BSUID WhatsApp.", "api");
  }

  try {
    const result = await client.sendText(
      waTarget.to,
      opts.content,
      waTarget.recipient,
      opts.replyContextWamid,
    );
    const externalId = result.messages?.[0]?.id ?? null;
    if (externalId) {
      // Grava wamid + sent juntos: o webhook de status (sent/delivered/read)
      // procura por externalId. Sem isso o ACK não encontra a mensagem.
      await prisma.message.update({
        where: { id: opts.messageId },
        data: { externalId, sendStatus: "sent" },
      });
    }
    return { externalId, failed: false, error: null };
  } catch (err) {
    const error = formatMetaSendError(err);
    return markFailed(opts, error, "api");
  }
}

async function sendViaBaileys(opts: SendTextOpts): Promise<SendTextResult> {
  let targetJid = opts.waJid ?? null;

  if (!targetJid) {
    const contact = await prisma.contact.findUnique({
      where: { id: opts.contactId },
      select: { phone: true },
    });

    if (!contact?.phone) {
      return markFailed(opts, "Contato sem telefone para envio via Baileys.", "baileys");
    }
    targetJid = contact.phone;
  }

  try {
    await enqueueBaileysOutbound({
      channelId: opts.channelRef!.id,
      to: targetJid,
      content: opts.content,
      messageType: "text",
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      replyTo: opts.replyContextWamid ?? undefined,
    });
    return { externalId: null, failed: false, error: null };
  } catch (err) {
    const error = formatMetaSendError(err);
    return markFailed(opts, error, "baileys");
  }
}

type SendMediaOpts = {
  conversationId: string;
  contactId: string;
  channelRef: ChannelInfo;
  messageId: string;
  mediaUrl: string;
  messageType: string;
  caption?: string;
  waJid?: string | null;
  mime?: string;
  originalName?: string;
};

/**
 * Sends a media message via the appropriate provider.
 * For Baileys, enqueues a job; for Meta, calls the Graph API directly.
 */
export async function sendWhatsAppMedia(opts: SendMediaOpts): Promise<SendTextResult> {
  const provider = opts.channelRef?.provider;

  if (provider === "BAILEYS_MD" && opts.channelRef) {
    let targetJid = opts.waJid ?? null;

    if (!targetJid) {
      const contact = await prisma.contact.findUnique({
        where: { id: opts.contactId },
        select: { phone: true },
      });

      if (!contact?.phone) {
        return { externalId: null, failed: true, error: "Contato sem telefone para Baileys." };
      }
      targetJid = contact.phone;
    }

    try {
      const job = await enqueueBaileysOutbound({
        channelId: opts.channelRef.id,
        to: targetJid,
        content: opts.caption ?? "",
        mediaUrl: opts.mediaUrl,
        messageType: opts.messageType,
        conversationId: opts.conversationId,
        messageId: opts.messageId,
        mime: opts.mime,
        originalName: opts.originalName,
      });
      if (!job) {
        return {
          externalId: null,
          failed: true,
          error: "Redis indisponível — não foi possível enfileirar envio Baileys.",
        };
      }
      return { externalId: null, failed: false, error: null };
    } catch (err) {
      const error = formatMetaSendError(err);
      return { externalId: null, failed: true, error };
    }
  }

  // Meta path handled by existing code in the route
  return { externalId: null, failed: false, error: null };
}

export function isBaileysChannel(channelRef: ChannelInfo): boolean {
  return channelRef?.provider === "BAILEYS_MD";
}
