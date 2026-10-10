import { describe, expect, it } from "vitest";

import { floorToMinute, reportFingerprint } from "@/lib/report-fingerprint";

describe("reportFingerprint", () => {
  it("ignora ordem e repetição de ids", () => {
    expect(reportFingerprint({ userIds: ["b", "a", "b"], departmentIds: ["x"] })).toBe(
      reportFingerprint({ departmentIds: ["x"], userIds: ["a", "b"] }),
    );
  });

  it("arredonda datas ao minuto", () => {
    const a = new Date("2026-10-06T12:00:05.123Z");
    const b = new Date("2026-10-06T12:00:59.999Z");
    const c = new Date("2026-10-06T12:01:00.000Z");
    expect(reportFingerprint({ from: a })).toBe(reportFingerprint({ from: b }));
    expect(reportFingerprint({ from: a })).not.toBe(reportFingerprint({ from: c }));
    expect(floorToMinute(a)).toBe(Date.parse("2026-10-06T12:00:00.000Z"));
  });

  it("muda quando muda qualquer parâmetro", () => {
    const base = { from: new Date(0), clock: "business", userIds: ["a"] };
    expect(reportFingerprint(base)).not.toBe(reportFingerprint({ ...base, clock: "elapsed" }));
    expect(reportFingerprint(base)).not.toBe(reportFingerprint({ ...base, userIds: ["a", "b"] }));
  });
});
