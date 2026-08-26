import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { sseBus } from "@/lib/sse-bus";
import { getOrgIdOrNull } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { maybeSendMissedCallScheduleTemplate } from "@/services/missed-call-schedule-offer";
import {
  buildConnectChatLine,
  buildConversationTimelineCallRecordingContent,
  buildTerminateChatLine,
  extractRecordingUrl,
  extractWhatsappCallSdpSession,
  parseCallBizOpaque,
  wasWhatsappCallPickedUp,
} from "@/lib/whatsapp-call-chat";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export type CallWebhookContact = { id: string; name: string; phone: string | null };

export type CallWebhookDeps = {
  resolveWebhookContact: (
    waIdRaw: string | undefined,
    bsuidRaw: string | undefined,
    profileName: string | null,
    phoneNumberId?: string,
  ) => Promise<CallWebhookContact>;
  findOrCreateConversation: (
    contactId: string,
    phoneNumberId?: string,
  ) => Promise<{ id: string; organizationId?: string }>;
};

type ResolvedCallConv = {
  conv: { id: string; organizationId: string | null };
  contact: CallWebhookContact;
};

async function resolveCallTicket(
  callId: string,
  customerWa: string,
  customerBsuid: string,
  profileName: string | null,
  phoneNumberId: string,
  deps: CallWebhookDeps,
): Promise<ResolvedCallConv | null> {
  const prior = await prisma.whatsappCallEvent.findFirst({
    where: { metaCallId: callId, conversationId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { conversationId: true, contactId: true },
  });
  if (prior?.conversationId) {
    const row = await prisma.conversation.findUnique({
      where: { id: prior.conversationId },
      select: { id: true, organizationId: true, contactId: true },
    });
    if (row) {
      return {
        conv: { id: row.id, organizationId: row.organizationId },
        contact: {
          id: prior.contactId || row.contactId,
          name: profileName || "",
          phone: customerWa || null,
        },
      };
    }
  }

  try {
    const contact = await deps.resolveWebhookContact(
      customerWa || undefined,
      customerBsuid || undefined,
      profileName,
      phoneNumberId,
    );
    const conv = await deps.findOrCreateConversation(contact.id, phoneNumberId);
    return {
      conv: { id: conv.id, organizationId: conv.organizationId ?? getOrgIdOrNull() },
      contact,
    };
  } catch (e) {
    console.warn("[meta-webhook] call webhook sem contato resolvível:", e);
    return null;
  }
}

function sseOrgId(convOrgId: string | null | undefined): string | null {
  return convOrgId || getOrgIdOrNull();
}

async function resolveBizOpaqueForCall(callId: string, incoming: string): Promise<string | null> {
  if (incoming) return incoming;
  const row = await prisma.whatsappCallEvent.findFirst({
    where: { metaCallId: callId, bizOpaque: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { bizOpaque: true },
  });
  const o = row?.bizOpaque?.trim();
  return o || null;
}

/**
 * Processa webhooks com `field: "calls"` (WhatsApp Cloud API Calling).
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/calling
 */
export async function processMetaWhatsappCallsWebhook(
  value: Record<string, unknown>,
  phoneNumberId: string,
  deps: CallWebhookDeps
): Promise<void> {
  const contactsArr = arr(value.contacts);
  const profileNameFromContacts = (): string | null => {
    if (contactsArr.length !== 1) return null;
    const co = obj(contactsArr[0]);
    const prof = obj(co.profile);
    return str(prof.name) || str(prof.username) || null;
  };

  const valueErrors = arr(value.errors);

  // Statuses: RINGING / ACCEPTED / REJECTED (business-initiated)
  const statuses = arr(value.statuses);
  for (const raw of statuses) {
    const st = obj(raw);
    const stType = str(st.type).toLowerCase();
    if (stType && stType !== "call") continue;
    const callId = str(st.id);
    const sigStatus = str(st.status);
    const recipient = str(st.recipient_id);
    if (!callId || !sigStatus) continue;

    const profileName = profileNameFromContacts();
    const contact0 = obj(contactsArr[0]);
    const resolved = await resolveCallTicket(
      callId,
      recipient || str(contact0.wa_id),
      str(contact0.user_id),
      profileName,
      phoneNumberId,
      deps,
    );
    if (!resolved) continue;
    const { conv, contact } = resolved;
    try {
      await prisma.whatsappCallEvent.create({
        data: withOrgFromCtx({
          metaCallId: callId,
          phoneNumberId,
          direction: "BUSINESS_INITIATED",
          eventKind: "signaling",
          signalingStatus: sigStatus,
          toWa: recipient || null,
          conversationId: conv.id,
          contactId: contact.id,
        }),
      });
      sseBus.publish("whatsapp_call", {
        organizationId: sseOrgId(conv.organizationId),
        conversationId: conv.id,
        contactId: contact.id,
        callId,
        signalingStatus: sigStatus,
      });

      // ACCEPTED = cliente atendeu. `connect` (SDP) chega antes, no toque.
      if (sigStatus.toUpperCase() === "ACCEPTED") {
        const opaqueJoined = await resolveBizOpaqueForCall(callId, "");
        const { agentName } = parseCallBizOpaque(opaqueJoined ?? undefined);
        const chatLine = buildConnectChatLine({
          direction: "BUSINESS_INITIATED",
          eventTime: new Date(Number(str(st.timestamp) || 0) * 1000 || Date.now()),
          agentName,
        });
        const senderName = agentName?.trim()
          ? `WhatsApp · ${agentName.trim()}`
          : "WhatsApp";
        const dedupeKey = `call_evt:${callId}:connect`;
        const already = await prisma.message.findFirst({
          where: { conversationId: conv.id, externalId: dedupeKey },
          select: { id: true },
        });
        if (!already) {
          await prisma.message.create({
            data: withOrgFromCtx({
              conversationId: conv.id,
              content: chatLine,
              direction: "out",
              messageType: "whatsapp_call",
              senderName,
              externalId: dedupeKey,
              sendStatus: "delivered",
            }),
          });
          await prisma.conversation
            .update({
              where: { id: conv.id },
              data: { updatedAt: new Date(), lastMessageDirection: "out" },
            })
            .catch(() => {});
          sseBus.publish("new_message", {
            organizationId: sseOrgId(conv.organizationId),
            conversationId: conv.id,
            contactId: contact.id,
            direction: "out",
            content: chatLine,
            timestamp: new Date(),
          });
        }
      }
    } catch (e) {
      console.warn("[meta-webhook] call signaling:", e);
    }
  }

  const calls = arr(value.calls);
  /** Chamadas USER_INITIATED terminadas — oferta de agendamento avaliada após persistir todos os eventos do payload. */
  const missedUserCallOffers = new Map<string, { conversationId: string; contactId: string }>();

  for (const raw of calls) {
    const c = obj(raw);
    const callId = str(c.id);
    const event = str(c.event).toLowerCase();
    const direction = str(c.direction);
    const fromWa = str(c.from);
    const toWa = str(c.to);
    const ts = str(c.timestamp);
    const eventTime = ts ? new Date(Number(ts) * 1000) : new Date();

    if (!callId || !event) continue;

    const contact0 = obj(contactsArr[0]);
    const waFromContacts = str(contact0.wa_id);
    const bsuidFromContacts = str(contact0.user_id);
    // BIC: `from` é o número da empresa — não usar como cliente.
    const customerWa =
      direction === "USER_INITIATED"
        ? fromWa || waFromContacts || toWa
        : toWa || waFromContacts;

    const profileName = profileNameFromContacts();
    const resolved = await resolveCallTicket(
      callId,
      customerWa,
      bsuidFromContacts,
      profileName,
      phoneNumberId,
      deps,
    );
    if (!resolved) continue;
    const { conv, contact } = resolved;

    const terminateStatus = str(c.status);
    const durationRaw = c.duration;
    let durationSec: number | null = null;
    if (typeof durationRaw === "number" && Number.isFinite(durationRaw)) {
      durationSec = durationRaw;
    } else if (typeof durationRaw === "string") {
      const n = Number.parseInt(durationRaw, 10);
      if (Number.isFinite(n)) durationSec = n;
    }

    const startT = str(c.start_time);
    const endT = str(c.end_time);
    const callErrors = arr(c.errors);
    const errorsPayload =
      callErrors.length > 0 ? callErrors : valueErrors.length > 0 ? valueErrors : undefined;

    const sessionPayload = extractWhatsappCallSdpSession(c) ?? undefined;
    const errorsJson: Prisma.InputJsonValue | undefined =
      sessionPayload || errorsPayload
        ? ({
            ...(sessionPayload ? { session: sessionPayload } : {}),
            ...(errorsPayload ? { errors: errorsPayload } : {}),
          } as Prisma.InputJsonValue)
        : undefined;

    if (event === "connect") {
      console.info(
        `[meta-webhook] call connect id=${callId} dir=${direction || "?"} conv=${conv.id} sdp=${sessionPayload ? sessionPayload.sdp_type : "none"}`,
      );
    }

    await prisma.whatsappCallEvent.create({
      data: withOrgFromCtx({
        metaCallId: callId,
        phoneNumberId,
        direction: direction || "UNKNOWN",
        eventKind: event,
        terminateStatus: terminateStatus || null,
        fromWa: fromWa || null,
        toWa: toWa || null,
        durationSec,
        startTime: startT ? new Date(Number(startT) * 1000) : null,
        endTime: endT ? new Date(Number(endT) * 1000) : null,
        bizOpaque: str(c.biz_opaque_callback_data) || null,
        errorsJson,
        conversationId: conv.id,
        contactId: contact.id,
      }),
    });

    if (event === "connect" && direction === "USER_INITIATED") {
      await prisma.conversation
        .update({
          where: { id: conv.id },
          data: {
            whatsappCallConsentStatus: "GRANTED",
            whatsappCallConsentUpdatedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .catch(() => {});
    }

    const dedupeKey = `call_evt:${callId}:${event}`;
    const already = await prisma.message.findFirst({
      where: { conversationId: conv.id, externalId: dedupeKey },
      select: { id: true },
    });

    const incomingOpaque = str(c.biz_opaque_callback_data);
    const opaqueJoined = await resolveBizOpaqueForCall(callId, incomingOpaque);
    const { agentName } = parseCallBizOpaque(opaqueJoined ?? undefined);

    let chatLine: string | null = null;
    if (event === "connect" && direction === "USER_INITIATED") {
      // BIC: `connect` é só o SDP (toque). Sucesso de saída vai no ACCEPTED.
      chatLine = buildConnectChatLine({
        direction,
        eventTime,
        agentName: undefined,
      });
    } else if (event === "terminate") {
      const startDate = startT ? new Date(Number(startT) * 1000) : null;
      const endDateMeta = endT ? new Date(Number(endT) * 1000) : null;
      const endDate = endDateMeta ?? eventTime;
      const prior = await prisma.whatsappCallEvent.findMany({
        where: { metaCallId: callId },
        select: { signalingStatus: true },
      });
      const signalingStatuses = prior.map((p) => p.signalingStatus);
      const pickedUp = wasWhatsappCallPickedUp({
        durationSec,
        startTime: startDate,
        endTime: endDateMeta,
        signalingStatuses,
      });
      const rejected = signalingStatuses.some((s) => (s ?? "").toUpperCase() === "REJECTED");
      chatLine = buildTerminateChatLine({
        terminateStatus,
        durationSec,
        startDate,
        endDate,
        agentName: direction === "BUSINESS_INITIATED" ? agentName : undefined,
        pickedUp,
        rejected,
      });
    }

    const senderName =
      direction === "BUSINESS_INITIATED" && agentName?.trim()
        ? `WhatsApp · ${agentName.trim()}`
        : "WhatsApp";

    // Lateralização do balão no chat: BUSINESS_INITIATED (chamada feita
    // pelo agente) vai pro lado direito como ação outbound; USER_INITIATED
    // (cliente ligou) vai pro lado esquerdo como ação inbound. Antes,
    // tudo virava `direction: "system"` e ficava centralizado, o que
    // mascarava quem iniciou a chamada visualmente.
    const callMessageDirection: "in" | "out" =
      direction === "BUSINESS_INITIATED" ? "out" : "in";

    if (chatLine && !already) {
      await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: conv.id,
          content: chatLine,
          direction: callMessageDirection,
          messageType: "whatsapp_call",
          senderName,
          externalId: dedupeKey,
          createdAt: eventTime,
          // Evento de call do webhook da Meta: não é mensagem outbound
          // passível de delivery pela Cloud API. Marcamos como delivered
          // pra não cair no sweeper de stale.
          sendStatus: "delivered",
        }),
      });

      try {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: {
            updatedAt: new Date(),
            lastMessageDirection: callMessageDirection,
          },
        });
      } catch {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { updatedAt: new Date() },
        }).catch(() => {});
      }

      sseBus.publish("new_message", {
        organizationId: sseOrgId(conv.organizationId),
        conversationId: conv.id,
        contactId: contact.id,
        direction: callMessageDirection,
        content: chatLine,
        timestamp: eventTime,
      });
    }

    if (event === "terminate") {
      const startDate = startT ? new Date(Number(startT) * 1000) : null;
      const endDate = endT ? new Date(Number(endT) * 1000) : eventTime;
      const recordingUrl = extractRecordingUrl(c);
      const timelineExtId = `call_timeline:${callId}`;
      const dupTimeline = await prisma.message.findFirst({
        where: { conversationId: conv.id, externalId: timelineExtId },
        select: { id: true },
      });
      // Só materializa o registro "longo" na timeline quando a Meta realmente
      // anexa uma gravação — aí o bloco vira legenda útil do player de áudio.
      // Sem URL, as duas bolhas compactas ("Chamada · saída" + "Chamada · fim")
      // já dão todo o contexto; o bloco verboso só polui o chat.
      if (!dupTimeline && recordingUrl) {
        const timelineBody = buildConversationTimelineCallRecordingContent({
          callId,
          direction,
          agentName: direction === "BUSINESS_INITIATED" ? agentName : undefined,
          startDate,
          endDate,
          durationSec,
          terminateStatus,
          hasRecordingUrl: true,
        });
        const tlSender =
          direction === "BUSINESS_INITIATED" && agentName?.trim()
            ? `WhatsApp · chamada · ${agentName.trim()}`
            : "WhatsApp · chamada";
        try {
          await prisma.message.create({
            data: withOrgFromCtx({
              conversationId: conv.id,
              content: timelineBody,
              // Gravação acompanha o lado de quem iniciou: chamada
              // outbound do agente → bolha à direita (`"out"`); chamada
              // inbound do cliente → bolha à esquerda (`"in"`).
              direction: callMessageDirection,
              messageType: "whatsapp_call_recording",
              senderName: tlSender,
              externalId: timelineExtId,
              mediaUrl: recordingUrl || null,
              createdAt: endDate,
              // Artefato interno de call — não passa pela Cloud API.
              sendStatus: "delivered",
            }),
          });
          await prisma.conversation
            .update({
              where: { id: conv.id },
              data: { updatedAt: new Date(), lastMessageDirection: callMessageDirection },
            })
            .catch(() => {});
          sseBus.publish("new_message", {
            organizationId: sseOrgId(conv.organizationId),
            conversationId: conv.id,
            contactId: contact.id,
            direction: callMessageDirection,
            content: timelineBody,
            timestamp: endDate,
          });
        } catch (e) {
          console.warn("[meta-webhook] mensagem timeline gravação:", e);
        }
      }

      if (direction === "USER_INITIATED") {
        missedUserCallOffers.set(callId, { conversationId: conv.id, contactId: contact.id });
      }
    }

    sseBus.publish("whatsapp_call", {
      organizationId: sseOrgId(conv.organizationId),
      conversationId: conv.id,
      contactId: contact.id,
      callId,
      event,
      direction,
      ...(sessionPayload ? { session: sessionPayload } : {}),
    });
  }

  for (const [callId, p] of missedUserCallOffers) {
    const hadConnect = await prisma.whatsappCallEvent.findFirst({
      where: {
        metaCallId: callId,
        eventKind: "connect",
        direction: "USER_INITIATED",
      },
      select: { id: true },
    });
    if (!hadConnect) {
      await maybeSendMissedCallScheduleTemplate({
        conversationId: p.conversationId,
        contactId: p.contactId,
        callId,
      });
    }
  }
}
