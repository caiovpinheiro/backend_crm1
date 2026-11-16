import { describe, expect, it } from "vitest";

import { shouldFireDealTagAdded } from "@/lib/deal-tag-trigger";

describe("shouldFireDealTagAdded", () => {
  it("tag nova dispara, venha de quem vier", () => {
    expect(shouldFireDealTagAdded({ alreadyHadTag: false, viaIntegration: false })).toBe(true);
    expect(shouldFireDealTagAdded({ alreadyHadTag: false, viaIntegration: true })).toBe(true);
  });

  it("integração reaplicando tag que o negócio já tinha dispara (DNAWORK #62742)", () => {
    expect(shouldFireDealTagAdded({ alreadyHadTag: true, viaIntegration: true })).toBe(true);
  });

  it("pessoa na tela reaplicando tag existente não dispara", () => {
    expect(shouldFireDealTagAdded({ alreadyHadTag: true, viaIntegration: false })).toBe(false);
  });
});
