/**
 * Idempotência do S2S sobre um `webchat_ingress_keys` em memória (unique
 * por canal + chave, como no banco).
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  organizationId: string;
  channelId: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  response: unknown;
  createdAt: Date;
  completedAt: Date | null;
};

const store = vi.hoisted(() => ({ rows: [] as Row[], seq: 0 }));

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cur = (row as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const lt = (v as { lt?: Date }).lt;
      return lt ? (cur as Date) < lt : true;
    }
    return v instanceof Date ? (cur as Date).getTime() === v.getTime() : cur === v;
  });
}

vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: <T,>(d: T) => ({ ...d, organizationId: "org-1" }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    webchatIngressKey: {
      create: async ({ data }: { data: Omit<Row, "id" | "response" | "completedAt"> }) => {
        if (store.rows.some((r) => r.channelId === data.channelId && r.idempotencyKey === data.idempotencyKey)) {
          throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" });
        }
        const row: Row = { ...data, id: `ik-${++store.seq}`, response: null, completedAt: null };
        store.rows.push(row);
        return { id: row.id };
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        store.rows.find((r) => matches(r, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = store.rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = store.rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = store.rows.length;
        store.rows = store.rows.filter((r) => !matches(r, where));
        return { count: before - store.rows.length };
      },
    },
  },
}));

import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  hashS2SBody,
  purgeExpiredIngressKeys,
} from "@/lib/webchat/s2s/idempotency";

const H1 = hashS2SBody('{"external_id":"ext-1","text":"a"}');
const H2 = hashS2SBody('{"external_id":"ext-1","text":"b"}');
const RESPONSE = { conversation_id: "conv-1", url: "https://acme.example.test/inbox?c=1" };

beforeEach(() => {
  store.rows = [];
  store.seq = 0;
});

describe("idempotência do S2S", () => {
  it("primeira vez reserva; repetição concluída devolve a mesma resposta", async () => {
    const first = await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1 });
    expect(first.kind).toBe("claimed");
    await completeIdempotencyKey((first as { id: string }).id, RESPONSE);
    const again = await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1 });
    expect(again).toEqual({ kind: "replay", response: RESPONSE });
    expect(store.rows).toHaveLength(1);
  });

  it("mesma chave com outro corpo → reused", async () => {
    await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1 });
    expect(await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H2 })).toEqual({ kind: "reused" });
  });

  it("em andamento → in_progress; travado há mais de 2 min → retomável", async () => {
    const t0 = new Date("2026-10-28T12:00:00Z");
    await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1, now: t0 });
    const soon = new Date(t0.getTime() + 30_000);
    expect((await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1, now: soon })).kind).toBe(
      "in_progress",
    );
    const late = new Date(t0.getTime() + 3 * 60_000);
    expect((await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1, now: late })).kind).toBe(
      "claimed",
    );
  });

  it("falhou → a mesma chave reprocessa (não vira replay de erro)", async () => {
    const first = await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1 });
    await failIdempotencyKey((first as { id: string }).id);
    const retry = await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1 });
    expect(retry).toEqual({ kind: "claimed", id: (first as { id: string }).id });
  });

  it("chave é por canal: a mesma chave em outro canal é independente", async () => {
    await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1 });
    expect((await claimIdempotencyKey({ channelId: "ch-2", key: "k1", requestHash: H2 })).kind).toBe("claimed");
  });

  it("vale 24 h: depois disso a chave volta a ser nova; a limpeza apaga as vencidas", async () => {
    const t0 = new Date("2026-10-28T12:00:00Z");
    const first = await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H1, now: t0 });
    await completeIdempotencyKey((first as { id: string }).id, RESPONSE);
    const dayLater = new Date(t0.getTime() + 25 * 3600_000);
    expect((await claimIdempotencyKey({ channelId: "ch-1", key: "k1", requestHash: H2, now: dayLater })).kind).toBe(
      "claimed",
    );

    store.rows = [];
    await claimIdempotencyKey({ channelId: "ch-1", key: "velha", requestHash: H1, now: t0 });
    await claimIdempotencyKey({ channelId: "ch-1", key: "nova", requestHash: H1, now: dayLater });
    expect(await purgeExpiredIngressKeys("ch-1", dayLater)).toBe(1);
    expect(store.rows.map((r) => r.idempotencyKey)).toEqual(["nova"]);
  });
});
