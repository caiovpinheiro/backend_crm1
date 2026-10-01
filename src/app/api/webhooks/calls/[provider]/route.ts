/**
 * POST /api/webhooks/calls/[provider]
 *
 * Endpoint PÚBLICO (sem sessão) para receber eventos de chamada do provedor SIP.
 *
 * ── Resolução multi-tenant ──────────────────────────────────────────────────
 * O caller não tem sessão HTTP. A org é resolvida pelo `webhookToken` único
 * (query param `?token=<webhookToken>` ou header `X-Webhook-Token`).
 *
 * O serviço `processWebhookEvent` encapsula toda a lógica multi-tenant:
 *  1. Busca CallProviderConfig via prismaBase (sem Prisma extension) pelo token.
 *  2. Valida autenticidade (HMAC ou TOKEN) — falha retorna 401.
 *  3. Usa runWithContext({ organizationId }) para ativar o RequestContext com o
 *     orgId real — a Prisma extension (SCOPED_MODELS) injeta organizationId
 *     automaticamente em todas as queries tenant-scoped do restante do fluxo.
 *
 * ── Segurança ────────────────────────────────────────────────────────────────
 * - Autenticidade validada ANTES de gravar (sem escrita em auth inválida).
 * - 200 rápido em erros pós-validação — provedores SIP fazem retry em timeouts.
 * - 401 apenas em falha de autenticidade (token inválido / HMAC incorreto).
 */
import { NextResponse } from "next/server";

import { processWebhookEvent } from "@/services/calls";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/webhooks/calls/[provider]");

type RouteContext = { params: Promise<{ provider: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { provider } = await context.params;

  // ── 1. Extrair token ─────────────────────────────────────────────────────
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ??
    request.headers.get("x-webhook-token") ??
    "";

  if (!token) {
    return NextResponse.json(
      { message: "Token ausente. Use ?token=<webhookToken> ou header X-Webhook-Token." },
      { status: 401 },
    );
  }

  // ── 2. Ler rawBody ANTES do JSON.parse (necessário para HMAC) ───────────
  let rawBody: string;
  let rawPayload: unknown;
  try {
    rawBody = await request.text();
    rawPayload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ message: "Payload inválido: JSON esperado." }, { status: 400 });
  }

  // ── 3. Extrair header de assinatura HMAC ─────────────────────────────────
  // O header configurado em CallProviderConfig.signatureHeader varia por provedor.
  // Pré-extraímos os mais comuns; processWebhookEvent usa o configurado.
  const signatureHeader =
    request.headers.get("x-signature-256") ??
    request.headers.get("x-hub-signature-256") ??
    request.headers.get("x-signature") ??
    request.headers.get("x-hook-signature") ??
    null;

  // ── 4. Processar ─────────────────────────────────────────────────────────
  // processWebhookEvent resolve a org internamente (prismaBase → webhookToken),
  // valida autenticidade, e roda o restante em withResolvedContext com o orgId.
  // Retorna { ok: false, reason } em vez de lançar — auth errors == 401.
  const result = await processWebhookEvent({
    provider,
    webhookToken: token,
    rawPayload,
    signatureHeader,
    rawBody,
  });

  // ── 5. Resposta ──────────────────────────────────────────────────────────
  if (!result.ok) {
    const isAuthError =
      result.reason === "hmac_invalid" ||
      result.reason === "hmac_signature_missing" ||
      result.reason === "token_not_found_or_inactive";

    if (isAuthError) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    // Erros pós-auth (normalização, etc.): 200 para evitar retry em loop.
    log.warn({ provider, reason: result.reason }, "[webhooks/calls] Processamento parcial");
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 200 });
  }

  return NextResponse.json({ ok: true, callId: result.callId }, { status: 200 });
}
