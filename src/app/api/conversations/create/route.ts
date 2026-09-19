import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { MetaWhatsAppClient } from "@/lib/meta-whatsapp/client";
import { enqueueBaileysOutbound } from "@/lib/queue";
import {
  getChannelById,
  parseChannelConfigDecrypted,
} from "@/services/channels";
import { logEvent } from "@/services/activity-log";
import { resolveDefaultWhatsAppChannel } from "@/services/whatsapp-conversation";
import {
  activeConversationOnAccountWhere,
  withConversationNumberRetry,
} from "@/services/conversations";
import { fireTrigger } from "@/services/automation-triggers";
import { getLogger } from "@/lib/logger";
import { sseBus } from "@/lib/sse-bus";
import { getOrgIdOrNull } from "@/lib/request-context";

const log = getLogger("conversations.create");

/** Origens conhecidas do create (UI / skipSend). Valor livre, truncado. */
const CREATE_SOURCES = new Set([
  "ui",
  "ui_skip_send",
  "deal_chat",
  "deal_workspace",
  "deal_panel",
]);

function str(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function parseCreateSource(raw: unknown, skipSend: boolean): string {
  if (typeof raw === "string") {
    const s = raw.trim().slice(0, 64);
    if (s && (CREATE_SOURCES.has(s) || /^[a-z][a-z0-9_]{0,63}$/i.test(s))) {
      return s;
    }
  }
  return skipSend ? "ui_skip_send" : "ui";
}

// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      const contactId = typeof body.contactId === "string" ? body.contactId : "";
      const channelId = typeof body.channelId === "string" ? body.channelId : "";
      const message = typeof body.message === "string" ? body.message.trim() : "";
      const skipSend = body.skipSend === true;
      const createSource = parseCreateSource(body.source, skipSend);

      if (!contactId) {
        return NextResponse.json({ message: "contactId obrigatório." }, { status: 400 });
      }

      const contact = await prisma.contact.findUnique({ where: { id: contactId } });
      if (!contact) {
        return NextResponse.json({ message: "Contato não encontrado." }, { status: 404 });
      }

      // If skipSend, create/reuse conversation record without sending a message.
      // Used when opening chat for a contact with no prior conversations.
      if (skipSend) {
        // Bloco B (25/jun/26): exige `view` quando channelId é informado.
        // Sem channelId não há canal pra escopar (conversa criada sem
        // channelId, caso legado) — mantém o comportamento anterior.
        if (channelId) {
          const viewDenied = await requireChannelScope(session.user, "view", channelId);
          if (viewDenied) return viewDenied;
        }

        // Resolve o canal alvo:
        //  1. Se o cliente passou `channelId`, ele manda.
        //  2. Senão, cai pro canal Meta CONNECTED default da org (mesma
        //     regra do automation-executor). CRÍTICO: sem isso a conversa
        //     nasce sem `channelId` e o envio de template subsequente cai
        //     no env singleton (leak entre orgs).
        let effectiveChannelId: string | null = channelId || null;
        let channelName: string | null = null;
        if (channelId) {
          const ch = await getChannelById(channelId);
          channelName = ch?.name ?? null;
        }
        if (!effectiveChannelId) {
          const defaultCh = await resolveDefaultWhatsAppChannel();
          if (defaultCh) {
            effectiveChannelId = defaultCh.id;
            channelName = defaultCh.name;
          }
        }

        const convSelect = {
          id: true, externalId: true, channel: true,
          status: true, inboxName: true, channelId: true,
          createdAt: true, updatedAt: true,
        } as const;
        const findOnAccount = (accountId: string | null) =>
          prisma.conversation.findFirst({
            where: activeConversationOnAccountWhere({
              contactId: contact.id,
              channel: "whatsapp",
              channelId: accountId,
            }),
            select: convSelect,
          });

        let conversation = await findOnAccount(effectiveChannelId);
        if (!conversation && effectiveChannelId) {
          const orphan = await findOnAccount(null);
          if (orphan) {
            await prisma.conversation.update({
              where: { id: orphan.id },
              data: {
                channelId: effectiveChannelId,
                inboxName: orphan.inboxName ?? channelName,
              },
            });
            conversation = { ...orphan, channelId: effectiveChannelId };
          }
        }
        const reused = Boolean(conversation);

        if (!conversation) {
          conversation = await withConversationNumberRetry((number) =>
            prisma.conversation.create({
              data: withOrgFromCtx({
                number,
                channel: "whatsapp",
                status: "OPEN" as const,
                inboxName: channelName,
                contactId: contact.id,
                ...(effectiveChannelId ? { channelId: effectiveChannelId } : {}),
                ...(contact.assignedToId ? { assignedToId: contact.assignedToId } : {}),
              }),
              select: {
                id: true, externalId: true, channel: true,
                status: true, inboxName: true, channelId: true,
                createdAt: true, updatedAt: true,
              },
            }),
          );
          // Await: a timeline da conversa depende deste evento. Sem await,
          // o 1º GET /timeline após o create frequentemente voltava vazio.
          await logEvent({
            type: "CONVERSATION_CREATED",
      actorType: "HUMAN",
            entityType: "CONVERSATION",
            entityId: conversation.id,
            entityLabel: contact.name ?? contact.phone ?? null,
            conversationId: conversation.id,
            contactId: contact.id,
            meta: {
              channel: "whatsapp",
              inboxName: channelName,
              channelId: effectiveChannelId,
              source: createSource,
              // skipSend = atendimento aberto sem mensagem (composer/templates).
              openedWithoutMessage: true,
            },
          });
          try {
            sseBus.publish("conversation_timeline_updated", {
              organizationId: getOrgIdOrNull(),
              conversationId: conversation.id,
              type: "CONVERSATION_CREATED",
            });
          } catch {
            /* best-effort */
          }
          // Ver AGENT.md "ID de conversa + logs + gatilho": tipo ja existia
          // registrado, mas o fireTrigger nunca era chamado. Fire-and-forget
          // pra nao bloquear a resposta HTTP.
          fireTrigger("conversation_created", {
            contactId: contact.id,
            data: {
              channel: "whatsapp",
              inboxName: channelName,
              source: createSource,
              openedWithoutMessage: true,
            },
          }).catch((err) => log.warn("Falha no gatilho conversation_created:", err));
        }

        return NextResponse.json({
          conversation: {
            id: conversation.id,
            externalId: conversation.externalId,
            channel: conversation.channel,
            status: conversation.status,
            inboxName: conversation.inboxName ?? channelName,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
          },
        }, { status: reused ? 200 : 201 });
      }

      if (!channelId) {
        return NextResponse.json({ message: "channelId obrigatório." }, { status: 400 });
      }
      if (!message) {
        return NextResponse.json({ message: "Mensagem obrigatória." }, { status: 400 });
      }

      const channel = await getChannelById(channelId);
      if (!channel) {
        return NextResponse.json({ message: "Canal não encontrado." }, { status: 404 });
      }

      // Bloco B (25/jun/26): caminho "nova conversa com mensagem" exige
      // ambos `initiate` (iniciar conversa com cliente) e `send` (enviar
      // mensagem). `initiate` implica `view`, então checa nessa ordem.
      const initiateDenied = await requireChannelScope(session.user, "initiate", channel.id);
      if (initiateDenied) return initiateDenied;
      const sendDenied = await requireChannelScope(session.user, "send", channel.id);
      if (sendDenied) return sendDenied;

      if (channel.status !== "CONNECTED") {
        return NextResponse.json(
          { message: `Canal "${channel.name}" não está conectado (status: ${channel.status}).` },
          { status: 400 }
        );
      }

      const waDigits = contact.phone?.replace(/\D/g, "") ?? "";
      const waTo = waDigits.length >= 8 ? waDigits : undefined;
      const waRecipient = contact.whatsappBsuid?.trim() || undefined;
      if (!waTo && !waRecipient) {
        return NextResponse.json(
          {
            message:
              "Contato sem telefone nem BSUID WhatsApp.",
          },
          { status: 400 }
        );
      }

      // Reusa só o OPEN desta conta. Outra WABA não é roubada; órfã
      // (channelId NULL) pode ser adotada. Não promove RESOLVED.
      const existing = await prisma.conversation.findFirst({
        where: activeConversationOnAccountWhere({
          contactId: contact.id,
          channel: "whatsapp",
          channelId: channel.id,
        }),
        select: { id: true, externalId: true, waJid: true },
      });

      let conversation;
      if (existing) {
        conversation = await prisma.conversation.update({
          where: { id: existing.id },
          data: { inboxName: channel.name, updatedAt: new Date() },
        });
      } else {
        const orphan = await prisma.conversation.findFirst({
          where: activeConversationOnAccountWhere({
            contactId: contact.id,
            channel: "whatsapp",
            channelId: null,
          }),
          select: { id: true },
        });
        if (orphan) {
          conversation = await prisma.conversation.update({
            where: { id: orphan.id },
            data: {
              inboxName: channel.name,
              channelId: channel.id,
              updatedAt: new Date(),
            },
          });
        }
      }
      if (!conversation) {
        conversation = await withConversationNumberRetry((number) =>
          prisma.conversation.create({
            data: withOrgFromCtx({
              number,
              channel: "whatsapp",
              status: "OPEN" as const,
              inboxName: channel.name,
              channelId: channel.id,
              contactId: contact.id,
              ...(contact.assignedToId ? { assignedToId: contact.assignedToId } : {}),
            }),
          }),
        );
        void logEvent({
          type: "CONVERSATION_CREATED",
      actorType: "HUMAN",
          entityType: "CONVERSATION",
          entityId: conversation.id,
          entityLabel: contact.name ?? contact.phone ?? null,
          conversationId: conversation.id,
          contactId: contact.id,
          meta: {
            channel: "whatsapp",
            inboxName: channel.name,
            source: createSource,
            openedWithoutMessage: false,
          },
        });
        fireTrigger("conversation_created", {
          contactId: contact.id,
          data: {
            channel: "whatsapp",
            inboxName: channel.name,
            source: createSource,
          },
        }).catch((err) => log.warn("Falha no gatilho conversation_created:", err));
      }

      const senderName = session.user.name ?? session.user.email ?? "Agente";

      if (channel.provider === "BAILEYS_MD") {
        const msgRow = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: conversation.id,
            channelId: channel.id,
            content: message,
            direction: "out",
            messageType: "text",
            senderName,
          }),
        });

        const baileysTo = existing?.waJid ?? contact.phone!;
        await enqueueBaileysOutbound({
          channelId: channel.id,
          to: baileysTo,
          content: message,
          messageType: "text",
          conversationId: conversation.id,
          messageId: msgRow.id,
        });
      } else {
        const config = parseChannelConfigDecrypted({
          provider: channel.provider,
          config: channel.config,
        });
        const accessToken = str(config, "accessToken");
        const phoneNumberId = str(config, "phoneNumberId") ?? channel.phoneNumber ?? undefined;
        const businessAccountId = str(config, "businessAccountId");

        if (!accessToken || !phoneNumberId || !businessAccountId) {
          return NextResponse.json(
            { message: "Config Meta incompleta (accessToken, phoneNumberId, businessAccountId)." },
            { status: 400 }
          );
        }

        const meta = new MetaWhatsAppClient(accessToken, phoneNumberId, businessAccountId);
        await meta.sendMessage(waTo, message, waRecipient);

        await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: conversation.id,
            channelId: channel.id,
            content: message,
            direction: "out",
            messageType: "text",
            senderName,
          }),
        });
      }

      return NextResponse.json({
        conversation: {
          id: conversation.id,
          externalId: conversation.externalId,
          channel: "whatsapp",
          status: "OPEN",
          inboxName: channel.name,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
      }, { status: 201 });
    } catch (e: unknown) {
      console.error("Error creating conversation:", e);
      const msg = e instanceof Error ? e.message : "Erro ao criar conversa.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
