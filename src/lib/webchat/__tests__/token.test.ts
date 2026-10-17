import { beforeEach, describe, expect, it } from "vitest";

import {
  WEBCHAT_TOKEN_TTL_SEC,
  hashWebchatToken,
  signWebchatToken,
  verifyWebchatToken,
} from "@/lib/webchat/token";

const CLAIMS = { org: "org-1", ch: "ch-1", vis: "wv_abc", cid: null };

describe("webchat token", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-auth-secret-for-webchat-token";
    delete process.env.WEBCHAT_JWT_SECRET;
  });

  it("assina e valida as claims; hash é o sha256 do token", async () => {
    const { token, tokenHash, expiresAt } = await signWebchatToken(CLAIMS);
    expect(tokenHash).toBe(hashWebchatToken(token));
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan((WEBCHAT_TOKEN_TTL_SEC - 5) * 1000);
    const v = await verifyWebchatToken(token);
    expect(v).toMatchObject({ ok: true, claims: CLAIMS });
  });

  it("vencido → expired; com allowExpired passa", async () => {
    const past = new Date(Date.now() - (WEBCHAT_TOKEN_TTL_SEC + 60) * 1000);
    const { token } = await signWebchatToken(CLAIMS, past);
    expect(await verifyWebchatToken(token)).toEqual({ ok: false, reason: "expired" });
    expect(await verifyWebchatToken(token, { allowExpired: true })).toMatchObject({
      ok: true,
      claims: CLAIMS,
    });
  });

  it("adulterado, de outro segredo ou ausente → inválido/missing", async () => {
    const { token } = await signWebchatToken(CLAIMS);
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    expect(await verifyWebchatToken(tampered)).toEqual({ ok: false, reason: "invalid" });
    process.env.WEBCHAT_JWT_SECRET = "outro-segredo-com-mais-de-32-caracteres!!";
    expect(await verifyWebchatToken(token)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyWebchatToken(null)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyWebchatToken("abc.def.ghi")).toEqual({ ok: false, reason: "invalid" });
  });
});
