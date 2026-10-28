import { NextResponse } from "next/server";

import {
  getClientIp,
  inWebchatOrg,
  readLimitedText,
  rejectOversizedBody,
  webchatRateLimit,
} from "@/lib/webchat/http";
import { webchatError } from "@/lib/webchat/session";
import { authenticateTrackingVisitor, resolveTrackingAccess } from "@/lib/webchat/tracking/access";
import { sanitizeWebchatEventBatch } from "@/lib/webchat/tracking/events";
import { publishWebchatEventsAdded } from "@/lib/webchat/tracking/realtime";
import { noteImportantWebchatEvents, recordWebchatEvents } from "@/lib/webchat/tracking/record";

const ROUTE = "POST /api/public/webchat/events";

/**
 * POST /api/public/webchat/events  (Bearer do visitante ou `token` no corpo)
 *
 * `BwipoWebchat.track` em lote (docs/decisoes/webchat-widget.md §9.3).
 * Corpo `{ events: WebchatTrackEvent[], token?: string }` em
 * `application/json` ou `text/plain` — `navigator.sendBeacon` não manda
 * header, por isso o token pode vir no corpo (o Bearer vence se vierem os
 * dois). Lote acima de `events.maxPerBatch` → 400 `TOO_MANY_EVENTS`;
 * evento inválido é ignorado com o motivo.
 *
 * 200 `{ ok: true, accepted, ignored: { index, reason }[] }`.
 */
export async function POST(request: Request) {
  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const ipLimit = await webchatRateLimit(ROUTE, [
    { profile: "webchat.track.ip", scope: "ip", id: getClientIp(request) },
  ]);
  if (!ipLimit.ok) return ipLimit.response;

  const read = await readLimitedText(request);
  if (!read.ok) return read.response;
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return webchatError(400, "INVALID_JSON", "JSON inválido.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return webchatError(400, "INVALID_BODY", "Corpo deve ser um objeto JSON.");
  }
  const payload = body as Record<string, unknown>;

  const auth = await authenticateTrackingVisitor(request, payload.token);
  if (!auth.ok) return auth.response;
  const { channel, session } = auth.visitor;

  const rl = await webchatRateLimit(ROUTE, [
    { profile: "webchat.track", scope: "visitor", id: session.id },
  ]);
  if (!rl.ok) return rl.response;

  const batch = sanitizeWebchatEventBatch(payload.events, {
    maxPerBatch: channel.v2.events.maxPerBatch,
    maxValueChars: channel.v2.context.maxValueChars,
  });
  if (!batch.ok) {
    return batch.code === "TOO_MANY_EVENTS"
      ? webchatError(
          400,
          "TOO_MANY_EVENTS",
          `No máximo ${channel.v2.events.maxPerBatch} eventos por envio.`,
        )
      : webchatError(400, "INVALID_BODY", "Envie { events: [...] }.");
  }

  const access = await resolveTrackingAccess(auth.visitor);
  if (!access.ok) return access.response;

  const recorded = await inWebchatOrg(channel.organizationId, async () => {
    const events = await recordWebchatEvents({
      channelId: channel.id,
      owner: access.owner,
      events: batch.events,
      config: channel.v2,
    });
    await noteImportantWebchatEvents({
      organizationId: channel.organizationId,
      channelId: channel.id,
      contactId: access.contactId,
      events,
      config: channel.v2,
    });
    return events;
  });
  publishWebchatEventsAdded({
    organizationId: channel.organizationId,
    channelId: channel.id,
    contactId: access.contactId,
    events: recorded,
  });

  return NextResponse.json(
    { ok: true, accepted: recorded.length, ignored: batch.ignored },
    { headers: rl.headers },
  );
}
