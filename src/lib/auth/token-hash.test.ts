import { describe, expect, it } from "vitest";

import {
  generateNumericCode,
  generateUrlToken,
  hashSecret,
} from "./token-hash";

describe("token-hash", () => {
  it("hashSecret é determinístico e hex de 64 chars", () => {
    const a = hashSecret("abc");
    const b = hashSecret("abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecret("abd")).not.toBe(a);
  });

  it("generateUrlToken devolve raw + hash correspondente", () => {
    const t = generateUrlToken();
    expect(t.raw.length).toBeGreaterThan(20);
    expect(t.hash).toBe(hashSecret(t.raw));
  });

  it("generateNumericCode gera 6 dígitos", () => {
    const c = generateNumericCode(6);
    expect(c.raw).toMatch(/^\d{6}$/);
    expect(c.hash).toBe(hashSecret(c.raw));
  });
});
