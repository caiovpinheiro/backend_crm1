import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  actorType: "INTEGRATION" as "INTEGRATION" | "HUMAN",
  existed: true,
  notifyTagAdded: vi.fn(),
  createDealEvent: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  withApiAuthContext: async (_req: Request, handler: (u: unknown) => unknown) =>
    handler({ id: "u1", role: "ADMIN", name: "Token", email: "t@x", organizationId: "org1", isSuperAdmin: false }),
}));
vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org1",
  getActorContext: () => ({ type: mocks.actorType, label: "x" }),
}));
vi.mock("@/lib/prisma-helpers", () => ({ withOrgFromCtx: (d: unknown) => d }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tag: {
      findFirst: vi.fn(async () => ({ id: "tag-ver" })),
      findUnique: vi.fn(async () => ({ name: "ver outras opções", color: "#000" })),
    },
    tagOnDeal: {
      findUnique: vi.fn(async () => (mocks.existed ? { dealId: "d1", tagId: "tag-ver" } : null)),
      upsert: vi.fn(async () => ({})),
    },
    tagOnContact: { upsert: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/services/automation-triggers", () => ({ notifyTagAdded: mocks.notifyTagAdded }));
vi.mock("@/services/deals", () => ({
  getDealById: vi.fn(async () => ({ id: "d1", contactId: "c1", stage: { pipeline: { id: "p1" } } })),
  createDealEvent: (...a: unknown[]) => {
    mocks.createDealEvent(...a);
    return Promise.resolve();
  },
  syncBoardsAfterDealChanges: vi.fn(async () => undefined),
}));

import { POST } from "./route";

const call = () =>
  POST(new Request("http://x/api/deals/d1/tags", { method: "POST", body: JSON.stringify({ tagId: "tag-ver" }) }), {
    params: Promise.resolve({ id: "d1" }),
  });

describe("POST /api/deals/:id/tags — gatilho tag_added", () => {
  beforeEach(() => {
    mocks.notifyTagAdded.mockClear();
    mocks.createDealEvent.mockClear();
  });

  it("n8n reaplica tag que o negócio já tinha: dispara a automação (DNAWORK #62742)", async () => {
    mocks.actorType = "INTEGRATION";
    mocks.existed = true;
    const res = (await call()) as Response;
    expect(res.status).toBe(200);
    expect(mocks.notifyTagAdded).toHaveBeenCalledWith(expect.objectContaining({ dealId: "d1", contactId: "c1", tagId: "tag-ver" }));
    expect(mocks.createDealEvent).not.toHaveBeenCalled();
  });

  it("pessoa na tela reaplicando tag existente: não dispara", async () => {
    mocks.actorType = "HUMAN";
    mocks.existed = true;
    await call();
    expect(mocks.notifyTagAdded).not.toHaveBeenCalled();
  });

  it("tag nova: dispara e registra o evento", async () => {
    mocks.actorType = "HUMAN";
    mocks.existed = false;
    await call();
    expect(mocks.notifyTagAdded).toHaveBeenCalledTimes(1);
    expect(mocks.createDealEvent).toHaveBeenCalledWith("d1", "u1", "TAG_ADDED", expect.anything());
  });
});
