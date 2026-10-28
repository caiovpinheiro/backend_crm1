/**
 * Webchat v2 — assinaturas HMAC-SHA256 do contrato (docs/decisoes/webchat-widget.md
 * §9.4 e §9.6). Chave = o segredo do canal como texto UTF-8 (exatamente o
 * valor mostrado no painel, com o prefixo). Comparação sempre em tempo
 * constante. Funções puras.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { WEBCHAT_S2S_TIMESTAMP_TOLERANCE_SEC } from "@/lib/webchat/v2-config";

const HEX_64_RE = /^[0-9a-f]{64}$/;

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** Compara dois hex de 64 chars em tempo constante (minúsculas). */
function safeHexEqual(expected: string, received: string): boolean {
  const r = received.trim().toLowerCase();
  if (!HEX_64_RE.test(r)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(r, "hex"));
}

/** `userHash` = HMAC-SHA256(segredo de identidade, externalId) em hex. */
export function computeWebchatUserHash(identitySecret: string, externalId: string): string {
  return hmacHex(identitySecret, externalId);
}

export function verifyWebchatUserHash(
  identitySecret: string | null,
  externalId: string,
  userHash: unknown,
): boolean {
  if (!identitySecret || !externalId || typeof userHash !== "string") return false;
  return safeHexEqual(computeWebchatUserHash(identitySecret, externalId), userHash);
}

/** `X-Signature` = "sha256=" + HMAC-SHA256(segredo S2S, `${timestamp}.${corpo}`). */
export function signWebchatS2S(s2sSecret: string, timestamp: string, rawBody: string): string {
  return `sha256=${hmacHex(s2sSecret, `${timestamp}.${rawBody}`)}`;
}

export type WebchatS2SVerifyResult =
  | { ok: true }
  | { ok: false; code: "SIGNATURE_INVALID" | "TIMESTAMP_EXPIRED" };

/**
 * Confere `X-Timestamp` (segundos Unix, ±5 min do relógio do CRM) e
 * `X-Signature`. Timestamp inválido/fora da janela → `TIMESTAMP_EXPIRED`
 * (antes de olhar a assinatura); assinatura ausente/errada → `SIGNATURE_INVALID`.
 */
export function verifyWebchatS2S(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs?: number;
  toleranceSec?: number;
}): WebchatS2SVerifyResult {
  const tolerance = input.toleranceSec ?? WEBCHAT_S2S_TIMESTAMP_TOLERANCE_SEC;
  const ts = (input.timestamp ?? "").trim();
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, code: "TIMESTAMP_EXPIRED" };
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(ts)) > tolerance) return { ok: false, code: "TIMESTAMP_EXPIRED" };
  const sig = (input.signature ?? "").trim();
  if (!sig.toLowerCase().startsWith("sha256=")) return { ok: false, code: "SIGNATURE_INVALID" };
  const expected = hmacHex(input.secret, `${ts}.${input.rawBody}`);
  return safeHexEqual(expected, sig.slice("sha256=".length))
    ? { ok: true }
    : { ok: false, code: "SIGNATURE_INVALID" };
}
