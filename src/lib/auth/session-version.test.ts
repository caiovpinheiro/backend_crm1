/**
 * SV-1: cache em memória da versão da sessão — TTL 60 s, invalidação
 * imediata, teto de entradas, normalização da claim e regra de comparação.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_VERSION_TTL_MS,
  clearSessionVersionCacheForTests,
  getCachedSessionVersion,
  invalidateSessionVersionCache,
  sessionVersionFromClaim,
  sessionVersionMatches,
  setCachedSessionVersion,
} from "@/lib/auth/session-version";

describe("session-version (cache)", () => {
  beforeEach(() => clearSessionVersionCacheForTests());

  it("devolve a versão dentro do TTL e null depois", () => {
    const t0 = 1_000_000;
    setCachedSessionVersion("u1", 3, t0);
    expect(getCachedSessionVersion("u1", t0 + SESSION_VERSION_TTL_MS - 1)).toBe(3);
    expect(getCachedSessionVersion("u1", t0 + SESSION_VERSION_TTL_MS)).toBeNull();
    // Expirado foi removido — não volta.
    expect(getCachedSessionVersion("u1", t0)).toBeNull();
  });

  it("invalidateSessionVersionCache remove na hora", () => {
    setCachedSessionVersion("u1", 1, 0);
    invalidateSessionVersionCache("u1");
    expect(getCachedSessionVersion("u1", 1)).toBeNull();
  });

  it("set reinsere a chave no fim e descarta as mais antigas acima do teto", () => {
    for (let i = 0; i < 10_001; i++) setCachedSessionVersion(`u${i}`, i, 0);
    expect(getCachedSessionVersion("u0", 1)).toBeNull();
    expect(getCachedSessionVersion("u10000", 1)).toBe(10_000);
  });
});

describe("sessionVersionFromClaim", () => {
  it("token antigo (sem claim) e valores inválidos valem 0", () => {
    expect(sessionVersionFromClaim(undefined)).toBe(0);
    expect(sessionVersionFromClaim(null)).toBe(0);
    expect(sessionVersionFromClaim("3")).toBe(0);
    expect(sessionVersionFromClaim(-1)).toBe(0);
    expect(sessionVersionFromClaim(Number.NaN)).toBe(0);
  });

  it("inteiro ≥ 0 passa; fração é truncada", () => {
    expect(sessionVersionFromClaim(0)).toBe(0);
    expect(sessionVersionFromClaim(7)).toBe(7);
    expect(sessionVersionFromClaim(2.9)).toBe(2);
  });
});

describe("sessionVersionMatches", () => {
  it("sem veredito (null) deixa passar; versão diferente rejeita", () => {
    expect(sessionVersionMatches(0, null)).toBe(true);
    expect(sessionVersionMatches(2, 2)).toBe(true);
    expect(sessionVersionMatches(1, 2)).toBe(false);
    // Token antigo (claim 0) contra usuário já revogado uma vez.
    expect(sessionVersionMatches(0, 1)).toBe(false);
  });
});
