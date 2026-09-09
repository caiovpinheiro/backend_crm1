import { describe, expect, it } from "vitest";

import {
  CAPACITY_RELEASED_COOLDOWN_MS,
  consultantHasFreeSlot,
  fruitlessCooldownIsArmed,
  fruitlessPassNeedsCooldown,
  shouldAutoDistributeInbound,
  shouldIncludeOrgWideDrain,
  shouldScheduleRetryOnCooldownSkip,
  shouldSkipCapacityReleasedCooldown,
  shouldSkipCapacityReleasedFruitlessCooldown,
  shouldSkipScheduledFruitlessCooldown,
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

  it("lets real eligibility / queue growth / manual clear the cooldown — not cron", () => {
    expect(triggerClearsFruitlessCooldown("agent_online")).toBe(true);
    expect(triggerClearsFruitlessCooldown("agent_eligible")).toBe(true);
    expect(triggerClearsFruitlessCooldown("new_item")).toBe(true);
    expect(triggerClearsFruitlessCooldown("manual")).toBe(true);
    expect(triggerClearsFruitlessCooldown("scheduled")).toBe(false);
    expect(triggerClearsFruitlessCooldown("capacity_released")).toBe(false);
  });

  it("keeps cron a no-op while the last pass was fruitless", () => {
    expect(fruitlessCooldownIsArmed(null)).toBe(false);
    expect(fruitlessCooldownIsArmed("NO_ELIGIBLE_RESPONSIBLE")).toBe(true);
    expect(shouldSkipScheduledFruitlessCooldown("scheduled", true)).toBe(true);
    expect(shouldSkipScheduledFruitlessCooldown("scheduled", false)).toBe(
      false,
    );
    expect(shouldSkipScheduledFruitlessCooldown("manual", true)).toBe(false);
    expect(shouldSkipScheduledFruitlessCooldown("new_item", true)).toBe(false);
  });

  it("skips only capacity_released when the published fruitless flag is armed", () => {
    expect(
      shouldSkipCapacityReleasedFruitlessCooldown("capacity_released", true),
    ).toBe(true);
    expect(
      shouldSkipCapacityReleasedFruitlessCooldown("capacity_released", false),
    ).toBe(false);
    expect(
      shouldSkipCapacityReleasedFruitlessCooldown("scheduled", true),
    ).toBe(false);
    expect(
      shouldSkipCapacityReleasedFruitlessCooldown("agent_online", true),
    ).toBe(false);
    expect(
      shouldSkipCapacityReleasedFruitlessCooldown("agent_eligible", true),
    ).toBe(false);
    expect(shouldSkipCapacityReleasedFruitlessCooldown("new_item", true)).toBe(
      false,
    );
    expect(shouldSkipCapacityReleasedFruitlessCooldown("manual", true)).toBe(
      false,
    );
  });

  it("arms cooldown after skip or 0 assigns with remaining pending", () => {
    expect(fruitlessPassNeedsCooldown({ resolved: 0, pending: 4 })).toBe(true);
    expect(fruitlessPassNeedsCooldown({ resolved: 0, pending: 11 })).toBe(true);
    expect(fruitlessPassNeedsCooldown({ resolved: 1, pending: 4 })).toBe(false);
    expect(fruitlessPassNeedsCooldown({ resolved: 0, pending: 0 })).toBe(false);
  });

  it("uses a ~30s cooldown so outbound does not rescan every few seconds", () => {
    expect(CAPACITY_RELEASED_COOLDOWN_MS).toBe(30_000);
    expect(consultantHasFreeSlot(4, 5)).toBe(true);
    expect(consultantHasFreeSlot(5, 5)).toBe(false);
  });

  it("does not schedule a retry timer when the fruitless cooldown is active", () => {
    expect(shouldScheduleRetryOnCooldownSkip()).toBe(false);
  });
});

describe("shouldIncludeOrgWideDrain", () => {
  it("modo clássico (auto inbound + sem respeitar depto) drena org-wide", () => {
    expect(
      shouldIncludeOrgWideDrain({ autoOnInbound: true, respectDepartment: false }),
    ).toBe(true);
  });

  it("respeitar departamento: conversa sem depto não cai no pool geral", () => {
    expect(
      shouldIncludeOrgWideDrain({ autoOnInbound: true, respectDepartment: true }),
    ).toBe(false);
  });

  it("autoOnInbound desligado: só execute_distribution atribui", () => {
    expect(
      shouldIncludeOrgWideDrain({ autoOnInbound: false, respectDepartment: false }),
    ).toBe(false);
    expect(
      shouldIncludeOrgWideDrain({ autoOnInbound: false, respectDepartment: true }),
    ).toBe(false);
  });
});

describe("shouldAutoDistributeInbound", () => {
  it("ligado: inbound dispara o motor", () => {
    expect(shouldAutoDistributeInbound(true)).toBe(true);
  });

  it("desligado: inbound não atribui — espera o passo da automação", () => {
    expect(shouldAutoDistributeInbound(false)).toBe(false);
  });
});
