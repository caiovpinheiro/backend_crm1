/**
 * PUT /api/profile — troca de senha e sessões (SV-1/SV-2): a senha nova
 * incrementa a versão no mesmo UPDATE, notifica a revogação e devolve a
 * prova (`sessionRenewal`) para a sessão que pediu continuar. Edição comum
 * de perfil não mexe em sessão nem expõe `sessionVersion`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  baseFindUnique: vi.fn(),
  compare: vi.fn(),
  hash: vi.fn(),
  revokeUser: vi.fn(),
  logAuditAsync: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique, update: mocks.update } },
}));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findUnique: mocks.baseFindUnique } },
}));
vi.mock("bcryptjs", () => ({
  default: { compare: mocks.compare, hash: mocks.hash },
  compare: mocks.compare,
  hash: mocks.hash,
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { revokeUser: mocks.revokeUser } }));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: mocks.logAuditAsync }));
vi.mock("@/lib/cache/redis-client", () => ({ getCacheClient: () => null }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { PUT } from "@/app/api/profile/route";
import {
  clearSessionRenewalsForTests,
  renewSessionVersion,
} from "@/lib/auth/session-renewal";
import {
  clearSessionVersionCacheForTests,
  getCachedSessionVersion,
  setCachedSessionVersion,
} from "@/lib/auth/session-version";

const SESSION = {
  user: { id: "u1", organizationId: "org1", isSuperAdmin: false, sessionVersion: 3 },
};
const PROFILE = {
  id: "u1",
  name: "Fulano",
  email: "fulano@acme.test",
  role: "MEMBER",
  avatarUrl: null,
  phone: null,
  signature: null,
  closingMessage: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  chatTheme: "azul",
};

function put(body: unknown): Request {
  return new Request("https://api.test/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionRenewalsForTests();
  clearSessionVersionCacheForTests();
  mocks.auth.mockResolvedValue(SESSION);
  mocks.findUnique.mockResolvedValue({ id: "u1", hashedPassword: "hash-antigo" });
  mocks.compare.mockResolvedValue(true);
  mocks.hash.mockResolvedValue("hash-novo");
});

describe("PUT /api/profile — edição comum", () => {
  it("não incrementa a versão, não notifica e não devolve prova nem sessionVersion", async () => {
    mocks.update.mockResolvedValue({ ...PROFILE, name: "Novo Nome", sessionVersion: 3 });
    const res = await PUT(put({ name: "Novo Nome" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ...PROFILE, name: "Novo Nome" });
    expect(json).not.toHaveProperty("sessionRenewal");
    const args = mocks.update.mock.calls[0][0];
    expect(args.data).toEqual({ name: "Novo Nome" });
    expect(json).not.toHaveProperty("sessionVersion");
    expect(mocks.revokeUser).not.toHaveBeenCalled();
  });
});

describe("PUT /api/profile — troca de senha", () => {
  it("senha atual errada: 400, sem UPDATE e sem prova", async () => {
    mocks.compare.mockResolvedValue(false);
    const res = await PUT(put({ currentPassword: "errada", newPassword: "nova-senha-1" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain("sessionRenewal");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.revokeUser).not.toHaveBeenCalled();
  });

  it("sem sessão: 401 e nada acontece", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await PUT(put({ currentPassword: "atual", newPassword: "nova-senha-1" }));
    expect(res.status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("incrementa no mesmo UPDATE, revoga as sessões e devolve a prova para ESTA sessão", async () => {
    setCachedSessionVersion("u1", 3);
    mocks.update.mockResolvedValue({ ...PROFILE, sessionVersion: 4 });

    const res = await PUT(put({ currentPassword: "atual", newPassword: "nova-senha-1" }));
    expect(res.status).toBe(200);

    const args = mocks.update.mock.calls[0][0];
    expect(args.data).toEqual({
      hashedPassword: "hash-novo",
      sessionVersion: { increment: 1 },
    });
    expect(args.select).toMatchObject({ sessionVersion: true });

    // Revogação: cache do processo zerado, SSE fechado, auditoria.
    expect(getCachedSessionVersion("u1")).toBeNull();
    expect(mocks.revokeUser).toHaveBeenCalledWith({ userId: "u1", organizationId: "org1" });
    expect(mocks.logAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sessions_revoked",
        metadata: { reason: "password_change" },
      }),
    );

    const json = await res.json();
    // O perfil vai como antes; a versão crua do banco não vaza no corpo.
    expect(json).not.toHaveProperty("sessionVersion");
    expect(json).not.toHaveProperty("hashedPassword");
    expect(json).toMatchObject({ id: "u1", name: "Fulano" });
    expect(json.sessionRenewal).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      sessionVersion: 4,
      expiresInSec: 60,
    });

    // A prova devolvida renova a sessão que pediu (claim 3 → 4), uma vez.
    mocks.baseFindUnique.mockResolvedValue({ sessionVersion: 4 });
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: json.sessionRenewal.token }),
    ).toBe(4);
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: json.sessionRenewal.token }),
    ).toBeNull();
  });

  it("sessão que pediu não estava na versão anterior: troca a senha, mas não emite prova", async () => {
    // Claim 1 com o banco indo para 4 (token defasado que passou por cache frio).
    mocks.auth.mockResolvedValue({ user: { ...SESSION.user, sessionVersion: 1 } });
    mocks.update.mockResolvedValue({ ...PROFILE, sessionVersion: 4 });
    const res = await PUT(put({ currentPassword: "atual", newPassword: "nova-senha-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("sessionRenewal");
    expect(mocks.revokeUser).toHaveBeenCalledTimes(1);
  });

  it("banco sem a coluna chatTheme: o caminho alternativo também revoga e devolve a prova", async () => {
    mocks.update
      .mockRejectedValueOnce(new Error('column "chatTheme" does not exist'))
      .mockResolvedValueOnce({ id: "u1", name: "Fulano", sessionVersion: 4 });
    const res = await PUT(
      put({ currentPassword: "atual", newPassword: "nova-senha-1", chatTheme: "azul" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ id: "u1", chatTheme: "azul" });
    expect(json).not.toHaveProperty("sessionVersion");
    expect(json.sessionRenewal).toMatchObject({ sessionVersion: 4 });
    expect(mocks.revokeUser).toHaveBeenCalledTimes(1);
  });
});
