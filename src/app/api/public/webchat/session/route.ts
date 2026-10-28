import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import {
  getClientIp,
  inWebchatOrg,
  readJsonObject,
  webchatRateLimit,
} from "@/lib/webchat/http";
import {
  WebchatIdentifyError,
  hasIdentity,
  identifyWebchatVisitor,
  ownVisitorContactView,
  parseWebchatIdentity,
} from "@/lib/webchat/identify";
import { activeVisitorConversation } from "@/lib/webchat/visitor-messages";
import {
  checkWebchatOrigin,
  findRenewableWebchatSession,
  issueWebchatSession,
  loadWebchatChannelByKey,
  originDenied,
  reissueWebchatToken,
  sanitizeUrl,
  sanitizeUtm,
  webchatError,
} from "@/lib/webchat/session";

const log = getLogger("api/public/webchat/session");
const ROUTE = "POST /api/public/webchat/session";

/**
 * POST /api/public/webchat/session
 *
 * Cria o visitante ou renova a sessão do Bearer (vencido vale se for o
 * último token emitido — ou o anterior na carência de 60 s — e a sessão não
 * passou da vida máxima). Body:
 * `{ key, visitorId?, name?, email?, phone?, page?, referrer?, utm?, host? }`.
 * Com nome/e-mail/telefone (pré-chat) já identifica (§3.2) — sempre no
 * contato do próprio visitante. Abrir o chat não cria contato: `contactId`
 * fica null até a 1ª mensagem ou a identificação.
 *
 * Rate limit: visitante NOVO sempre gasta do balde de criação por IP (IPv6
 * por /64); o balde do visitante só vale quando a renovação é de fato
 * possível (token autêntico E aceito pela sessão). Antes, qualquer token
 * com assinatura válida — mesmo velho — desviava para o balde do visitante
 * e criava visitante novo a cada chamada sem tocar no limite por IP.
 *
 * 200 → `{ token, expiresAt, visitorId, contactId, conversation, contact, renewed, merged? }`
 * (`contact` = `{ name, email, phone, identified }` do próprio visitante ou
 * null; `merged` é sempre false — mantido para o widget antigo).
 */
export async function POST(request: Request) {
  // Teto de corpo (Content-Length e leitura cortada) antes de parsear.
  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const key = typeof b.key === "string" ? b.key.trim() : "";
  if (!key) return webchatError(400, "INVALID_KEY", "key ausente.");
  const channel = await loadWebchatChannelByKey(key);
  if (!channel) return webchatError(404, "CHANNEL_NOT_FOUND", "Chat não encontrado.");
  const host = typeof b.host === "string" ? b.host : null;
  if (!checkWebchatOrigin(request, channel.config, host)) return originDenied();

  // Só leitura: decide o balde antes de gravar qualquer coisa.
  const renewable = await findRenewableWebchatSession(request, channel);
  const rl = renewable
    ? await webchatRateLimit(ROUTE, [{ profile: "webchat.poll", scope: "visitor", id: renewable.id }])
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
        renewable,
        page: sanitizeUrl(b.page),
        referrer: sanitizeUrl(b.referrer),
        utm: sanitizeUtm(b.utm),
      });
      let { token, expiresAt } = issued;
      const session = issued.session;
      let identified = false;
      if (hasIdentity(identity)) {
        const before = session.contactId;
        const res = await identifyWebchatVisitor({
          organizationId: channel.organizationId,
          session,
          identity,
        });
        identified = true;
        if (res.contactId !== before) {
          ({ token, expiresAt } = await reissueWebchatToken(session, res.contactId));
        }
      }
      const contact = await ownVisitorContactView(session);
      const conversation = contact
        ? await activeVisitorConversation(contact.id, channel.id)
        : null;
      return NextResponse.json(
        {
          token,
          expiresAt: expiresAt.toISOString(),
          visitorId: session.id,
          contactId: contact?.id ?? null,
          conversation,
          contact: contact
            ? {
                name: contact.name,
                email: contact.email,
                phone: contact.phone,
                identified: contact.identified,
              }
            : null,
          renewed: issued.renewed,
          ...(identified ? { merged: false } : {}),
        },
        { headers: { ...rl.headers, "Cache-Control": "no-store" } },
      );
    });
  } catch (err) {
    log.error({ err, channelId: channel.id }, "sessão do webchat falhou");
    return NextResponse.json({ message: "Erro ao abrir o chat." }, { status: 500 });
  }
}
