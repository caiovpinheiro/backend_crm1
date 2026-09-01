import { describe, expect, it } from "vitest";

import { slugFromRequestHost } from "./tenant-url";

describe("slugFromRequestHost", () => {
  it("extrai o slug do subdomínio", () => {
    expect(slugFromRequestHost("acme.bwipo.com")).toBe("acme");
    expect(slugFromRequestHost("acme.bwipo.com:443")).toBe("acme");
  });

  it("apex e www não são tenant", () => {
    expect(slugFromRequestHost("bwipo.com")).toBeNull();
    expect(slugFromRequestHost("www.bwipo.com")).toBeNull();
    expect(slugFromRequestHost("api.bwipo.com")).toBeNull();
  });
});
