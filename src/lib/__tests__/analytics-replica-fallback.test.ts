import { describe, expect, it } from "vitest";

import { isReplicaConnectionError } from "@/lib/analytics";
import { flattenDealListItem } from "@/services/deals";

describe("isReplicaConnectionError", () => {
  it("reconhece timeout e P1001", () => {
    expect(isReplicaConnectionError(new Error("connect timeout"))).toBe(true);
    expect(isReplicaConnectionError(new Error("P1001: Can't reach database"))).toBe(
      true,
    );
    expect(isReplicaConnectionError(new Error("invalid query"))).toBe(false);
  });
});

describe("flattenDealListItem", () => {
  it("achata tags do deal e do contato", () => {
    const flat = flattenDealListItem({
      id: "d1",
      tags: [{ tag: { id: "t1", name: "VIP", color: "#00f" } }],
      contact: {
        id: "c1",
        tags: [{ tag: { id: "t2", name: "Lead", color: null } }],
      },
    });
    expect(flat.tags).toEqual([{ id: "t1", name: "VIP", color: "#00f" }]);
    expect(flat.contact?.tags).toEqual([{ id: "t2", name: "Lead", color: null }]);
  });
});
