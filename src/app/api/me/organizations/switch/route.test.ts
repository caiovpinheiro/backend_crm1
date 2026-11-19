/**
 * POST /api/me/organizations/switch — autorização da troca de organização.
 *
 * O ticket só sai quando: há sessão válida, a conta de destino é do MESMO
 * e-mail e elegível (`findEligibleTarget`), e existe vínculo vigente OU a
 * senha (+MFA) da conta de destino confere. Nenhum caminho mexe na sessão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  withRateLimit: vi.fn(),
  loadSourceAccount: vi.fn(),
  findEligibleTarget: vi.fn(),
  hasCurrentLink: vi.fn(),
  upsertLink: vi.fn(),
  issueOrgSwitchTicket: vi.fn(),
  verifyPasswordAndMfa: vi.fn(),
  checkLockout: vi.fn(),
  recordLoginAttempt: vi.fn(),
  clearFailuresOnSuccess: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: mocks.withRateLimit,
  getClientIp: () => "198.51.100.7",
}));
vi.mock("@/lib/auth/org-switch", () => ({
  loadSourceAccount: mocks.loadSourceAccount,
  findEligibleTarget: mocks.findEligibleTarget,
  hasCurrentLink: mocks.hasCurrentLink,
  upsertLink: mocks.upsertLink,
  issueOrgSwitchTicket: mocks.issueOrgSwitchTicket,
}));
vi.mock("@/lib/auth/credential-check", () => ({
  verifyPasswordAndMfa: mocks.verifyPasswordAndMfa,
}));
vi.mock("@/lib/auth/lockout", () => ({
  checkLockout: mocks.checkLockout,
  recordLoginAttempt: mocks.recordLoginAttempt,
  clearFailuresOnSuccess: mocks.clearFailuresOnSuccess,
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { NextResponse } from "next/server";

import { POST } from "./route";

const SESSION = {
  user: { id: "uA", organizationId: "orgA", isSuperAdmin: false, sessionVersion: 2, sid: "sid-A" },
};
const SOURCE = { id: "uA", email: "p@x.test", organizationId: "orgA", sessionVersion: 2 };
const TARGET = {
  id: "uB",
  email: "p@x.test",
  name: "P",
  role: "MEMBER",
  organizationId: "orgB",
  organization: { id: "orgB", slug: "beta", name: "Beta", logoUrl: null },
  sessionVersion: 7,
  hashedPassword: "h",
  mfaSecret: null,
  mfaEnabledAt: null,
};
const TICKET = { token: "t".repeat(43), expiresInSec: 60 };

function post(body: unknown): Request {
  return new Request("https://api.test/api/me/organizations/switch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ ok: true, session: SESSION });
  mocks.withRateLimit.mockResolvedValue({ ok: true, headers: {} });
  mocks.loadSourceAccount.mockResolvedValue(SOURCE);
  mocks.findEligibleTarget.mockResolvedValue(TARGET);
  mocks.hasCurrentLink.mockResolvedValue(false);
  mocks.issueOrgSwitchTicket.mockResolvedValue(TICKET);
  mocks.checkLockout.mockResolvedValue({ locked: false, retryAfterSec: 0 });
  mocks.verifyPasswordAndMfa.mockResolvedValue("ok");
});

describe("POST /api/me/organizations/switch — autorização", () => {
  it("sem sessão (ou sessão revogada): devolve a resposta do requireAuth e nada acontece", async () => {
    const denied = NextResponse.json({ message: "Sessão expirada.", code: "SESSION_REVOKED" }, { status: 401 });
    mocks.requireAuth.mockResolvedValue({ ok: false, response: denied });
    const res = await POST(post({ organizationId: "orgB", password: "x" }));
    expect(res.status).toBe(401);
    expect(mocks.findEligibleTarget).not.toHaveBeenCalled();
    expect(mocks.issueOrgSwitchTicket).not.toHaveBeenCalled();
  });

  it("corpo inválido → 400; mesma organização → 400", async () => {
    expect((await POST(post("{nao-json"))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    const same = await POST(post({ organizationId: "orgA" }));
    expect(same.status).toBe(400);
    expect((await json(same)).code).toBe("same_organization");
  });

  it("limite por usuário estourado → 429 sem tocar no banco", async () => {
    mocks.withRateLimit.mockResolvedValue({ ok: false, headers: { "Retry-After": "30" } });
    const res = await POST(post({ organizationId: "orgB" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(mocks.loadSourceAccount).not.toHaveBeenCalled();
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "auth.org-switch", scope: "user", id: "uA" }),
    );
  });

  it("conta de origem inelegível (super-admin / org suspensa) → 403", async () => {
    mocks.loadSourceAccount.mockResolvedValue(null);
    const res = await POST(post({ organizationId: "orgB", password: "x" }));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("switch_unavailable");
  });

  it("isolamento: org sem conta elegível do mesmo e-mail → 404, e a busca é pela conta da sessão", async () => {
    mocks.findEligibleTarget.mockResolvedValue(null);
    const res = await POST(post({ organizationId: "orgZ", password: "x" }));
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe("organization_unavailable");
    // A conta de origem vem do banco pelo id da sessão (não do corpo).
    expect(mocks.loadSourceAccount).toHaveBeenCalledWith("uA");
    expect(mocks.findEligibleTarget).toHaveBeenCalledWith(SOURCE, { organizationId: "orgZ" });
    expect(mocks.verifyPasswordAndMfa).not.toHaveBeenCalled();
  });

  it("sem vínculo e sem senha → 403 password_required (e-mail igual não basta)", async () => {
    const res = await POST(post({ organizationId: "orgB" }));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("password_required");
    expect(mocks.issueOrgSwitchTicket).not.toHaveBeenCalled();
    expect(mocks.upsertLink).not.toHaveBeenCalled();
  });

  it("senha errada → 403, registra a falha no lockout da conta de destino, sem vínculo nem ticket", async () => {
    mocks.verifyPasswordAndMfa.mockResolvedValue("bad_password");
    const res = await POST(post({ organizationId: "orgB", password: "errada" }));
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("invalid_credentials");
    expect(mocks.recordLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ email: "p@x.test", userId: "uB", outcome: "bad_password" }),
    );
    expect(mocks.upsertLink).not.toHaveBeenCalled();
    expect(mocks.issueOrgSwitchTicket).not.toHaveBeenCalled();
  });

  it("MFA: pede o código e recusa código inválido", async () => {
    mocks.verifyPasswordAndMfa.mockResolvedValue("mfa_required");
    const r1 = await POST(post({ organizationId: "orgB", password: "certa" }));
    expect(r1.status).toBe(403);
    expect((await json(r1)).code).toBe("mfa_required");

    mocks.verifyPasswordAndMfa.mockResolvedValue("bad_mfa");
    const r2 = await POST(post({ organizationId: "orgB", password: "certa", mfaCode: "000000" }));
    expect(r2.status).toBe(403);
    expect((await json(r2)).code).toBe("mfa_invalid");
    expect(mocks.verifyPasswordAndMfa).toHaveBeenLastCalledWith(TARGET, {
      password: "certa",
      mfaCode: "000000",
      backupCode: "",
    });
    expect(mocks.issueOrgSwitchTicket).not.toHaveBeenCalled();
  });

  it("conta de destino bloqueada pelo lockout → 423 sem checar a senha", async () => {
    mocks.checkLockout.mockResolvedValue({ locked: true, retryAfterSec: 120 });
    const res = await POST(post({ organizationId: "orgB", password: "x" }));
    expect(res.status).toBe(423);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(mocks.verifyPasswordAndMfa).not.toHaveBeenCalled();
  });

  it("primeira vinculação válida: grava o vínculo e devolve o ticket ligado à sessão", async () => {
    const res = await POST(post({ organizationId: "orgB", password: "certa", mfaCode: "123456" }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: true,
      linkedNow: true,
      organization: { id: "orgB", slug: "beta", name: "Beta" },
      orgSwitch: TICKET,
    });
    expect(mocks.upsertLink).toHaveBeenCalledWith(SOURCE, TARGET);
    expect(mocks.clearFailuresOnSuccess).toHaveBeenCalledWith("p@x.test");
    expect(mocks.issueOrgSwitchTicket).toHaveBeenCalledWith({
      fromUserId: "uA",
      sid: "sid-A",
      toUserId: "uB",
    });
  });

  it("vínculo vigente: troca sem pedir senha", async () => {
    mocks.hasCurrentLink.mockResolvedValue(true);
    const res = await POST(post({ organizationId: "orgB" }));
    expect(res.status).toBe(200);
    expect((await json(res)).linkedNow).toBe(false);
    expect(mocks.verifyPasswordAndMfa).not.toHaveBeenCalled();
    expect(mocks.checkLockout).not.toHaveBeenCalled();
    expect(mocks.upsertLink).not.toHaveBeenCalled();
    expect(mocks.issueOrgSwitchTicket).toHaveBeenCalled();
  });

  it("erro inesperado → 500, sem ticket", async () => {
    mocks.findEligibleTarget.mockRejectedValue(new Error("db down"));
    const res = await POST(post({ organizationId: "orgB", password: "x" }));
    expect(res.status).toBe(500);
    expect(mocks.issueOrgSwitchTicket).not.toHaveBeenCalled();
  });
});
