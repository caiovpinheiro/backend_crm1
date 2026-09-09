import { describe, expect, it } from "vitest";
import { shouldAutoDistributeInbound, shouldIncludeOrgWideDrain } from "./pending-drain-guard";

describe("shouldIncludeOrgWideDrain", () => {
  it("does not dump org-wide tickets onto department members when autoOnInbound is off", () => {
    expect(
      shouldIncludeOrgWideDrain({
        autoOnInbound: false,
        respectDepartment: false,
        belongsToAnyDepartment: true,
      }),
    ).toBe(false);
  });

  it("does not dump org-wide tickets onto department members when respectDepartment is on", () => {
    expect(
      shouldIncludeOrgWideDrain({
        autoOnInbound: true,
        respectDepartment: true,
        belongsToAnyDepartment: true,
      }),
    ).toBe(false);
  });

  it("keeps org-wide drain for users without a department when autoOnInbound is on", () => {
    expect(
      shouldIncludeOrgWideDrain({
        autoOnInbound: true,
        respectDepartment: false,
        belongsToAnyDepartment: false,
      }),
    ).toBe(true);
  });
});

describe("shouldAutoDistributeInbound", () => {
  it("does not auto-assign inbound when the org opted out", () => {
    expect(shouldAutoDistributeInbound(false)).toBe(false);
    expect(shouldAutoDistributeInbound(true)).toBe(true);
  });
});
