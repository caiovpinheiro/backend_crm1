import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { mapMetaWhatsappCallGraphError } from "@/lib/meta-whatsapp-call-errors";
import {
  metaClientFromConfig,
  type WhatsAppCallSession,
} from "@/lib/meta-whatsapp/client";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  buildCallBizOpaquePayload,
  sessionFromCallEventErrorsJson,
} from "@/lib/whatsapp-call-chat";
import { prisma } from "@/lib/prisma";
import { ensureWhatsappCallConsentForOutbound } from "@/services/whatsapp-call-consent-webhook";

export const maxDuration = 30;

type RouteContext = { params: Promise<{ id: string }> };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Destino Meta na conversa: dígitos e/ou BSUID. */
async function getContactWhatsAppTargets(contactId: string): Promise<{ to?: string; recipient?: string } | null> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { phone: true, whatsappBsuid: true },
  });
  if (!contact) return null;
  const digits = contact.phone?.replace(/\D/g, "") ?? "";
  const to = digits.length >= 8 ? digits : undefined;
  const recipient = contact.whatsappBsuid?.trim() || undefined;
  if (!to && !recipient) return null;
  return { ...(to ? { to } : {}), ...(recipient ? { recipient } : {}) };
}

function parseSession(raw: unknown): WhatsAppCallSession | null {
  const s = obj(raw);
  const sdp_type = str(s.sdp_type);
  const sdp = str(s.sdp);
  if (!sdp_type || !sdp) return null;
  return { sdp_type, sdp };
}

function channelPhoneNumberId(config: unknown): string {
  const c = obj(config);
  return str(c.phoneNumberId) || str(c.phone_number_id);
}


/**
 * GET: histórico de eventos de chamada (webhook Calling API).
 * POST: proxy para Graph `POST /{phone-number-id}/calls` (WebRTC SDP).
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/calling/reference
 */
export async function GET(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

    const conv = await prisma.conversation.findUnique({
      where: { id },
      select: { channel: true },
    });
    if (!conv) {
      return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
    }
    if (conv.channel !== "whatsapp") {
      return NextResponse.json({ message: "Chamadas WhatsApp só se aplicam a conversas WhatsApp." }, { status: 400 });
    }

    const answerFor = new URL(request.url).searchParams.get("answerFor")?.trim() || "";

    const items = await prisma.whatsappCallEvent.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: {
        id: true,
        metaCallId: true,
        direction: true,
        eventKind: true,
        signalingStatus: true,
        terminateStatus: true,
        durationSec: true,
        startTime: true,
        endTime: true,
        createdAt: true,
      },
    });

    if (!answerFor) {
      return NextResponse.json({ items });
    }

    const sdpRows = await prisma.whatsappCallEvent.findMany({
      where: { metaCallId: answerFor },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { errorsJson: true, eventKind: true },
    });
    let pendingAnswer: { sdp_type: string; sdp: string } | null = null;
    for (const row of sdpRows) {
      const sess = sessionFromCallEventErrorsJson(row.errorsJson);
      if (sess && sess.sdp_type.toLowerCase() === "answer") {
        pendingAnswer = sess;
        break;
      }
    }

    return NextResponse.json({ items, pendingAnswer });
    } catch (e) {
      console.error(e);
      return NextResponse.json({ message: "Erro ao listar chamadas." }, { status: 500 });
    }
  });
}

export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

    const conv = await prisma.conversation.findUnique({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        contactId: true,
        channel: true,
        whatsappCallConsentStatus: true,
        channelRef: { select: { config: true, provider: true } },
      },
    });
    if (!conv) {
      return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
    }
    if (conv.channel !== "whatsapp") {
      return NextResponse.json({ message: "Chamadas WhatsApp só se aplicam a conversas WhatsApp." }, { status: 400 });
    }

    if (conv.channelRef?.provider !== "META_CLOUD_API") {
      return NextResponse.json(
        { message: "Chamadas só são suportadas em canais Meta Cloud API." },
        { status: 400 },
      );
    }
    const metaClient = metaClientFromConfig(
      conv.channelRef.config as Record<string, unknown> | null | undefined,
    );
    if (!metaClient.configured) {
      return NextResponse.json(
        {
          message:
            "Canal Meta Cloud API desta conversa está sem credenciais (accessToken/phoneNumberId).",
        },
        { status: 503 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    const action = str(b.action).toLowerCase();

    if (
      action !== "initiate" &&
      action !== "pre_accept" &&
      action !== "accept" &&
      action !== "reject" &&
      action !== "terminate"
    ) {
      return NextResponse.json(
        {
          message:
            "action inválida. Use: initiate, pre_accept, accept, reject ou terminate.",
        },
        { status: 400 },
      );
    }

    if (action === "initiate") {
      const granted =
        conv.whatsappCallConsentStatus === "GRANTED" ||
        (await ensureWhatsappCallConsentForOutbound(id));
      if (!granted) {
        return NextResponse.json(
          {
            message:
              "Chamada de saída bloqueada: o cliente precisa aceitar o opt-in de chamada no WhatsApp (envie o template de permissão e aguarde).",
          },
          { status: 403 },
        );
      }
      const sessionSdp = parseSession(b.session);
      if (!sessionSdp) {
        return NextResponse.json(
          { message: "Informe session: { sdp_type, sdp } (SDP offer WebRTC)." },
          { status: 400 },
        );
      }
      const overrideTo = str(b.to).replace(/\D/g, "");
      const targets = await getContactWhatsAppTargets(conv.contactId);
      const toDigits = overrideTo.length >= 8 ? overrideTo : targets?.to;
      if (!toDigits) {
        return NextResponse.json(
          {
            message:
              "Contato sem telefone com código do país para chamada. Informe to (E.164 dígitos) ou cadastre o telefone.",
          },
          { status: 400 },
        );
      }
      const uid = session.user?.id;
      if (!uid) {
        return NextResponse.json({ message: "Sessão sem utilizador." }, { status: 401 });
      }
      const display =
        typeof session.user.name === "string" && session.user.name.trim()
          ? session.user.name.trim()
          : (session.user.email ?? "Agente");
      const bizOpaque = buildCallBizOpaquePayload(uid, display);
      try {
        const result = await metaClient.initiateVoiceCall(toDigits, sessionSdp, bizOpaque);
        const callId = result.calls?.[0]?.id?.trim() || "";
        if (callId) {
          try {
            const phoneNumberId = channelPhoneNumberId(conv.channelRef?.config);
            await prisma.whatsappCallEvent.create({
              data: withOrgFromCtx({
                metaCallId: callId,
                phoneNumberId: phoneNumberId || "unknown",
                direction: "BUSINESS_INITIATED",
                eventKind: "signaling",
                signalingStatus: "INITIATED",
                toWa: toDigits,
                conversationId: conv.id,
                contactId: conv.contactId,
                bizOpaque,
              }),
            });
          } catch (e) {
            console.warn("[whatsapp-calls] persist initiate:", e);
          }
        }
        return NextResponse.json(result);
      } catch (err) {
        const mapped = mapMetaWhatsappCallGraphError(err);
        return NextResponse.json({ message: mapped.message }, { status: mapped.status });
      }
    }

    const callId = str(b.call_id);
    if (!callId) {
      return NextResponse.json({ message: "call_id é obrigatório." }, { status: 400 });
    }

    if (action === "reject") {
      const result = await metaClient.rejectCall(callId);
      return NextResponse.json(result);
    }

    if (action === "terminate") {
      const result = await metaClient.terminateCall(callId);
      return NextResponse.json(result);
    }

    const sessionSdp = parseSession(b.session);
    if (!sessionSdp) {
      return NextResponse.json(
        { message: "Informe session: { sdp_type, sdp }." },
        { status: 400 },
      );
    }

    if (action === "pre_accept") {
      const result = await metaClient.preAcceptCall(callId, sessionSdp);
      return NextResponse.json(result);
    }

    if (action !== "accept") {
      return NextResponse.json({ message: "Combinação action/session inválida." }, { status: 400 });
    }

    const bizOpaque = str(b.biz_opaque_callback_data) || undefined;
    const result = await metaClient.acceptCall(callId, sessionSdp, bizOpaque);
    return NextResponse.json(result);
    } catch (e) {
      console.error(e);
      const mapped = mapMetaWhatsappCallGraphError(e);
      return NextResponse.json({ message: mapped.message }, { status: mapped.status });
    }
  });
}
