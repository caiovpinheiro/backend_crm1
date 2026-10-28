import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { inWebchatOrg, readLimitedText, rejectOversizedBody, webchatRateLimit } from "@/lib/webchat/http";
import { isValidIdempotencyKey, parseWebchatS2SBody } from "@/lib/webchat/s2s/body";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  hashS2SBody,
  maybePurgeExpiredIngressKeys,
  type S2SResponseBody,
} from "@/lib/webchat/s2s/idempotency";
import { processWebchatS2SIngress, webchatConversationUrl } from "@/lib/webchat/s2s/ingress";
import { readWebchatSecret } from "@/lib/webchat/secrets";
import { loadWebchatChannelByKey, webchatError } from "@/lib/webchat/session";
import { verifyWebchatS2S } from "@/lib/webchat/signatures";

const log = getLogger("api/public/webchat/s2s");

const ROUTE = "POST /api/public/webchat/s2s/{publicKey}";

type Ctx = { params: Promise<{ publicKey: string }> };

/**
 * POST /api/public/webchat/s2s/{publicKey} — entrada servidor a servidor
 * (docs/decisoes/webchat-widget.md §9.6). Não é para browser: sem CORS.
 *
 * Headers: `X-Timestamp` (s Unix, ±300 s), `X-Signature: sha256=<hex>` =
 * HMAC-SHA256(segredo S2S, `${X-Timestamp}.${corpoCru}`), `Idempotency-Key`.
 * Corpo (≤ 32 KB): `{ external_id, ref?, category?, priority?, text?, fields?, links? }`.
 * 200 `{ conversation_id, url }` (repetição: o mesmo corpo + `Idempotent-Replayed: true`).
 * Erros `{ message, code }`: 404 CHANNEL_NOT_FOUND, 413, 429, 403 S2S_NOT_CONFIGURED,
 * 401 TIMESTAMP_EXPIRED | SIGNATURE_INVALID, 400 IDEMPOTENCY_KEY_INVALID |
 * INVALID_JSON | INVALID_BODY, 409 IDEMPOTENCY_KEY_REUSED | IDEMPOTENCY_IN_PROGRESS.
 */
export async function POST(request: Request, ctx: Ctx) {
  const { publicKey } = await ctx.params;
  const channel = await loadWebchatChannelByKey((publicKey ?? "").trim());
  if (!channel) return webchatError(404, "CHANNEL_NOT_FOUND", "Canal não encontrado.");

  const oversized = rejectOversizedBody(request);
  if (oversized) return oversized;

  const rl = await webchatRateLimit(ROUTE, [{ profile: "webchat.s2s", scope: "visitor", id: `ch:${channel.id}` }]);
  if (!rl.ok) return rl.response;
  const headers = { ...rl.headers, "Cache-Control": "no-store" };

  const read = await readLimitedText(request);
  if (!read.ok) return read.response;
  const rawBody = read.text;

  // Segredo lido do banco na hora (o canal em cache não carrega segredo).
  const secret = await inWebchatOrg(channel.organizationId, async () => {
    const row = await prisma.channel.findFirst({ where: { id: channel.id }, select: { config: true } });
    return row ? readWebchatSecret(row.config, "s2s") : null;
  });
  if (!secret) {
    return webchatError(403, "S2S_NOT_CONFIGURED", "Servidor a servidor não configurado neste canal.", headers);
  }

  const verified = verifyWebchatS2S({
    secret,
    timestamp: request.headers.get("x-timestamp"),
    signature: request.headers.get("x-signature"),
    rawBody,
  });
  if (!verified.ok) {
    return verified.code === "TIMESTAMP_EXPIRED"
      ? webchatError(401, "TIMESTAMP_EXPIRED", "X-Timestamp ausente ou fora da janela de 5 minutos.", headers)
      : webchatError(401, "SIGNATURE_INVALID", "Assinatura inválida.", headers);
  }

  const idemKey = request.headers.get("idempotency-key")?.trim() ?? null;
  if (!isValidIdempotencyKey(idemKey)) {
    return webchatError(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key ausente ou inválida.", headers);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return webchatError(400, "INVALID_JSON", "JSON inválido.", headers);
  }
  const parsed = parseWebchatS2SBody(json);
  if (!parsed.ok) return webchatError(400, "INVALID_BODY", parsed.message, headers);

  try {
    return await inWebchatOrg(channel.organizationId, async () => {
      await maybePurgeExpiredIngressKeys(channel.id);
      const claim = await claimIdempotencyKey({
        channelId: channel.id,
        key: idemKey,
        requestHash: hashS2SBody(rawBody),
      });
      if (claim.kind === "replay") {
        return NextResponse.json(claim.response, {
          headers: { ...headers, "Idempotent-Replayed": "true" },
        });
      }
      if (claim.kind === "reused") {
        return webchatError(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key já usada com outro corpo.", headers);
      }
      if (claim.kind === "in_progress") {
        return webchatError(
          409,
          "IDEMPOTENCY_IN_PROGRESS",
          "Pedido com esta Idempotency-Key ainda em processamento; tente de novo.",
          { ...headers, "Retry-After": "2" },
        );
      }
      try {
        const res = await processWebchatS2SIngress(channel, parsed.request);
        const body: S2SResponseBody = {
          conversation_id: res.conversationId,
          url: await webchatConversationUrl(channel.organizationId, res.conversationNumber),
        };
        await completeIdempotencyKey(claim.id, body);
        log.info(
          {
            channelId: channel.id,
            contactCreated: res.contactCreated,
            conversationCreated: res.conversationCreated,
            note: res.noteId !== null,
          },
          "entrada S2S do webchat processada",
        );
        return NextResponse.json(body, { headers });
      } catch (err) {
        await failIdempotencyKey(claim.id);
        throw err;
      }
    });
  } catch (err) {
    log.error({ err, channelId: channel.id }, "entrada S2S do webchat falhou");
    return NextResponse.json({ message: "Erro ao processar a entrada." }, { status: 500, headers });
  }
}
