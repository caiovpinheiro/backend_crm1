import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeWebchatUserHash,
  signWebchatS2S,
  verifyWebchatS2S,
  verifyWebchatUserHash,
} from "@/lib/webchat/signatures";

const IDENTITY = "wcid_segredo-de-teste";
const S2S = "wcsk_outro-segredo";

describe("userHash (identify assinado)", () => {
  it("é HMAC-SHA256 hex do externalId com o segredo de identidade", () => {
    const expected = createHmac("sha256", IDENTITY).update("ext-123").digest("hex");
    expect(computeWebchatUserHash(IDENTITY, "ext-123")).toBe(expected);
  });

  it("válido (também em maiúsculas)", () => {
    const h = computeWebchatUserHash(IDENTITY, "ext-123");
    expect(verifyWebchatUserHash(IDENTITY, "ext-123", h)).toBe(true);
    expect(verifyWebchatUserHash(IDENTITY, "ext-123", h.toUpperCase())).toBe(true);
  });

  it("inválido: outro id, outro segredo, lixo", () => {
    const h = computeWebchatUserHash(IDENTITY, "ext-123");
    expect(verifyWebchatUserHash(IDENTITY, "ext-124", h)).toBe(false);
    expect(verifyWebchatUserHash("wcid_outro", "ext-123", h)).toBe(false);
    expect(verifyWebchatUserHash(IDENTITY, "ext-123", "abc")).toBe(false);
  });

  it("ausente: sem hash ou canal sem segredo", () => {
    expect(verifyWebchatUserHash(IDENTITY, "ext-123", undefined)).toBe(false);
    expect(verifyWebchatUserHash(null, "ext-123", computeWebchatUserHash(IDENTITY, "ext-123"))).toBe(false);
  });
});

describe("servidor a servidor", () => {
  const body = JSON.stringify({ external_id: "ext-1", text: "olá" });
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));

  it("assina timestamp + '.' + corpo com prefixo sha256=", () => {
    const expected = createHmac("sha256", S2S).update(`${ts}.${body}`).digest("hex");
    expect(signWebchatS2S(S2S, ts, body)).toBe(`sha256=${expected}`);
  });

  it("assinatura válida dentro da janela", () => {
    const signature = signWebchatS2S(S2S, ts, body);
    expect(verifyWebchatS2S({ secret: S2S, timestamp: ts, signature, rawBody: body, nowMs: now })).toEqual({
      ok: true,
    });
    // 4 min de diferença ainda vale.
    expect(
      verifyWebchatS2S({ secret: S2S, timestamp: ts, signature, rawBody: body, nowMs: now + 240_000 }).ok,
    ).toBe(true);
  });

  it("timestamp vencido (> 5 min) ou inválido", () => {
    const signature = signWebchatS2S(S2S, ts, body);
    for (const input of [
      { timestamp: ts, nowMs: now + 301_000 },
      { timestamp: ts, nowMs: now - 301_000 },
      { timestamp: "abc", nowMs: now },
      { timestamp: null, nowMs: now },
    ]) {
      expect(verifyWebchatS2S({ secret: S2S, signature, rawBody: body, ...input })).toEqual({
        ok: false,
        code: "TIMESTAMP_EXPIRED",
      });
    }
  });

  it("assinatura errada, sem prefixo, de outro corpo ou ausente", () => {
    const good = signWebchatS2S(S2S, ts, body);
    for (const signature of [
      good.replace("sha256=", ""),
      signWebchatS2S(S2S, ts, body + " "),
      signWebchatS2S("wcsk_outro", ts, body),
      null,
    ]) {
      expect(verifyWebchatS2S({ secret: S2S, timestamp: ts, signature, rawBody: body, nowMs: now })).toEqual({
        ok: false,
        code: "SIGNATURE_INVALID",
      });
    }
  });
});
