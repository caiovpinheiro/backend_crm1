/**
 * Token/sessão revogados identificáveis (ver `revoked-session.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  isRevokedToken,
  revokedReasonOf,
  revokedSession,
  revokedToken,
  sanitizeRevokedSessionResponse,
  sessionRevokedResponse,
} from "./revoked-session";

describe("token / sessão marcados", () => {
  it("revokedToken só leva a marca, o motivo e o id para log", () => {
    expect(revokedToken("u1", "session_revoked")).toEqual({
      revoked: true,
      revokedReason: "session_revoked",
      revokedUserId: "u1",
    });
    expect(isRevokedToken(revokedToken(undefined, "idle_timeout"))).toBe(true);
    expect(isRevokedToken({ id: "u1" })).toBe(false);
    expect(isRevokedToken(null)).toBe(false);
  });

  it("revokedReasonOf: só sessão marcada; motivo desconhecido vira session_revoked", () => {
    expect(revokedReasonOf(revokedSession("idle_timeout"))).toBe("idle_timeout");
    expect(revokedReasonOf({ revoked: true, revokedReason: "xyz" })).toBe("session_revoked");
    expect(revokedReasonOf({ user: { id: "u1" } })).toBeNull();
    expect(revokedReasonOf(null)).toBeNull();
  });

  it("sessionRevokedResponse: 401 com code SESSION_REVOKED", async () => {
    const res = sessionRevokedResponse();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      message: "Sessão expirada. Entre novamente.",
      code: "SESSION_REVOKED",
    });
  });
});

describe("sanitizeRevokedSessionResponse (rota /api/auth/session)", () => {
  function json(body: unknown, cookies: string[]): Response {
    const headers = new Headers({ "content-type": "application/json" });
    for (const c of cookies) headers.append("set-cookie", c);
    return new Response(JSON.stringify(body), { status: 200, headers });
  }

  it("sessão marcada → corpo null e cookie de sessão apagado com Domain/Path preservados", async () => {
    const res = await sanitizeRevokedSessionResponse(
      json({ revoked: true, revokedReason: "session_revoked" }, [
        "__Secure-authjs.session-token=abc; Path=/; Expires=Wed, 10 Nov 2027 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax; Domain=.bwipo.com",
        "authjs.csrf-token=zzz; Path=/; HttpOnly",
      ]),
    );
    expect(await res.text()).toBe("null");
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("__Secure-authjs.session-token="));
    expect(session).toMatch(/^__Secure-authjs\.session-token=;/);
    expect(session).toContain("Domain=.bwipo.com");
    expect(session).toContain("Path=/");
    expect(session).toContain("Max-Age=0");
    expect(session).not.toContain("2027");
    expect(cookies).toContain("authjs.csrf-token=zzz; Path=/; HttpOnly");
  });

  it("sessão válida, null ou não-JSON passam intactas", async () => {
    const valid = json({ user: { id: "u1" } }, ["authjs.session-token=abc; Path=/"]);
    expect(await sanitizeRevokedSessionResponse(valid)).toBe(valid);
    const none = json(null, []);
    expect(await sanitizeRevokedSessionResponse(none)).toBe(none);
    const redirect = new Response(null, { status: 302, headers: { location: "/login" } });
    expect(await sanitizeRevokedSessionResponse(redirect)).toBe(redirect);
  });
});
