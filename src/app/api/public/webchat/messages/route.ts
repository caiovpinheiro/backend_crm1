import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import { WEBCHAT_MAX_CONTENT_CHARS } from "@/lib/webchat/config";
import {
  getClientIp,
  inWebchatOrg,
  readJsonObject,
  rejectOversizedBody,
  webchatRateLimit,
} from "@/lib/webchat/http";
import { isValidClientMessageId, processWebchatInbound } from "@/lib/webchat/inbound";
import { authenticateWebchatVisitor, webchatError } from "@/lib/webchat/session";
import {
  listVisitorMessages,
  resolveVisitorCursor,
  type VisitorMessageDto,
} from "@/lib/webchat/visitor-messages";

const log = getLogger("api/public/webchat/messages");

/**
 * GET /api/public/webchat/messages[?after=<cursor>]  (Bearer do visitante)
 *
 * Sem `after`: as últimas 50 mensagens de chat dos tickets webchat do
 * visitante (ordem cronológica). Com `after` (cursor devolvido, ou o `id` da
 * última mensagem): as seguintes (polling). `out` devolvidas passam de
 * sent → delivered.
 * 200 → `{ messages, cursor, hasMore, agentTyping, agentReadAt }`.
 */
export async function GET(request: Request) {
  const auth = await authenticateWebchatVisitor(request);
  if (!auth.ok) return auth.response;
  const { channel, session } = auth.visitor;

  const rl = await webchatRateLimit("GET /api/public/webchat/messages", [
    { profile: "webchat.poll", scope: "visitor", id: session.id },
  ]);
  if (!rl.ok) return rl.response;

  const afterRaw = new URL(request.url).searchParams.get("after") || null;

  try {
    const page = await inWebchatOrg(channel.organizationId, async () => {
      const after = await resolveVisitorCursor(afterRaw, session.contactId, channel.id);
      if (after === undefined) return null;
      return listVisitorMessages({
        organizationId: channel.organizationId,
        visitorId: session.id,
        contactId: session.contactId,
        channelId: channel.id,
        after,
        afterRaw,
      });
    });
    if (!page) return webchatError(400, "INVALID_BODY", "Cursor inválido.", rl.headers);
    return NextResponse.json(page, { headers: { ...rl.headers, "Cache-Control": "no-store" } });
  } catch (err) {
    log.error({ err, visitorId: session.id }, "GET messages do webchat falhou");
    return NextResponse.json({ message: "Erro ao carregar mensagens." }, { status: 500 });
  }
}

/**
 * POST /api/public/webchat/messages  (Bearer do visitante)
 *
 * Body `{ clientMessageId, content }` — texto até 4000 chars;
 * `clientMessageId` `[A-Za-z0-9_-]{1,64}` gerado pelo widget. Idempotente
 * por `externalId = "wc:{visitorId}:{clientMessageId}"`.
 * 201 (nova) / 200 (repetida) → `{ message, conversationId, contactId, duplicate }`.
 */
export async function POST(request: Request) {
  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;
  const auth = await authenticateWebchatVisitor(request);
  if (!auth.ok) return auth.response;
  const { channel, session } = auth.visitor;

  const rl = await webchatRateLimit("POST /api/public/webchat/messages", [
    { profile: "webchat.message", scope: "visitor", id: session.id },
    { profile: "webchat.message.ip", scope: "ip", id: getClientIp(request) },
  ]);
  if (!rl.ok) return rl.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const { clientMessageId, content: rawContent } = parsed.body;
  if (!isValidClientMessageId(clientMessageId)) {
    return webchatError(400, "INVALID_BODY", "clientMessageId inválido.", rl.headers);
  }
  const content = typeof rawContent === "string" ? rawContent.replace(/\u0000/g, "").trim() : "";
  if (!content) return webchatError(400, "INVALID_BODY", "Mensagem vazia.", rl.headers);
  if (content.length > WEBCHAT_MAX_CONTENT_CHARS) {
    return webchatError(
      400,
      "CONTENT_TOO_LONG",
      `Mensagem passa de ${WEBCHAT_MAX_CONTENT_CHARS} caracteres.`,
      rl.headers,
    );
  }

  try {
    const res = await inWebchatOrg(channel.organizationId, () =>
      processWebchatInbound({
        organizationId: channel.organizationId,
        channelId: channel.id,
        session,
        clientMessageId,
        content,
      }),
    );
    const message: VisitorMessageDto = {
      id: res.message.id,
      clientMessageId,
      direction: "in",
      content: res.message.content,
      messageType: "text",
      mediaUrl: null,
      createdAt: res.message.createdAt.toISOString(),
      senderName: null,
      authorType: "human",
      status: null,
    };
    return NextResponse.json(
      {
        message,
        conversationId: res.conversationId,
        contactId: res.contactId || session.contactId,
        duplicate: res.duplicate,
      },
      { status: res.duplicate ? 200 : 201, headers: rl.headers },
    );
  } catch (err) {
    log.error({ err, visitorId: session.id, channelId: channel.id }, "inbound do webchat falhou");
    return NextResponse.json({ message: "Erro ao enviar mensagem." }, { status: 500 });
  }
}
