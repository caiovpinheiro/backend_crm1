import { describe, expect, it } from "vitest";

import {
  DISTRIBUTION_DRAIN_QUEUE_NAME,
  allowInlineDistributionFallback,
  distributionDrainJobId,
  isFreshDrainEnqueue,
} from "./distribution-drain-queue";
import { fruitlessCooldownRedisKey } from "@/services/distribution/pending-drain-store";

describe("distribution drain queue", () => {
  it("uses a stable queue name consumed by worker-distribution", () => {
    expect(DISTRIBUTION_DRAIN_QUEUE_NAME).toBe("distribution-drain");
  });

  it("builds a BullMQ jobId without colons", () => {
    const id = distributionDrainJobId("clorg123", "capacity_released");
    expect(id).toBe("dd-clorg123-capacity_released");
    expect(id).not.toMatch(/:/);
  });

  it("scopes the fruitless Redis flag per org", () => {
    expect(fruitlessCooldownRedisKey("org_a")).toBe("dist:fruitless:org_a");
  });

  it("allows inline drain fallback in test/dev only", () => {
    expect(allowInlineDistributionFallback()).toBe(true);
  });

  it("treats only a newly added job as a fresh enqueue", () => {
    expect(isFreshDrainEnqueue("added")).toBe(true);
    expect(isFreshDrainEnqueue("exists")).toBe(false);
    expect(isFreshDrainEnqueue(null)).toBe(false);
  });
});
