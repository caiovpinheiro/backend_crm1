import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import {
  inWebchatOrg,
  readJsonObject,
  rejectOversizedBody,
  webchatRateLimit,
} from "@/lib/webchat/http";
import {
  WebchatIdentifyError,
  identifyWebchatVisitor,
  ownVisitorContactView,
  parseWebchatIdentity,
} from "@/lib/webchat/identify";
import {
  authenticateWebchatVisitor,
  reissueWebchatToken,
  webchatError,
} from "@/lib/webchat/session";

const log = getLogger("api/public/webchat/identify");

/**
 * POST /api/public/webchat/session/identify  (Bearer do visitante)
 *
 * Body `{ name?, email?, phone? }` (ao menos um). Grava os dados no contato
 * do PRÓPRIO visitante; e-mail/telefone de outro contato da org vira nota
 * interna de "possível duplicado" na conversa — nunca liga nem funde (§3.2).
 * 200 → `{ contactId, merged: false, contact, token, expiresAt }` — só dados
 * do próprio visitante; o token é reemitido (o anterior vale na carência).
 */
export async function POST(request: Request) {
  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;
  const auth = await authenticateWebchatVisitor(request);
  if (!auth.ok) return auth.response;
  const { channel, session } = auth.visitor;

  const rl = await webchatRateLimit("POST /api/public/webchat/session/identify", [
    { profile: "webchat.message", scope: "visitor", id: session.id },
  ]);
  if (!rl.ok) return rl.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  try {
    const identity = parseWebchatIdentity(parsed.body);
    return await inWebchatOrg(channel.organizationId, async () => {
      const res = await identifyWebchatVisitor({
        organizationId: channel.organizationId,
        session,
        identity,
      });
      const { token, expiresAt } = await reissueWebchatToken(session, res.contactId);
      const contact = await ownVisitorContactView(session);
      return NextResponse.json(
        {
          contactId: contact?.id ?? null,
          merged: false,
          contact: contact
            ? {
                name: contact.name,
                email: contact.email,
                phone: contact.phone,
                identified: contact.identified,
              }
            : null,
          token,
          expiresAt: expiresAt.toISOString(),
        },
        { headers: rl.headers },
      );
    });
  } catch (err) {
    if (err instanceof WebchatIdentifyError) {
      return webchatError(400, "INVALID_BODY", err.message, rl.headers);
    }
    log.error({ err, visitorId: session.id }, "identify do webchat falhou");
    return NextResponse.json({ message: "Erro ao identificar o visitante." }, { status: 500 });
  }
}
