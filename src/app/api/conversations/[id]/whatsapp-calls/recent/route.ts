import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { classifyWhatsappCallEnd, wasWhatsappCallPickedUp } from "@/lib/whatsapp-call-chat";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/conversations/[id]/whatsapp-calls/recent");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Histórico compactado de chamadas WhatsApp Business agrupado por
 * `metaCallId`. Ao contrário do `GET /whatsapp-calls` (que devolve
 * eventos brutos do webhook — pre_accept, accept, terminate…), este
 * endpoint devolve **uma linha por chamada** com:
 *
 * - direção real (USER_INITIATED ou BUSINESS_INITIATED)
 * - startedAt (primeiro evento do callId, geralmente connect/pre_accept)
 * - endedAt (terminate, se houve)
 * - durationSec
 * - status: ringing | completed | failed | rejected
 * - recordingUrl: URL da gravação (Message.mediaUrl onde
 *   externalId='call_timeline:{callId}'). Pode ser:
 *     · gravação client-side via WebRTC SDK (`/uploads/call-recordings/...`)
 *     · gravação server-side via Meta (raro — Meta não envia recording_url
 *       por padrão).
 *
 * Usado pelo `WhatsappCallChip` no header do chat para mostrar histórico
 * recente sem poluir o chat com bolhas redundantes.
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
      return NextResponse.json({ items: [] });
    }

    const url = new URL(request.url);
    const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "5", 10);
    const limit = Math.min(20, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 5));

    // Pegamos um pouco mais de eventos (limit * 6) porque uma única chamada
    // pode emitir 2–6 eventos. O agrupamento posterior reduz pra `limit`
    // chamadas distintas.
    const events = await prisma.whatsappCallEvent.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "desc" },
      take: limit * 6,
      select: {
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

    type CallAggregate = {
      callId: string;
      direction: string;
      startedAt: Date | null;
      endedAt: Date | null;
      durationSec: number | null;
      status: "ringing" | "completed" | "failed" | "rejected";
      lastEventAt: Date;
      signalingStatuses: string[];
    };

    const byCall = new Map<string, CallAggregate>();
    for (const ev of events) {
      const existing = byCall.get(ev.metaCallId);
      const baseStart = ev.startTime ?? null;
      const baseEnd = ev.endTime ?? null;
      const signalingStatuses = [
        ...(existing?.signalingStatuses ?? []),
        ...(ev.signalingStatus ? [ev.signalingStatus] : []),
      ];

      let status: CallAggregate["status"] = existing?.status ?? "ringing";
      if (ev.eventKind === "terminate") {
        const pickedUp = wasWhatsappCallPickedUp({
          durationSec: ev.durationSec ?? existing?.durationSec,
          startTime: baseStart ?? existing?.startedAt,
          endTime: baseEnd ?? existing?.endedAt,
          signalingStatuses,
        });
        const rejected = signalingStatuses.some((s) => s.toUpperCase() === "REJECTED");
        const outcome = classifyWhatsappCallEnd({
          terminateStatus: ev.terminateStatus ?? "",
          pickedUp,
          rejected,
        });
        status =
          outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "rejected";
      }

      const merged: CallAggregate = {
        callId: ev.metaCallId,
        direction: existing?.direction ?? ev.direction,
        startedAt:
          baseStart ??
          existing?.startedAt ??
          (ev.eventKind === "connect" ? ev.createdAt : null),
        endedAt:
          baseEnd ?? existing?.endedAt ?? (ev.eventKind === "terminate" ? ev.createdAt : null),
        durationSec: ev.durationSec ?? existing?.durationSec ?? null,
        status,
        lastEventAt:
          existing && existing.lastEventAt > ev.createdAt ? existing.lastEventAt : ev.createdAt,
        signalingStatuses,
      };

      byCall.set(ev.metaCallId, merged);
    }

    const aggregates = Array.from(byCall.values())
      .sort((a, b) => b.lastEventAt.getTime() - a.lastEventAt.getTime())
      .slice(0, limit);

    if (aggregates.length === 0) {
      return NextResponse.json({ items: [] });
    }

    // Cruza com Message para pegar URL de gravação. ExternalId padrão
    // é `call_timeline:{callId}` (definido no webhook e no upload
    // WebRTC). Faz um único findMany.
    const externalIds = aggregates.map((a) => `call_timeline:${a.callId}`);
    const recordings = await prisma.message.findMany({
      where: {
        conversationId: id,
        messageType: "whatsapp_call_recording",
        externalId: { in: externalIds },
      },
      select: { externalId: true, mediaUrl: true },
    });
    const recordingByCallId = new Map<string, string>();
    for (const r of recordings) {
      if (!r.externalId || !r.mediaUrl) continue;
      const callId = r.externalId.replace(/^call_timeline:/, "");
      if (callId) recordingByCallId.set(callId, r.mediaUrl);
    }

    const items = aggregates.map((a) => ({
      callId: a.callId,
      direction: a.direction, // BUSINESS_INITIATED | USER_INITIATED
      startedAt: a.startedAt?.toISOString() ?? null,
      endedAt: a.endedAt?.toISOString() ?? null,
      durationSec: a.durationSec,
      status: a.status,
      recordingUrl: recordingByCallId.get(a.callId) ?? null,
    }));

    return NextResponse.json({ items });
    } catch (e) {
      log.error({ err: e }, "[whatsapp-calls/recent] falhou");
      return NextResponse.json({ message: "Erro ao listar chamadas." }, { status: 500 });
    }
  });
}
