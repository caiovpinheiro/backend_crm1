/**
 * Token de embed do Cockpit IA.
 *
 * O cockpit (`deploy/cockpit-monitor`) roda num serviço nginx separado e é
 * embedado num iframe dentro da página "Agentes de IA" do CRM. No modo
 * standalone ele autentica com `X-Cockpit-Access` + `COCKPIT_ORGANIZATION_ID`
 * (ver `lib/cockpit-access.ts`), que é **single-tenant por design**: a org vem
 * de env fixa.
 *
 * Esse caminho NÃO pode ser usado no iframe dentro do CRM — qualquer usuário
 * de qualquer organização veria as métricas da org fixa. Por isso o modo
 * embedded usa um JWT curto emitido por
 * `GET /api/ai-agents/cockpit-embed-token`, que carrega o `orgId` da sessão do
 * usuário e é enviado como `Authorization: Bearer`.
 *
 * Segue o mesmo padrão de `services/widget-sso.ts` (jose, HS256, issuer
 * estável, TTL curto). O segredo é derivado com prefixo próprio para que
 * comprometer um token de cockpit não valha como token de widget, mesmo
 * quando ambos caem no mesmo material de segredo.
 */

import { SignJWT, decodeJwt, jwtVerify, errors as joseErrors } from "jose";

/** TTL curto — o frontend renova a cada 4 min (ver `useCockpitEmbedToken`). */
export const COCKPIT_EMBED_TTL_SECONDS = 300; // 5 min
/** Issuer estável — usado para reconhecer o token ANTES de verificar a
 *  assinatura, e assim não capturar por engano outros Bearer (API tokens
 *  `eduit_...`, JWT de widget SSO). */
const COCKPIT_EMBED_ISSUER = "crm-cockpit-embed";
const COCKPIT_EMBED_AUDIENCE = "cockpit-monitor";
/** Escopo único: leitura das métricas do cockpit. Não dá acesso a mais nada. */
export const COCKPIT_EMBED_SCOPE = "cockpit:read";

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * Resolve o segredo de assinatura, em ordem de preferência:
 *   1. `COCKPIT_EMBED_SECRET` — env dedicada (rotação independente).
 *   2. `WIDGET_SSO_SECRET` — já obrigatória em produção por causa do SSO de
 *      widgets, então o embed do cockpit não exige configuração nova.
 *   3. `AUTH_SECRET`/`NEXTAUTH_SECRET` — só fora de produção, pra não travar
 *      setup local.
 *
 * Sempre derivado com prefixo próprio: o material bruto nunca é reaproveitado
 * entre escopos diferentes.
 */
function getSecret(): Uint8Array {
  const explicit = process.env.COCKPIT_EMBED_SECRET;
  if (explicit && explicit.length >= 32) {
    return encode(explicit);
  }
  const widgetSecret = process.env.WIDGET_SSO_SECRET;
  if (widgetSecret && widgetSecret.length >= 32) {
    return encode(`cockpit-embed:${widgetSecret}`);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "COCKPIT_EMBED_SECRET ausente e WIDGET_SSO_SECRET ausente/curto (<32 chars) " +
        "em produção — impossível emitir token de embed do cockpit.",
    );
  }
  const fallback = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!fallback) {
    throw new Error(
      "Nem COCKPIT_EMBED_SECRET, nem WIDGET_SSO_SECRET, nem AUTH_SECRET definidos — " +
        "impossível emitir token de embed do cockpit.",
    );
  }
  return encode(`cockpit-embed:${fallback}`);
}

export interface CockpitEmbedPayload {
  /** Organização da sessão que abriu o cockpit. NUNCA vem do cliente. */
  orgId: string;
  /** Usuário do CRM que abriu — só para auditoria/rastreio. */
  userId: string;
}

export async function issueCockpitEmbedToken(
  payload: CockpitEmbedPayload,
): Promise<string> {
  const secret = getSecret();
  return new SignJWT({ ...payload, scope: COCKPIT_EMBED_SCOPE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(COCKPIT_EMBED_ISSUER)
    .setAudience(COCKPIT_EMBED_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${COCKPIT_EMBED_TTL_SECONDS}s`)
    .sign(secret);
}

export type CockpitEmbedRejectReason =
  | "expired"
  | "invalid_signature"
  | "invalid_payload";

export type CockpitEmbedVerification =
  /** Não é um token de embed — o caller deve seguir para os outros modos de auth. */
  | { kind: "none" }
  | { kind: "ok"; payload: CockpitEmbedPayload }
  /** É um token de embed (issuer confere) mas inválido — o caller deve
   *  responder 401 em vez de cair no fluxo de sessão, senão o cockpit recebe
   *  uma resposta confusa em vez de um sinal claro de "renove o token". */
  | { kind: "rejected"; reason: CockpitEmbedRejectReason };

/**
 * Verifica um Bearer como token de embed do cockpit.
 *
 * O `decodeJwt` (sem verificar assinatura) serve só para descobrir se o token
 * é *nosso*: qualquer coisa que não seja um JWT com nosso issuer devolve
 * `none` e segue o fluxo de autenticação existente. É isso que impede que os
 * API tokens `eduit_...` ou os JWT de widget SSO sejam capturados aqui.
 */
export async function verifyCockpitEmbedToken(
  token: string | undefined | null,
): Promise<CockpitEmbedVerification> {
  if (!token || typeof token !== "string") return { kind: "none" };

  try {
    const unverified = decodeJwt(token);
    if (unverified.iss !== COCKPIT_EMBED_ISSUER) return { kind: "none" };
  } catch {
    // Não é sequer um JWT (ex.: `eduit_...`).
    return { kind: "none" };
  }

  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: COCKPIT_EMBED_ISSUER,
      audience: COCKPIT_EMBED_AUDIENCE,
    });
    if (payload.scope !== COCKPIT_EMBED_SCOPE) {
      return { kind: "rejected", reason: "invalid_payload" };
    }
    const orgId = payload.orgId;
    const userId = payload.userId;
    if (typeof orgId !== "string" || !orgId || typeof userId !== "string" || !userId) {
      return { kind: "rejected", reason: "invalid_payload" };
    }
    return { kind: "ok", payload: { orgId, userId } };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) {
      return { kind: "rejected", reason: "expired" };
    }
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { kind: "rejected", reason: "invalid_signature" };
    }
    return { kind: "rejected", reason: "invalid_payload" };
  }
}
