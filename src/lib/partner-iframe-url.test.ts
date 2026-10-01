import { describe, expect, it } from "vitest";

import { isSafePartnerIframeSrc } from "./partner-iframe-url";

describe("isSafePartnerIframeSrc", () => {
  const opts = { tenantBaseDomain: "bwipo.com", apiOrigin: "https://api.bwipo.com" };

  it("aceita https do parceiro", () => {
    expect(isSafePartnerIframeSrc("https://app.parceiro.com/embed", opts)).toBe(
      true,
    );
  });

  it("rejeita hosts do tenant e da API", () => {
    expect(isSafePartnerIframeSrc("https://acme.bwipo.com/", opts)).toBe(false);
    expect(isSafePartnerIframeSrc("https://api.bwipo.com/", opts)).toBe(false);
    expect(isSafePartnerIframeSrc("javascript:alert(1)", opts)).toBe(false);
  });
});
