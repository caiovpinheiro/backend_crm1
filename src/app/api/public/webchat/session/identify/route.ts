import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import {
  inWebchatOrg,
  readJsonObject,
  rejectOversizedBody,
  webchatRateLimit,
} from "@/lib/webchat/http";
import { prisma } from "@/lib/prisma";
import {
  WebchatIdentifyError,
  hasIdentity,
  identifyWebchatVisitor,
  ownVisitorContactView,
  parseWebchatIdentity,
} from "@/lib/webchat/identify";
import {
  checkWebchatSignature,
  hasSignedIdentifyFields,
  identifySignedWebchatVisitor,
  type WebchatSignatureCheck,
} from "@/lib/webchat/identify-signed";
import { isVerifiedSessionContact } from "@/lib/webchat/inbound";
import { readWebchatSecret } from "@/lib/webchat/secrets";
import {
  authenticateWebchatVisitor,
  reissueWebchatToken,
  webchatError,
} from "@/lib/webchat/session";

const log = getLogger("api/public/webchat/identify");

/**
 * POST /api/public/webchat/session/identify  (Bearer do visitante)
 *
 * v1 — body `{ name?, email?, phone? }` (ao menos um): grava no contato do
 * PRÓPRIO visitante; e-mail/telefone de outro contato vira nota interna de
 * "possível duplicado" — nunca liga nem funde (§3.2).
 *
 * v2 (§9.4) — `{ externalId, userHash, attributes?, name?, email?, phone? }`:
 * com `userHash = hex(HMAC-SHA256(segredo de identidade, externalId))`
 * válido a sessão passa para o contato com esse `externalId` (campo de
 * match do canal) e `identityVerifiedAt` é gravado. Assinatura inválida,
 * ausente ou canal sem segredo: não verificada — `externalId`/`attributes`
 * ignorados e `name/email/phone` seguem a regra v1.
 *
 * 200 → `{ contactId, merged: false, contact, token, expiresAt, verified, reason? }`
 * — só dados do próprio visitante (ou do identificado); o token é reemitido
 * (o anterior vale na carência).
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
  const body = parsed.body;

  try {
    const identity = parseWebchatIdentity(body);
    const signed = hasSignedIdentifyFields(body);
    if (!signed && !hasIdentity(identity)) {
      throw new WebchatIdentifyError("Informe nome, e-mail ou telefone.");
    }
    return await inWebchatOrg(channel.organizationId, async () => {
      let check: WebchatSignatureCheck | null = null;
      if (signed) {
        // Segredo lido do banco na hora (o canal em cache não o carrega).
        const row = await prisma.channel.findFirst({
          where: { id: channel.id },
          select: { config: true },
        });
        check = checkWebchatSignature({
          identitySecret: readWebchatSecret(row?.config, "identity"),
          externalId: body.externalId,
          userHash: body.userHash,
        });
      }

      let contactId: string | null = session.contactId;
      if (check?.verified) {
        const res = await identifySignedWebchatVisitor({
          organizationId: channel.organizationId,
          session,
          config: channel.v2,
          externalId: check.externalId,
          identity,
          attributes: body.attributes,
        });
        contactId = res.contactId;
      } else if (hasIdentity(identity)) {
        const res = await identifyWebchatVisitor({
          organizationId: channel.organizationId,
          session,
          identity,
        });
        contactId = res.contactId;
      }

      const { token, expiresAt } = await reissueWebchatToken(session, contactId);
      const contact = await ownVisitorContactView(session);
      const verified = check ? check.verified : await isVerifiedSessionContact(session);
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
          verified,
          ...(check && !check.verified ? { reason: check.reason } : {}),
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
