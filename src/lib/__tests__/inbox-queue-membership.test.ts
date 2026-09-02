import { describe, expect, it } from "vitest";

import {
  activeInboxQueueGuardWhere,
  encerradasTabWhere,
  resolvidosTabWhere,
  withActiveInboxQueueGuard,
} from "../inbox-queue-membership";

describe("inbox-queue-membership", () => {
  it("activeInboxQueueGuardWhere é OPEN sem closedAt nem followUp — sem filtro de deal", () => {
    const where = activeInboxQueueGuardWhere();
    expect(where).toEqual({ status: "OPEN", closedAt: null, followUpAt: null });
    expect(where).not.toHaveProperty("NOT");
    expect(where).not.toHaveProperty("contact");
  });

  it("withActiveInboxQueueGuard AND-a o predicado da aba", () => {
    const inner = { assignedToId: { not: null }, lastMessageDirection: "in" };
    expect(withActiveInboxQueueGuard(inner)).toEqual({
      AND: [activeInboxQueueGuardWhere(), inner],
    });
  });

  it("encerradasTabWhere é RESOLVED/closedAt sem followUp — não deal WON/LOST", () => {
    const where = encerradasTabWhere();
    expect(where.AND).toEqual([
      {
        OR: [
          { status: "RESOLVED" },
          {
            AND: [
              { status: { not: "RESOLVED" } },
              { closedAt: { not: null } },
            ],
          },
        ],
      },
      { followUpAt: null },
    ]);
    const serialized = JSON.stringify(where);
    expect(serialized).not.toContain("WON");
    expect(serialized).not.toContain("LOST");
  });

  it("resolvidosTabWhere é só followUpAt — não exige encerrar", () => {
    const where = resolvidosTabWhere();
    expect(where).toEqual({ followUpAt: { not: null } });
    expect(JSON.stringify(where)).not.toContain("RESOLVED");
  });
});
