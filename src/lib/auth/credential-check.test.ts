/** Senha + MFA da conta de destino na primeira vinculação (mesmo critério do login). */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  verifyTotp: vi.fn(),
  findMatchingBackupCode: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("bcryptjs", () => ({ compare: mocks.compare }));
vi.mock("./totp", () => ({ verifyTotp: mocks.verifyTotp }));
vi.mock("./backup-codes", () => ({ findMatchingBackupCode: mocks.findMatchingBackupCode }));
vi.mock("@/lib/crypto/secrets", () => ({ decryptSecret: (v: string) => `plain:${v}` }));
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { userMfaBackupCode: { findMany: mocks.findMany, updateMany: mocks.updateMany } },
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { verifyPasswordAndMfa } from "./credential-check";

const USER = { id: "uB", hashedPassword: "hash", mfaSecret: null, mfaEnabledAt: null };
const MFA_USER = { ...USER, mfaSecret: "enc", mfaEnabledAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.compare.mockResolvedValue(true);
  mocks.verifyTotp.mockReturnValue(false);
  mocks.findMatchingBackupCode.mockResolvedValue(-1);
  mocks.findMany.mockResolvedValue([{ id: "bc1", codeHash: "h1" }]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("verifyPasswordAndMfa", () => {
  it("senha errada ou conta sem senha → bad_password (bcrypt roda nos dois casos)", async () => {
    mocks.compare.mockResolvedValue(false);
    expect(await verifyPasswordAndMfa(USER, { password: "x" })).toBe("bad_password");
    expect(await verifyPasswordAndMfa({ ...USER, hashedPassword: null }, { password: "x" })).toBe("bad_password");
    expect(mocks.compare).toHaveBeenCalledTimes(2);
  });

  it("sem MFA: senha certa basta", async () => {
    expect(await verifyPasswordAndMfa(USER, { password: "ok" })).toBe("ok");
  });

  it("com MFA: exige código; TOTP válido passa; inválido recusa", async () => {
    expect(await verifyPasswordAndMfa(MFA_USER, { password: "ok" })).toBe("mfa_required");
    expect(await verifyPasswordAndMfa(MFA_USER, { password: "ok", mfaCode: "000000" })).toBe("bad_mfa");
    mocks.verifyTotp.mockReturnValue(true);
    expect(await verifyPasswordAndMfa(MFA_USER, { password: "ok", mfaCode: "123456" })).toBe("ok");
    expect(mocks.verifyTotp).toHaveBeenLastCalledWith("plain:enc", "123456");
  });

  it("código de backup: uso único (já consumido em outra aba = recusa)", async () => {
    mocks.findMatchingBackupCode.mockResolvedValue(0);
    expect(await verifyPasswordAndMfa(MFA_USER, { password: "ok", backupCode: "AAAA-BBBB" })).toBe("ok");
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "bc1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(await verifyPasswordAndMfa(MFA_USER, { password: "ok", backupCode: "AAAA-BBBB" })).toBe("bad_mfa");
  });
});
