/**
 * Retenção do webchat v2: por canal, com o `retentionDays` dele, apaga
 * eventos (`createdAt`) e contextos parados (`updatedAt`) além do corte,
 * no contexto de org do canal. Banco simulado em memória.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; organizationId: string; channelId: string; createdAt?: Date; updatedAt?: Date };

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  const db = { events: [] as Row[], contexts: [] as Row[], orgSeen: [] as (string | null | undefined)[] };
  return { logger, db, channels: vi.fn(), tryClaim: vi.fn(async () => true) };
});

vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/cache", () => ({ cache: { tryClaim: mocks.tryClaim } }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: { channel: { findMany: mocks.channels } } }));
vi.mock("@/lib/prisma", async () => {
  const { getRequestContext } = await import("@/lib/request-context");
  type Where = { channelId?: string; createdAt?: { lt: Date }; updatedAt?: { lt: Date }; id?: { in: string[] } };
  const hit = (r: Row, w: Where) => {
    // Simula o scoping de tenant do prisma: só a org do contexto.
    if (r.organizationId !== getRequestContext()?.organizationId) return false;
    if (w.channelId && r.channelId !== w.channelId) return false;
    if (w.createdAt && !(r.createdAt! < w.createdAt.lt)) return false;
    if (w.updatedAt && !(r.updatedAt! < w.updatedAt.lt)) return false;
    if (w.id && !w.id.in.includes(r.id)) return false;
    return true;
  };
  const table = (key: "events" | "contexts") => ({
    findMany: async ({ where, take }: { where: Where; take: number }) => {
      mocks.db.orgSeen.push(getRequestContext()?.organizationId);
      return mocks.db[key].filter((r) => hit(r, where)).slice(0, take).map((r) => ({ id: r.id }));
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const before = mocks.db[key].length;
      mocks.db[key] = mocks.db[key].filter((r) => !hit(r, where));
      return { count: before - mocks.db[key].length };
    },
  });
  return { prisma: { webchatEvent: table("events"), webchatLiveContext: table("contexts") } };
});

import { sweepWebchatRetention, webchatRetentionCutoff } from "@/lib/webchat/tracking/retention";
import { runWebchatRetentionTick } from "@/lib/webchat/tracking/retention-sweeper";

const NOW = new Date("2026-10-28T06:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  mocks.db.events = [];
  mocks.db.contexts = [];
  mocks.db.orgSeen = [];
  mocks.tryClaim.mockResolvedValue(true);
  delete process.env.WEBCHAT_RETENTION_WORKER;
  mocks.channels.mockResolvedValue([
    { id: "ch-a", organizationId: "org-1", config: { v2: { events: { retentionDays: 7 } } } },
    { id: "ch-b", organizationId: "org-2", config: {} }, // padrão 30 dias
  ]);
});

describe("sweepWebchatRetention", () => {
  it("apaga por canal com o retentionDays dele; o resto fica", async () => {
    mocks.db.events = [
      { id: "e1", organizationId: "org-1", channelId: "ch-a", createdAt: daysAgo(8) },
      { id: "e2", organizationId: "org-1", channelId: "ch-a", createdAt: daysAgo(6) },
      { id: "e3", organizationId: "org-2", channelId: "ch-b", createdAt: daysAgo(8) },
      { id: "e4", organizationId: "org-2", channelId: "ch-b", createdAt: daysAgo(31) },
    ];
    mocks.db.contexts = [
      { id: "c1", organizationId: "org-1", channelId: "ch-a", updatedAt: daysAgo(10) },
      { id: "c2", organizationId: "org-1", channelId: "ch-a", updatedAt: daysAgo(1) },
      { id: "c3", organizationId: "org-2", channelId: "ch-b", updatedAt: daysAgo(10) },
    ];
    const run = await sweepWebchatRetention({ now: NOW, pauseMs: 0 });
    expect(mocks.db.events.map((e) => e.id)).toEqual(["e2", "e3"]);
    expect(mocks.db.contexts.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(run.channels).toEqual([
      expect.objectContaining({ channelId: "ch-a", retentionDays: 7, events: 1, contexts: 1, hitCap: false }),
      expect.objectContaining({ channelId: "ch-b", retentionDays: 30, events: 1, contexts: 0, hitCap: false }),
    ]);
  });

  it("cada canal roda no contexto da própria org (não apaga de outra org)", async () => {
    // Linha da org-2 com channelId do canal da org-1: o scoping a protege.
    mocks.db.events = [{ id: "x", organizationId: "org-2", channelId: "ch-a", createdAt: daysAgo(100) }];
    mocks.channels.mockResolvedValue([
      { id: "ch-a", organizationId: "org-1", config: { v2: { events: { retentionDays: 1 } } } },
    ]);
    await sweepWebchatRetention({ now: NOW, pauseMs: 0 });
    expect(mocks.db.events).toHaveLength(1);
    expect(new Set(mocks.db.orgSeen)).toEqual(new Set(["org-1"]));
  });

  it("lotes com teto: hitCap quando sobra", async () => {
    mocks.db.events = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i}`,
      organizationId: "org-1",
      channelId: "ch-a",
      createdAt: daysAgo(30),
    }));
    const run = await sweepWebchatRetention({ now: NOW, batchSize: 2, maxBatches: 2, pauseMs: 0 });
    expect(run.channels[0]).toMatchObject({ events: 4, hitCap: true });
    expect(mocks.db.events).toHaveLength(1);
  });

  it("corte = agora − retentionDays", () => {
    expect(webchatRetentionCutoff(NOW, 30).toISOString()).toBe("2026-09-28T06:00:00.000Z");
  });
});

describe("runWebchatRetentionTick", () => {
  it("uma instância por dia (trava no Redis) e desligável por env", async () => {
    mocks.tryClaim.mockResolvedValueOnce(false);
    expect(await runWebchatRetentionTick(NOW)).toEqual({ ran: false, reason: "claimed-elsewhere" });
    expect(mocks.tryClaim).toHaveBeenCalledWith("webchat-retention:2026-10-28", expect.any(Number));

    process.env.WEBCHAT_RETENTION_WORKER = "0";
    expect(await runWebchatRetentionTick(NOW)).toEqual({ ran: false, reason: "disabled" });

    delete process.env.WEBCHAT_RETENTION_WORKER;
    const res = await runWebchatRetentionTick(NOW);
    expect(res.ran).toBe(true);
  });
});
