import { describe, expect, it } from "vitest";

import { matchesIdleLead } from "../idle-leads";

const now = new Date("2026-10-14T14:00:00.000Z");

describe("matchesIdleLead", () => {
  it("cliente há 4h entra em +3h e fica de fora em +5h", () => {
    const row = {
      now,
      lastMessageAt: new Date("2026-10-14T10:00:00.000Z"),
      lastMessageDirection: "in" as const,
      createdAt: new Date("2026-10-14T08:00:00.000Z"),
    };
    expect(matchesIdleLead({ ...row, idleMinutes: 180, direction: "in" })).toBe(true);
    expect(matchesIdleLead({ ...row, idleMinutes: 300, direction: "in" })).toBe(false);
  });

  it("última mensagem do consultor não entra como cliente", () => {
    const row = {
      now,
      lastMessageAt: new Date("2026-10-14T10:00:00.000Z"),
      lastMessageDirection: "out" as const,
      createdAt: new Date("2026-10-14T08:00:00.000Z"),
    };
    expect(matchesIdleLead({ ...row, idleMinutes: 180, direction: "out" })).toBe(true);
    expect(matchesIdleLead({ ...row, idleMinutes: 180, direction: "in" })).toBe(false);
  });

  it("sem mensagem entra só em qualquer um, pelo createdAt", () => {
    const row = {
      now: new Date("2026-10-14T12:00:00.000Z"),
      lastMessageAt: null,
      lastMessageDirection: null,
      createdAt: new Date("2026-10-14T08:00:00.000Z"),
      idleMinutes: 180,
    };
    expect(matchesIdleLead(row)).toBe(true);
    expect(matchesIdleLead({ ...row, direction: "in" })).toBe(false);
    expect(matchesIdleLead({ ...row, direction: "out" })).toBe(false);
  });

  it("+30 min entra e +1h fica de fora quando a mensagem tem 40 min", () => {
    const row = {
      now,
      lastMessageAt: new Date("2026-10-14T13:20:00.000Z"),
      lastMessageDirection: "in" as const,
      createdAt: new Date("2026-10-14T08:00:00.000Z"),
    };
    expect(matchesIdleLead({ ...row, idleMinutes: 30 })).toBe(true);
    expect(matchesIdleLead({ ...row, idleMinutes: 60 })).toBe(false);
  });
});
