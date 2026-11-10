import { describe, expect, it } from "vitest";

import { readStepReassign } from "../automation-workflow";

describe("readStepReassign", () => {
  it("só redistribui com a escolha explícita", () => {
    expect(readStepReassign({ ifAssigned: "reassign" })).toBe(true);
    expect(readStepReassign({ ifAssigned: "keep" })).toBe(false);
    expect(readStepReassign({})).toBe(false);
    expect(readStepReassign(null)).toBe(false);
  });
});
