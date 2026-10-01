/**
 * SV-1: `revokeUserSessions` incrementa no banco e o pós
 * (`notifySessionsRevoked`) zera os caches do processo, fecha o SSE do
 * usuário e audita — sem lançar. Linha inexistente (P2025) só notifica.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  revokeUser: vi.fn(),
  logAuditAsync: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { update: mocks.update } },
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { revokeUser: mocks.revokeUser } }));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: mocks.logAuditAsync }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: mocks.info, warn: mocks.warn, debug: vi.fn(), error: vi.fn() }),
}));

import {
  getJwtRefreshSnapshot,
  setJwtRefreshSnapshot,
} from "@/lib/auth/jwt-refresh-cache";
import {
  SESSION_VERSION_BUMP,
  notifySessionsRevoked,
  revokeUserSessions,
} from "@/lib/auth/session-revocation";
import {
  clearSessionVersionCacheForTests,
  getCachedSessionVersion,
  setCachedSessionVersion,
} from "@/lib/auth/session-version";

const ARGS = { userId: "u1", organizationId: "org1", reason: "revoke_all" as const };

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionVersionCacheForTests();
  setCachedSessionVersion("u1", 1);
  setJwtRefreshSnapshot("u1", { invalid: true });
});

describe("notifySessionsRevoked", () => {
  it("zera os dois caches, fecha o SSE e audita com o motivo", () => {
    notifySessionsRevoked(ARGS);
    expect(getCachedSessionVersion("u1")).toBeNull();
    expect(getJwtRefreshSnapshot("u1")).toBeNull();
    expect(mocks.revokeUser).toHaveBeenCalledWith({ userId: "u1", organizationId: "org1" });
    expect(mocks.logAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "user",
        action: "sessions_revoked",
        entityId: "u1",
        actorId: "u1",
        metadata: { reason: "revoke_all" },
      }),
    );
  });

  it("actorId explícito (reset administrativo) vai para a auditoria", () => {
    notifySessionsRevoked({ ...ARGS, reason: "password_change", actorId: "admin" });
    expect(mocks.logAuditAsync.mock.calls[0][0]).toMatchObject({ actorId: "admin" });
  });

  it("falha no SSE não propaga", () => {
    mocks.revokeUser.mockImplementation(() => {
      throw new Error("bus quebrou");
    });
    expect(() => notifySessionsRevoked(ARGS)).not.toThrow();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});

describe("revokeUserSessions", () => {
  it("incrementa sessionVersion, notifica e devolve a versão nova", async () => {
    mocks.update.mockResolvedValue({ sessionVersion: 2 });
    expect(await revokeUserSessions(ARGS)).toBe(2);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: SESSION_VERSION_BUMP,
      select: { sessionVersion: true },
    });
    expect(mocks.revokeUser).toHaveBeenCalledTimes(1);
    expect(getCachedSessionVersion("u1")).toBeNull();
  });

  it("usuário já apagado (P2025): não lança, só notifica e devolve null", async () => {
    mocks.update.mockRejectedValue(Object.assign(new Error("not found"), { code: "P2025" }));
    expect(await revokeUserSessions({ ...ARGS, reason: "user_deleted" })).toBeNull();
    expect(mocks.revokeUser).toHaveBeenCalledTimes(1);
  });

  it("outro erro do banco propaga e não notifica", async () => {
    mocks.update.mockRejectedValue(new Error("db down"));
    await expect(revokeUserSessions(ARGS)).rejects.toThrow("db down");
    expect(mocks.revokeUser).not.toHaveBeenCalled();
    // O cache continua como estava: nada foi revogado.
    expect(getCachedSessionVersion("u1")).toBe(1);
  });
});
