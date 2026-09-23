process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
process.env.SSE_ENABLE_REDIS_PUBSUB = "0";

import { describe, expect, it } from "vitest";

import { lostSseAccess } from "@/lib/sse-membership-watch";

describe("lostSseAccess", () => {
  const e = (userId: string, organizationId: string | null, isSuperAdmin = false) => ({
    userId,
    organizationId,
    isSuperAdmin,
  });

  it("mantém quem segue na org", () => {
    expect(lostSseAccess([e("u1", "o1")], [{ id: "u1", isErased: false, organizationId: "o1" }])).toEqual([]);
  });

  it("revoga apagado, removido ou que trocou de org", () => {
    expect(
      lostSseAccess(
        [e("apagado", "o1"), e("sumiu", "o1"), e("trocou", "o1")],
        [
          { id: "apagado", isErased: true, organizationId: "o1" },
          { id: "trocou", isErased: false, organizationId: "o2" },
        ],
      ),
    ).toEqual([
      { userId: "apagado", organizationId: "o1" },
      { userId: "sumiu", organizationId: "o1" },
      { userId: "trocou", organizationId: "o1" },
    ]);
  });

  it("super-admin fora da org não é revogado", () => {
    expect(
      lostSseAccess([e("sa", "o1", true)], [{ id: "sa", isErased: false, organizationId: null }]),
    ).toEqual([]);
  });
});
