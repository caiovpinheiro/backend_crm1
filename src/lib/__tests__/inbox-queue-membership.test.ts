import { describe, expect, it } from "vitest";

import {
  activeInboxQueueGuardWhere,
  encerradasTabWhere,
  withActiveInboxQueueGuard,
} from "../inbox-queue-membership";

describe("inbox-queue-membership", () => {
  it("activeInboxQueueGuardWhere é OPEN sem closedAt — sem filtro de deal", () => {
    const where = activeInboxQueueGuardWhere();
    expect(where).toEqual({ status: "OPEN", closedAt: null });
    expect(where).not.toHaveProperty("NOT");
    expect(where).not.toHaveProperty("contact");
  });

  it("withActiveInboxQueueGuard AND-a o predicado da aba", () => {
    const inner = { assignedToId: { not: null }, lastMessageDirection: "in" };
    expect(withActiveInboxQueueGuard(inner)).toEqual({
      AND: [activeInboxQueueGuardWhere(), inner],
    });
  });

  it("encerradasTabWhere é RESOLVED ou closedAt — não deal WON/LOST", () => {
    const where = encerradasTabWhere();
    expect(where.OR).toEqual([
      { status: "RESOLVED" },
      {
        AND: [
          { status: { not: "RESOLVED" } },
          { closedAt: { not: null } },
        ],
      },
    ]);
    const serialized = JSON.stringify(where);
    expect(serialized).not.toContain("WON");
    expect(serialized).not.toContain("LOST");
  });
});
