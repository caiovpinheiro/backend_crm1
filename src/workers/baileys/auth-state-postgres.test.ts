/**
 * Credenciais Baileys no Postgres: gravação em fila com nova tentativa e
 * chaves gravadas em transação (tudo ou nada).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  upsertFails: 0,
  txFails: 0,
  upserts: [] as unknown[],
  txBatches: [] as number[],
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    channel: { findUnique: vi.fn(async () => ({ organizationId: "org1" })) },
    baileysAuthKey: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      upsert: vi.fn((args: unknown) => {
        // Chamada direta (credencial): conta concorrência e falhas.
        return {
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            h.inFlight++;
            h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
            setTimeout(() => {
              h.inFlight--;
              if (h.upsertFails > 0) {
                h.upsertFails--;
                reject(new Error("db caiu"));
                return;
              }
              h.upserts.push(args);
              resolve(args);
            }, 10);
          },
          __op: "upsert",
        };
      }),
      deleteMany: vi.fn(() => ({ __op: "deleteMany" })),
    },
    $transaction: vi.fn(async (ops: unknown[]) => {
      if (h.txFails > 0) {
        h.txFails--;
        throw new Error("deadlock");
      }
      h.txBatches.push(ops.length);
      return ops;
    }),
  },
}));

import { credsAreRegistered, usePostgresAuthState } from "./auth-state-postgres";

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(h, { inFlight: 0, maxInFlight: 0, upsertFails: 0, txFails: 0, upserts: [], txBatches: [] });
});
afterEach(() => vi.useRealTimers());

describe("usePostgresAuthState — credencial", () => {
  it("gravações em rajada saem uma por vez", async () => {
    const { saveCreds } = await usePostgresAuthState("ch1");
    const all = Promise.all([saveCreds(), saveCreds(), saveCreds()]);
    await vi.advanceTimersByTimeAsync(100);
    await all;
    expect(h.upserts).toHaveLength(3);
    expect(h.maxInFlight).toBe(1);
  });

  it("falha do banco tenta de novo e grava", async () => {
    h.upsertFails = 2;
    const { saveCreds } = await usePostgresAuthState("ch1");
    const p = saveCreds();
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(h.upserts).toHaveLength(1);
  });

  it("depois de 3 falhas rejeita, mas a próxima gravação ainda roda", async () => {
    h.upsertFails = 3;
    const { saveCreds } = await usePostgresAuthState("ch1");
    const first = saveCreds();
    first.catch(() => {});
    const second = saveCreds();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).rejects.toThrow("db caiu");
    await second;
    expect(h.upserts).toHaveLength(1);
  });
});

describe("usePostgresAuthState — chaves", () => {
  it("grava todas as chaves numa transação só", async () => {
    const { state } = await usePostgresAuthState("ch1");
    await state.keys.set({
      "pre-key": { "1": { public: new Uint8Array([1]), private: new Uint8Array([2]) }, "2": null },
      session: { "a@s.whatsapp.net": new Uint8Array([3]) },
    } as never);
    expect(h.txBatches).toEqual([3]);
  });

  it("transação que falha é refeita", async () => {
    h.txFails = 1;
    const { state } = await usePostgresAuthState("ch1");
    const p = state.keys.set({ session: { x: new Uint8Array([1]) } } as never);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(h.txBatches).toEqual([1]);
  });
});

describe("credsAreRegistered", () => {
  it("só com aparelho pareado (me.id)", () => {
    expect(credsAreRegistered({ me: { id: "5511999999999:3@s.whatsapp.net" } })).toBe(true);
    expect(credsAreRegistered({ me: null })).toBe(false);
    expect(credsAreRegistered({})).toBe(false);
    expect(credsAreRegistered(null)).toBe(false);
  });
});
