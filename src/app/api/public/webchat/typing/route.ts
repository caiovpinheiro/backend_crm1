import { NextResponse } from "next/server";

import { publishTypingEvent } from "@/lib/realtime-events";
import {
  inWebchatOrg,
  readLimitedText,
  rejectOversizedBody,
  webchatRateLimit,
} from "@/lib/webchat/http";
import { authenticateWebchatVisitor } from "@/lib/webchat/session";
import { activeVisitorConversation } from "@/lib/webchat/visitor-messages";

/**
 * POST /api/public/webchat/typing  (Bearer do visitante)
 *
 * Body opcional `{ typing?: boolean }` (ausente = true). "Visitante
 * digitando…" no inbox: `typing` com `source: "contact"`. `typing: false`
 * não publica (o indicador expira sozinho no `until`). Sem ticket aberto
 * não há onde mostrar — responde igual.
 * 200 → `{ ok: true, published: boolean }`.
 */
export async function POST(request: Request) {
  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;
  const auth = await authenticateWebchatVisitor(request);
  if (!auth.ok) return auth.response;
  const { channel, session } = auth.visitor;

  const rl = await webchatRateLimit("POST /api/public/webchat/typing", [
    { profile: "webchat.poll", scope: "visitor", id: session.id },
  ]);
  if (!rl.ok) return rl.response;

  let typing = true;
  const read = await readLimitedText(request);
  if (!read.ok) return read.response;
  const raw = read.text;
  if (raw.trim()) {
    try {
      const body = JSON.parse(raw) as Record<string, unknown> | null;
      if (body && body.typing === false) typing = false;
    } catch {
      /* corpo inválido: trata como "digitando" (endpoint cosmético) */
    }
  }
  if (!typing) return NextResponse.json({ ok: true, published: false }, { headers: rl.headers });

  const conv = await inWebchatOrg(channel.organizationId, () =>
    activeVisitorConversation(session.contactId, channel.id),
  );
  let published = false;
  if (conv) {
    try {
      published = publishTypingEvent({
        organizationId: channel.organizationId,
        conversationId: conv.id,
        contactId: session.contactId,
        userId: null,
        source: "contact",
      });
    } catch {
      /* best-effort */
    }
  }
  return NextResponse.json({ ok: true, published }, { headers: rl.headers });
}
