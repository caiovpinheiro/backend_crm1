import { describe, expect, it } from "vitest";

import { isOrgOwnedStorageUrl } from "@/lib/storage/read-for-send";

const ORG = "cmrmbn2lh0uz2nm016beqgbwb";

describe("isOrgOwnedStorageUrl", () => {
  it("aceita /api/storage da org", () => {
    expect(
      isOrgOwnedStorageUrl(
        `/api/storage/${ORG}/automation-media/auto_1784909522024_ei2ntt.mp4`,
      ),
    ).toBe(true);
  });

  it("aceita URL absoluta com o mesmo path", () => {
    expect(
      isOrgOwnedStorageUrl(
        `https://api.bwipo.com/api/storage/${ORG}/automation-media/auto_1784909522024_ei2ntt.mp4`,
      ),
    ).toBe(true);
  });

  it("rejeita URL pública que não é storage", () => {
    expect(isOrgOwnedStorageUrl("https://example.com/video.mp4")).toBe(false);
  });
});
