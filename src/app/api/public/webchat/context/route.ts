import { NextResponse } from "next/server";

import { sanitizeContextPatch, writeLiveContext } from "@/lib/webchat/live-context";
import {
  getClientIp,
  inWebchatOrg,
  readJsonObject,
  rejectOversizedBody,
  webchatRateLimit,
} from "@/lib/webchat/http";
import { webchatError } from "@/lib/webchat/session";
import { authenticateTrackingVisitor, resolveTrackingAccess } from "@/lib/webchat/tracking/access";
import { publishWebchatContextChange } from "@/lib/webchat/tracking/realtime";

const ROUTE = "POST /api/public/webchat/context";

/**
 * POST /api/public/webchat/context  (Bearer do visitante)
 *
 * `BwipoWebchat.setContext` — estado atual do visitante no site
 * (docs/decisoes/webchat-widget.md §9.3). Corpo `{ context: { chave: valor } }`:
 * merge raso sobre o gravado, `null` remove a chave, limites do canal
 * (`maxKeys`/`maxValueChars`). Envio idêntico não muda `updatedAt`.
 *
 * 200 `{ ok: true, updatedAt, ignored: string[] }`; 403 `TRACKING_DISABLED`
 * sem identify assinado (salvo canal com `context.anonymous`).
 */
export async function POST(request: Request) {
  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const ipLimit = await webchatRateLimit(ROUTE, [
    { profile: "webchat.track.ip", scope: "ip", id: getClientIp(request) },
  ]);
  if (!ipLimit.ok) return ipLimit.response;

  const auth = await authenticateTrackingVisitor(request);
  if (!auth.ok) return auth.response;
  const { channel, session } = auth.visitor;

  const rl = await webchatRateLimit(ROUTE, [
    { profile: "webchat.context", scope: "visitor", id: session.id },
  ]);
  if (!rl.ok) return rl.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const patch = sanitizeContextPatch(parsed.body.context, {
    maxValueChars: channel.v2.context.maxValueChars,
  });
  if (!patch) {
    return webchatError(400, "INVALID_BODY", "Envie { context: { chave: valor } }.");
  }

  const access = await resolveTrackingAccess(auth.visitor);
  if (!access.ok) return access.response;

  const result = await inWebchatOrg(channel.organizationId, () =>
    writeLiveContext({
      channelId: channel.id,
      owner: access.owner,
      patch,
      maxKeys: channel.v2.context.maxKeys,
    }),
  );
  if (result.changed) {
    publishWebchatContextChange({
      organizationId: channel.organizationId,
      channelId: channel.id,
      contactId: access.contactId,
      state: result.state,
      updatedAt: result.updatedAt,
    });
  }

  return NextResponse.json(
    { ok: true, updatedAt: result.updatedAt.toISOString(), ignored: result.ignored },
    { headers: rl.headers },
  );
}
