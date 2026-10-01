/**
 * Loga uma ligação SIP/Api4com na conversa do contato (inbox).
 *
 * Chamadas aparecem no widget /calls via tabela `Call`. Sem este helper,
 * o chat só recebia aviso se o webhook de hangup encontrasse conversa
 * já existente — o sync de CDR (origem real do histórico no widget)
 * nunca criava Message.
 *
 * Dedupe: `externalId = sip_call:<callId>`. Não cria conversa nova.
 */
import type { CallDirection } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrg } from "@/lib/prisma-helpers";
import { publishNewMessage } from "@/lib/realtime-events";

const log = getLogger("sip-call-chat");

const RECENT_MS = 15 * 60 * 1000;

export type LogSipCallInConversationInput = {
  organizationId: string;
  callId: string;
  contactId: string | null | undefined;
  direction: CallDirection;
  answered: boolean;
  durationSec: number | null;
  recordingUrl?: string | null;
  occurredAt?: Date | null;
  /** SSE + bump de `conversation.updatedAt`. Default: só se a chamada for recente. */
  notifyInbox?: boolean;
};

export function formatCallDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m <= 0) return `${sec}s`;
  return sec > 0 ? `${m}min ${sec}s` : `${m}min`;
}

export async function resolveContactConversationId(
  contactId: string,
): Promise<string | null> {
  const open = await prisma.conversation.findFirst({
    where: { contactId, status: { not: "RESOLVED" } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (open) return open.id;

  const any = await prisma.conversation.findFirst({
    where: { contactId },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  return any?.id ?? null;
}

export async function logSipCallInConversation(
  input: LogSipCallInConversationInput,
): Promise<string | null> {
  if (!input.contactId) return null;

  let conversationId: string | null;
  try {
    conversationId = await resolveContactConversationId(input.contactId);
  } catch (err) {
    log.warn({ err, contactId: input.contactId }, "[sip-call-chat] falha ao resolver conversa");
    return null;
  }
  if (!conversationId) return null;

  const isInbound = input.direction === "INBOUND";
  const callMessageDirection: "in" | "out" = isInbound ? "in" : "out";
  const label = isInbound ? "Ligação recebida" : "Ligação realizada";
  const suffix = input.answered
    ? input.durationSec && input.durationSec > 0
      ? ` · ${formatCallDuration(input.durationSec)}`
      : ""
    : " · não atendida";
  const chatLine = `${label}${suffix}`;
  const dedupeKey = `sip_call:${input.callId}`;
  const eventNow = input.occurredAt && !Number.isNaN(input.occurredAt.getTime())
    ? input.occurredAt
    : new Date();

  try {
    const already = await prisma.message.findFirst({
      where: { conversationId, externalId: dedupeKey },
      select: { id: true },
    });
    if (already) return conversationId;

    await prisma.message.create({
      data: withOrg(
        {
          conversationId,
          content: chatLine,
          direction: callMessageDirection,
          messageType: "sip_call",
          authorType: "system" as const,
          senderName: "Telefonia",
          externalId: dedupeKey,
          sendStatus: "delivered",
          createdAt: eventNow,
        },
        input.organizationId,
      ),
    });
  } catch (err) {
    log.warn({ err, callId: input.callId }, "[sip-call-chat] falha ao gravar sip_call no chat");
    return conversationId;
  }

  const isRecent = Date.now() - eventNow.getTime() < RECENT_MS;
  const notify = input.notifyInbox ?? isRecent;
  if (!notify) return conversationId;

  await prisma.conversation
    .update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
        lastMessageDirection: callMessageDirection,
      },
    })
    .catch(() => {});

  publishNewMessage({
    organizationId: input.organizationId,
    conversationId,
    contactId: input.contactId,
    direction: callMessageDirection,
    content: chatLine,
    timestamp: eventNow,
  });

  return conversationId;
}
