/**
 * Token do visitante do webchat (docs/decisoes/webchat-widget.md §3.2).
 *
 * JWT HS256, claims `{ org, ch, vis, cid }`, validade 30 dias. Segredo:
 * `WEBCHAT_JWT_SECRET` (≥ 32 chars); sem ele, derivado do `AUTH_SECRET`
 * com HMAC e rótulo próprio (o token do widget nunca vale como sessão do
 * CRM e vice-versa). O sha256 do token fica em `WebchatSession.tokenHash`:
 * só o último token emitido para a sessão é aceito (revogação = trocar o
 * hash).
 *
 * `cid` é informativo: o contato da sessão sempre sai do banco (o merge da
 * identificação troca o contato sem invalidar o token).
 */
import { createHash, createHmac } from "node:crypto";

import { SignJWT, errors as joseErrors, jwtVerify } from "jose";

export const WEBCHAT_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
const ISSUER = "crm-webchat";
const AUDIENCE = "webchat-visitor";

export type WebchatTokenClaims = {
  /** organizationId */
  org: string;
  /** channelId */
  ch: string;
  /** visitorId (= WebchatSession.id) */
  vis: string;
  /** contactId no momento da emissão (null = visitante ainda sem contato) */
  cid: string | null;
};

export type WebchatTokenVerify =
  | { ok: true; claims: WebchatTokenClaims; expiresAt: Date }
  | { ok: false; reason: "missing" | "expired" | "invalid" };

let memo: { raw: string; key: Uint8Array } | null = null;

function secretKey(): Uint8Array {
  const explicit = process.env.WEBCHAT_JWT_SECRET?.trim() ?? "";
  const auth = (process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "").trim();
  const raw = `${explicit}\n${auth}`;
  if (memo && memo.raw === raw) return memo.key;
  let key: Uint8Array;
  if (explicit.length >= 32) {
    key = new TextEncoder().encode(explicit);
  } else if (auth) {
    key = createHmac("sha256", auth).update("webchat-jwt:v1").digest();
  } else {
    throw new Error("Nem WEBCHAT_JWT_SECRET nem AUTH_SECRET definidos — impossível emitir token do webchat.");
  }
  memo = { raw, key };
  return key;
}

export function hashWebchatToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function signWebchatToken(
  claims: WebchatTokenClaims,
  now: Date = new Date(),
): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + WEBCHAT_TOKEN_TTL_SEC;
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey());
  return { token, tokenHash: hashWebchatToken(token), expiresAt: new Date(exp * 1000) };
}

function claimsFrom(payload: Record<string, unknown>): WebchatTokenClaims | null {
  const { org, ch, vis, cid } = payload;
  if (typeof org !== "string" || !org) return null;
  if (typeof ch !== "string" || !ch) return null;
  if (typeof vis !== "string" || !vis) return null;
  if (cid !== null && cid !== undefined && typeof cid !== "string") return null;
  return { org, ch, vis, cid: typeof cid === "string" && cid ? cid : null };
}

/**
 * Valida assinatura, emissor, audiência e validade. `allowExpired` aceita
 * token vencido mas autêntico — usado só por `POST /session` para retomar o
 * mesmo visitante (prova de posse do último token emitido).
 */
export async function verifyWebchatToken(
  token: string | null | undefined,
  opts: { allowExpired?: boolean } = {},
): Promise<WebchatTokenVerify> {
  if (!token) return { ok: false, reason: "missing" };
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
      ...(opts.allowExpired ? { currentDate: new Date(0) } : {}),
    });
    const claims = claimsFrom(payload as Record<string, unknown>);
    if (!claims) return { ok: false, reason: "invalid" };
    return { ok: true, claims, expiresAt: new Date((payload.exp ?? 0) * 1000) };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}

/** `Authorization: Bearer <token>` → token, ou null. */
export function bearerFrom(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}
