import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { organization: { findFirst } },
}));

import { invalidateCorsTenantOrigin } from "@/lib/cache/keys";

import { isTrustedTenantOriginSlug } from "./cors-tenant-origin";

let n = 0;
/** Slug novo por teste — o cache em memória é do processo. */
function freshSlug(): string {
  n += 1;
  return `org-teste-${n}`;
}

beforeEach(() => {
  findFirst.mockReset();
});

describe("isTrustedTenantOriginSlug", () => {
  it("exige org ACTIVE com algum usuário de e-mail verificado", async () => {
    const slug = freshSlug();
    findFirst.mockResolvedValueOnce({ id: "org_1" });
    expect(await isTrustedTenantOriginSlug(slug)).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        slug,
        status: "ACTIVE",
        users: { some: { emailVerifiedAt: { not: null } } },
      },
      select: { id: true },
    });
  });

  it("positivo e negativo ficam em cache (sem consulta por request)", async () => {
    const ok = freshSlug();
    const missing = freshSlug();
    findFirst.mockResolvedValueOnce({ id: "org_1" }).mockResolvedValueOnce(null);

    expect(await isTrustedTenantOriginSlug(ok)).toBe(true);
    expect(await isTrustedTenantOriginSlug(missing)).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      expect(await isTrustedTenantOriginSlug(ok)).toBe(true);
      expect(await isTrustedTenantOriginSlug(missing)).toBe(false);
    }
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("org sem admin verificado: negada; depois da verificação (invalidação) passa a valer", async () => {
    const slug = freshSlug();
    findFirst.mockResolvedValueOnce(null);
    expect(await isTrustedTenantOriginSlug(slug)).toBe(false);

    await invalidateCorsTenantOrigin(slug);
    findFirst.mockResolvedValueOnce({ id: "org_1" });
    expect(await isTrustedTenantOriginSlug(slug)).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("slug fora do formato não chega ao banco", async () => {
    expect(await isTrustedTenantOriginSlug("a.b")).toBe(false);
    expect(await isTrustedTenantOriginSlug("UPPER")).toBe(false);
    expect(await isTrustedTenantOriginSlug("")).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("erro de banco propaga e não é cacheado", async () => {
    const slug = freshSlug();
    findFirst.mockRejectedValueOnce(new Error("pool timeout"));
    await expect(isTrustedTenantOriginSlug(slug)).rejects.toThrow("pool timeout");
    findFirst.mockResolvedValueOnce({ id: "org_1" });
    expect(await isTrustedTenantOriginSlug(slug)).toBe(true);
  });
});
