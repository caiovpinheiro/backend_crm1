/**
 * SS-2: cache em memória do refresh do JWT — TTL 30 s, invalidação imediata
 * e teto de entradas.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  JWT_REFRESH_TTL_MS,
  clearJwtRefreshCacheForTests,
  getJwtRefreshSnapshot,
  invalidateJwtRefreshCache,
  setJwtRefreshSnapshot,
  type JwtRefreshSnapshot,
} from "@/lib/auth/jwt-refresh-cache";

const SNAP: JwtRefreshSnapshot = {
  invalid: false,
  role: "MEMBER",
  organizationId: "org1",
  organizationSlug: "acme",
  isSuperAdmin: false,
  picture: null,
};

describe("jwt-refresh-cache", () => {
  beforeEach(() => clearJwtRefreshCacheForTests());

  it("devolve o snapshot dentro do TTL e null depois", () => {
    const t0 = 1_000_000;
    setJwtRefreshSnapshot("u1", SNAP, t0);
    expect(getJwtRefreshSnapshot("u1", t0 + JWT_REFRESH_TTL_MS - 1)).toEqual(SNAP);
    expect(getJwtRefreshSnapshot("u1", t0 + JWT_REFRESH_TTL_MS)).toBeNull();
    // Expirado foi removido — nao volta.
    expect(getJwtRefreshSnapshot("u1", t0)).toBeNull();
  });

  it("invalidateJwtRefreshCache remove na hora", () => {
    setJwtRefreshSnapshot("u1", SNAP, 0);
    invalidateJwtRefreshCache("u1");
    expect(getJwtRefreshSnapshot("u1", 1)).toBeNull();
  });

  it("cacheia tambem o estado invalido (erased/org suspensa)", () => {
    setJwtRefreshSnapshot("u2", { invalid: true }, 0);
    expect(getJwtRefreshSnapshot("u2", 1)).toEqual({ invalid: true });
  });

  it("descarta as entradas mais antigas acima do teto", () => {
    for (let i = 0; i < 10_001; i++) setJwtRefreshSnapshot(`u${i}`, SNAP, 0);
    expect(getJwtRefreshSnapshot("u0", 1)).toBeNull();
    expect(getJwtRefreshSnapshot("u10000", 1)).toEqual(SNAP);
  });
});
