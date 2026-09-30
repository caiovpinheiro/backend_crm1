/**
 * PATCH /api/dashboard/layout — merge de meta e recusa de identidade no body.
 * Sem DB: mocka auth e o client Prisma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, update, create } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

const sessionUser = vi.hoisted(() => ({
  id: "user-1",
  organizationId: "org-1" as string | null,
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: (
    handler: (session: { user: { id: string; organizationId: string | null } }) => Promise<Response>,
  ) => handler({ user: sessionUser }),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        userDashboardLayout: { findFirst, update, create },
      }),
  },
}));

import { PATCH } from "@/app/api/dashboard/layout/route";

function patch(body: unknown): Request {
  return new Request("https://api.test/api/dashboard/layout", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stored = {
  id: "lay-1",
  preset: "custom",
  data: {
    visibleWidgets: ["kpis"],
    layout: { kpis: { i: "kpis", x: 0, y: 0, w: 4, h: 2 } },
    meta: { v: 2, negocios: { version: 2, cards: ["a"] } },
  },
};

describe("PATCH /api/dashboard/layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionUser.id = "user-1";
    sessionUser.organizationId = "org-1";
    findFirst.mockResolvedValue(stored);
    update.mockImplementation(async ({ data }: { data: { data: unknown } }) => ({
      id: "lay-1",
      updatedAt: new Date("2026-09-30T12:00:00.000Z"),
      ...data,
    }));
    create.mockResolvedValue({
      id: "lay-new",
      updatedAt: new Date("2026-09-30T12:00:00.000Z"),
    });
  });

  it("mescla service e preserva negocios; userId da sessão, não do body", async () => {
    const res = await PATCH(
      patch({ meta: { v: 2, service: { order: ["agora"], hidden: [] } } }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({ where: { userId: "user-1", name: "Padrão" } });
    const saved = update.mock.calls[0][0].data.data as {
      meta: { negocios: unknown; service: unknown; v: unknown };
    };
    expect(saved.meta.negocios).toEqual({ version: 2, cards: ["a"] });
    expect(saved.meta.service).toEqual({ order: ["agora"], hidden: [] });
    expect(saved.meta.v).toBe(2);
    expect(update.mock.calls[0][0].data.organizationId).toBe("org-1");
    expect(create).not.toHaveBeenCalled();
  });

  it("recusa organizationId e userId no body", async () => {
    const res = await PATCH(
      patch({
        organizationId: "outra-org",
        userId: "outro-user",
        meta: { ui: { tab: "deals" } },
      }),
    );
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("falha de escrita responde 500", async () => {
    update.mockRejectedValue(new Error("db down"));
    const res = await PATCH(patch({ meta: { ui: { tab: "service" } } }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as { ok?: boolean };
    expect(json.ok).toBeUndefined();
  });
});
