/**
 * SEC-15 — CSP em Report-Only e X-Frame-Options único (mesma fonte para
 * next.config.ts e middleware).
 */
import { describe, expect, it } from "vitest";

import {
  CSP_REPORT_PATH,
  FRAME_OPTIONS_VALUE,
  PERMISSIONS_POLICY_VALUE,
  applySecurityHeaders,
  baseSecurityHeaders,
  buildCspEnforced,
  buildCspReportOnly,
} from "./security-headers";

describe("security-headers", () => {
  it("CSP completa só em Report-Only, com report-uri interno e frame-ancestors 'self'", () => {
    const csp = buildCspReportOnly();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain(`report-uri ${CSP_REPORT_PATH}`);
    expect(csp).not.toMatch(/report-uri https?:\/\//);

    const keys = baseSecurityHeaders().map((h) => h.key);
    expect(keys).toContain("Content-Security-Policy-Report-Only");
  });

  it("CSP enforced é mínima: sem script-src/default-src (páginas inline continuam funcionando)", () => {
    const enforced = buildCspEnforced();
    expect(enforced).toBe("base-uri 'self'; frame-ancestors 'self'");
    const csp = baseSecurityHeaders().filter((h) => h.key === "Content-Security-Policy");
    expect(csp).toHaveLength(1);
    expect(csp[0].value).toBe(enforced);
  });

  it("applySecurityHeaders escreve todos os headers base", () => {
    const headers = new Headers();
    applySecurityHeaders(headers);
    for (const { key, value } of baseSecurityHeaders()) {
      expect(headers.get(key)).toBe(value);
    }
    expect(headers.get("Permissions-Policy")).toBe(PERMISSIONS_POLICY_VALUE);
  });

  it("X-Frame-Options único: SAMEORIGIN (cockpit é embutido via rewrite same-origin)", () => {
    expect(FRAME_OPTIONS_VALUE).toBe("SAMEORIGIN");
    const xfo = baseSecurityHeaders().filter((h) => h.key === "X-Frame-Options");
    expect(xfo).toHaveLength(1);
    expect(xfo[0].value).toBe("SAMEORIGIN");
  });

  it("next.config.ts usa a mesma fonte (sem DENY residual)", async () => {
    const cfg = (await import("../../next.config")).default;
    const groups = await cfg.headers!();
    const all = groups.flatMap((g) => g.headers);
    const xfo = all.filter((h) => h.key === "X-Frame-Options");
    expect(xfo).toHaveLength(1);
    expect(xfo[0].value).toBe("SAMEORIGIN");
    expect(all.some((h) => h.key === "Content-Security-Policy-Report-Only")).toBe(true);
    expect(all.filter((h) => h.key === "Content-Security-Policy").map((h) => h.value)).toEqual([
      buildCspEnforced(),
    ]);
    expect(all.filter((h) => h.key === "Permissions-Policy")).toHaveLength(1);
    expect(all.some((h) => h.key === "X-Content-Type-Options" && h.value === "nosniff")).toBe(true);
  });
});
