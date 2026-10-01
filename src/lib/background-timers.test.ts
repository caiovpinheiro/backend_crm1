import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backgroundTimersStopped,
  resetBackgroundTimersForTests,
  scheduleBackgroundInterval,
  scheduleBackgroundTimeout,
  stopBackgroundTimers,
} from "./background-timers";

describe("background-timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBackgroundTimersForTests();
  });
  afterEach(() => {
    resetBackgroundTimersForTests();
    vi.useRealTimers();
  });

  it("stop cancela timeout e interval pendentes", () => {
    const t = vi.fn();
    const i = vi.fn();
    scheduleBackgroundTimeout(t, 1_000);
    scheduleBackgroundInterval(i, 500);
    vi.advanceTimersByTime(600);
    expect(i).toHaveBeenCalledTimes(1);
    expect(stopBackgroundTimers()).toBe(2);
    vi.advanceTimersByTime(5_000);
    expect(t).not.toHaveBeenCalled();
    expect(i).toHaveBeenCalledTimes(1);
    expect(backgroundTimersStopped()).toBe(true);
  });

  it("depois do stop não agenda ciclo novo (encadeamento setTimeout(tick))", () => {
    let ticks = 0;
    const tick = () => {
      ticks++;
      scheduleBackgroundTimeout(tick, 100);
    };
    scheduleBackgroundTimeout(tick, 0);
    vi.advanceTimersByTime(250);
    expect(ticks).toBe(3);
    stopBackgroundTimers();
    expect(scheduleBackgroundTimeout(tick, 100)).toBeNull();
    expect(scheduleBackgroundInterval(tick, 100)).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(3);
  });

  it("timeout disparado sai do conjunto rastreado", () => {
    scheduleBackgroundTimeout(() => {}, 10);
    vi.advanceTimersByTime(20);
    expect(stopBackgroundTimers()).toBe(0);
  });
});
