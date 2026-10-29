import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import {
  inWebchatOrg,
  readLimitedText,
  rejectOversizedBody,
  webchatRateLimit,
} from "@/lib/webchat/http";
import { authenticateWebchatVisitor, webchatError } from "@/lib/webchat/session";
import { markVisitorRead } from "@/lib/webchat/visitor-messages";

const log = getLogger("api/public/webchat/read");

/**
 * POST /api/public/webchat/read  (Bearer do visitante)
 *
 * Body opcional `{ upToMessageId? }` (id da `VisitorMessageDto`). Marca as
 * `out` até ela (sem ela, todas) como lidas → `message_status` "read" no
 * inbox. 200 → `{ ok: true, updated: number }`.
 */
export async function POST(request: Request) {
  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;
  const auth = await authenticateWebchatVisitor(request);
  if (!auth.ok) return auth.response;
  const { channel, session } = auth.visitor;

  const rl = await webchatRateLimit("POST /api/public/webchat/read", [
    { profile: "webchat.poll", scope: "visitor", id: session.id },
  ]);
  if (!rl.ok) return rl.response;

  let upToMessageId: string | null = null;
  const read = await readLimitedText(request);
  if (!read.ok) return read.response;
  const raw = read.text;
  if (raw.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return webchatError(400, "INVALID_JSON", "JSON inválido.", rl.headers);
    }
    const v = (body as Record<string, unknown> | null)?.upToMessageId;
    if (v !== undefined && v !== null) {
      if (typeof v !== "string" || !v || v.length > 64) {
        return webchatError(400, "INVALID_BODY", "upToMessageId inválido.", rl.headers);
      }
      upToMessageId = v;
    }
  }

  try {
    const updated = await inWebchatOrg(channel.organizationId, () =>
      markVisitorRead({
        organizationId: channel.organizationId,
        contactId: session.contactId,
        channelId: channel.id,
        upToMessageId,
      }),
    );
    return NextResponse.json({ ok: true, updated }, { headers: rl.headers });
  } catch (err) {
    log.error({ err, visitorId: session.id }, "read do webchat falhou");
    return NextResponse.json({ message: "Erro ao marcar como lidas." }, { status: 500 });
  }
}
