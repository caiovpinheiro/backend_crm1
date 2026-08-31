import { describe, expect, it } from "vitest";

import {
  CAPACITY_RELEASED_COOLDOWN_MS,
  fruitlessPassNeedsCooldown,
  shouldScheduleRetryOnCooldownSkip,
  shouldSkipCapacityReleasedCooldown,
  triggerClearsFruitlessCooldown,
} from "../pending-drain-guard";

describe("pending drain guard", () => {
  it("skips only capacity_released while the fruitless cooldown is active", () => {
    const now = 1_000_000;
    const until = now + CAPACITY_RELEASED_COOLDOWN_MS;
    expect(
      shouldSkipCapacityReleasedCooldown("capacity_released", until, now),
    ).toBe(true);
    expect(
      shouldSkipCapacityReleasedCooldown("capacity_released", until, until),
    ).toBe(false);
    expect(
      shouldSkipCapacityReleasedCooldown("capacity_released", until, until + 1),
    ).toBe(false);
    expect(shouldSkipCapacityReleasedCooldown("agent_online", until, now)).toBe(
      false,
    );
    expect(shouldSkipCapacityReleasedCooldown("new_item", until, now)).toBe(
      false,
    );
    expect(
      shouldSkipCapacityReleasedCooldown("agent_eligible", until, now),
    ).toBe(false);
    expect(shouldSkipCapacityReleasedCooldown("manual", until, now)).toBe(false);
    expect(shouldSkipCapacityReleasedCooldown("scheduled", until, now)).toBe(
      false,
    );
  });

  it("lets real eligibility / queue growth / manual / cron clear the cooldown", () => {
    expect(triggerClearsFruitlessCooldown("agent_online")).toBe(true);
    expect(triggerClearsFruitlessCooldown("agent_eligible")).toBe(true);
    expect(triggerClearsFruitlessCooldown("new_item")).toBe(true);
    expect(triggerClearsFruitlessCooldown("manual")).toBe(true);
    expect(triggerClearsFruitlessCooldown("scheduled")).toBe(true);
    expect(triggerClearsFruitlessCooldown("capacity_released")).toBe(false);
  });

  it("arms cooldown after skip or 0 assigns with remaining pending", () => {
    expect(fruitlessPassNeedsCooldown({ resolved: 0, pending: 4 })).toBe(true);
    expect(fruitlessPassNeedsCooldown({ resolved: 0, pending: 11 })).toBe(true);
    expect(fruitlessPassNeedsCooldown({ resolved: 1, pending: 4 })).toBe(false);
    expect(fruitlessPassNeedsCooldown({ resolved: 0, pending: 0 })).toBe(false);
  });

  it("uses a ~30s cooldown so outbound does not rescan every few seconds", () => {
    expect(CAPACITY_RELEASED_COOLDOWN_MS).toBe(30_000);
  });

  it("does not schedule a retry timer when the fruitless cooldown is active", () => {
    expect(shouldScheduleRetryOnCooldownSkip()).toBe(false);
  });
});
