import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getClientIp, inWebchatOrg, readJsonObject, webchatRateLimit } from "@/lib/webchat/http";
import {
  WebchatIdentifyError,
  hasIdentity,
  identifyWebchatVisitor,
  parseWebchatIdentity,
} from "@/lib/webchat/identify";
import { anonymousVisitorName } from "@/lib/webchat/inbound";
import { activeVisitorConversation } from "@/lib/webchat/visitor-messages";
import {
  checkWebchatOrigin,
  issueWebchatSession,
  loadWebchatChannelByKey,
  originDenied,
  reissueWebchatToken,
  sanitizeUrl,
  sanitizeUtm,
  webchatError,
} from "@/lib/webchat/session";
import { bearerFrom, verifyWebchatToken } from "@/lib/webchat/token";

const log = getLogger("api/public/webchat/session");
const ROUTE = "POST /api/public/webchat/session";

/**
 * POST /api/public/webchat/session
 *
 * Cria o visitante ou renova a sessão do Bearer (vencido vale se for o
 * último token emitido). Body:
 * `{ key, visitorId?, name?, email?, phone?, page?, referrer?, utm?, host? }`.
 * Com nome/e-mail/telefone (pré-chat) já identifica (§3.2). Abrir o chat não
 * cria contato: `contactId` fica null até a 1ª mensagem ou a identificação.
 *
 * 200 → `{ token, expiresAt, visitorId, contactId, conversation, contact, renewed, merged? }`
 * (`contact` = `{ name, email, phone, identified }` ou null sem contato).
 */
export async function POST(request: Request) {
  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!key) return webchatError(400, "INVALID_KEY", "key ausente.");
  const channel = await loadWebchatChannelByKey(key);
  if (!channel) return webchatError(404, "CHANNEL_NOT_FOUND", "Chat não encontrado.");
  const host = typeof b.host === "string" ? b.host : null;
  if (!checkWebchatOrigin(request, channel.config, host)) return originDenied();

  // Renovação (Bearer autêntico) gasta do visitante; visitante novo, do IP.
  const prior = await verifyWebchatToken(bearerFrom(request), { allowExpired: true });
  const rl = prior.ok
    ? await webchatRateLimit(ROUTE, [{ profile: "webchat.poll", scope: "visitor", id: prior.claims.vis }])
    : await webchatRateLimit(ROUTE, [
        { profile: "webchat.session", scope: "ip", id: getClientIp(request) },
      ]);
  if (!rl.ok) return rl.response;

  let identity;
  try {
    identity = parseWebchatIdentity({ name: b.name, email: b.email, phone: b.phone });
  } catch (err) {
    if (err instanceof WebchatIdentifyError) {
      return webchatError(400, "INVALID_BODY", err.message, rl.headers);
    }
    throw err;
  }

  try {
    return await inWebchatOrg(channel.organizationId, async () => {
      const issued = await issueWebchatSession({
        request,
        channel,
        page: sanitizeUrl(b.page),
        referrer: sanitizeUrl(b.referrer),
        utm: sanitizeUtm(b.utm),
      });
      let { token, expiresAt } = issued;
      const session = issued.session;
      let merged: boolean | undefined;
      if (hasIdentity(identity)) {
        const before = session.contactId;
        const res = await identifyWebchatVisitor({
          organizationId: channel.organizationId,
          session,
          identity,
        });
        merged = res.merged;
        if (res.contactId !== before) {
          ({ token, expiresAt } = await reissueWebchatToken(session, res.contactId));
        }
      }
      const conversation = await activeVisitorConversation(session.contactId, channel.id);
      const row = session.contactId
        ? await prisma.contact.findUnique({
            where: { id: session.contactId },
            select: { name: true, email: true, phone: true },
          })
        : null;
      // "Identificado" = deu e-mail/telefone ou um nome que não é o placeholder.
      const contact = row
        ? {
            name: row.name,
            email: row.email,
            phone: row.phone,
            identified:
              Boolean(row.email || row.phone) || row.name !== anonymousVisitorName(session.id),
          }
        : null;
      return NextResponse.json(
        {
          token,
          expiresAt: expiresAt.toISOString(),
          visitorId: session.id,
          contactId: session.contactId,
          conversation,
          contact,
          renewed: issued.renewed,
          ...(merged !== undefined ? { merged } : {}),
        },
        { headers: { ...rl.headers, "Cache-Control": "no-store" } },
      );
    });
  } catch (err) {
    log.error({ err, channelId: channel.id }, "sessão do webchat falhou");
    return NextResponse.json({ message: "Erro ao abrir o chat." }, { status: 500 });
  }
}
