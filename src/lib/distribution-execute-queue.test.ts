import { describe, expect, it } from "vitest";

import {
  DISTRIBUTION_EXECUTE_QUEUE_NAME,
  DISTRIBUTION_STUCK_INBOUND_JOB_ID,
  distributionExecuteJobId,
  distributionRedistributeJobId,
  shouldRunManualExecuteInline,
} from "./distribution-execute-queue";

describe("distribution execute queue", () => {
  it("uses a stable queue name consumed by worker-distribution", () => {
    expect(DISTRIBUTION_EXECUTE_QUEUE_NAME).toBe("distribution-execute");
  });

  it("builds a BullMQ execute jobId without colons", () => {
    const id = distributionExecuteJobId({
      organizationId: "clorg123",
      conversationId: "cconv456",
      triggerSource: "MANUAL",
    });
    expect(id).toBe("de-clorg123-cconv456-MANUAL");
    expect(id).not.toMatch(/:/);
  });

  it("omits jobId when there is no conversation/deal/contact target", () => {
    expect(
      distributionExecuteJobId({
        organizationId: "clorg123",
        triggerSource: "MANUAL",
      }),
    ).toBeUndefined();
  });

  it("dedupes stuck-inbound on a single jobId", () => {
    expect(DISTRIBUTION_STUCK_INBOUND_JOB_ID).toBe("dsi-stuck-inbound");
    expect(DISTRIBUTION_STUCK_INBOUND_JOB_ID).not.toMatch(/:/);
  });

  it("builds a redistribute jobId without colons", () => {
    const id = distributionRedistributeJobId(
      "clorg123",
      "user9",
      "equal",
      "entrada",
    );
    expect(id).toBe("dr-clorg123-user9-equal-entrada");
    expect(id).not.toMatch(/:/);
  });

  it("MANUAL do inbox roda inline; o resto segue a fila", () => {
    expect(shouldRunManualExecuteInline("MANUAL")).toBe(true);
    expect(shouldRunManualExecuteInline("SYSTEM")).toBe(false);
    expect(shouldRunManualExecuteInline("AI_AGENT")).toBe(false);
  });
});
