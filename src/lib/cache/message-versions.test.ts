/**
 * Versão + diário das mensagens por conversa (`message-versions.ts`):
 * bump atômico com a entrada no diário, leitura sem memória local (outra
 * réplica enxerga na hora), isolamento por org, cursor/ETag e o plano do
 * delta (novo, alterado, excluído, reset).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
    emu: null as null | import("@/test-setup/fake-msgs-redis").FakeMsgsScripts,
  };
});

vi.mock("ioredis", async () => {
  const base = (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis);
  const { fakeMsgsScripts } = await import("@/test-setup/fake-msgs-redis");
  const { fakeRedisRaw } = await import("@/test-setup/fake-cache-redis");
  h.emu = fakeMsgsScripts({
    get: (k) => fakeRedisRaw(h.redis, k),
    set: (k, v) => h.redis.store.set(k, { value: v, expiresAt: null }),
  });
  class FakeWithMsgs extends base.default {
    async eval(script: string, n: number, ...rest: string[]) {
      if (/--\s*crm:msgs-/.test(script)) {
        h.redis.calls.push(`EVAL ${rest.slice(0, n).join(" ")}`);
        if (h.redis.down) throw new Error("Connection is closed.");
        return h.emu!.eval(script, n, rest);
      }
      return super.eval(script, n, ...rest);
    }
  }
  return { default: FakeWithMsgs };
});
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  cursorEtagMatches,
  decodeTimelineCursor,
  encodeTimelineCursor,
  messageLogKey,
  messageVersionKey,
  noteMessageChange,
  pageEtagMatches,
  pageEtagTag,
  planTimelineDelta,
  readMessageTimelineState,
  timelineCursorFromState,
  timelineEtag,
} from "./message-versions";

const ORG_A = "org_a";
const ORG_B = "org_b";
const CONV = "conv_1";

beforeEach(() => {
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  h.emu?.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

async function cursorOf(org: string, user: string, ids: string[]) {
  const state = await readMessageTimelineState(org, ids);
  expect(state).not.toBeNull();
  return { state: state!, cursor: timelineCursorFromState(org, user, state!, 0) };
}

describe("message-versions — bump e diário", () => {
  it("bump sobe a versão e anota o que mudou numa ida ao Redis", async () => {
    const { cursor: before } = await cursorOf(ORG_A, "u1", [CONV]);
    h.redis.calls.length = 0;
    await noteMessageChange(ORG_A, CONV, "new", "msg_1", "wamid.1");
    expect(h.redis.calls).toEqual([
      `EVAL ${messageVersionKey(ORG_A, CONV)} ${messageLogKey(ORG_A, CONV)}`,
    ]);
    const { cursor: after } = await cursorOf(ORG_A, "u1", [CONV]);
    expect(after.versions[0]).toBe(before.versions[0]! + 1);
    const log = h.emu!.log(messageLogKey(ORG_A, CONV));
    expect(log.at(-1)).toMatch(/^\d+:new:[0-9a-z]+:msg_1,wamid\.1$/);
  });

  it("mesmo id de conversa em outra org não colide", async () => {
    const { cursor: a0 } = await cursorOf(ORG_A, "u1", [CONV]);
    const { cursor: b0 } = await cursorOf(ORG_B, "u2", [CONV]);
    await noteMessageChange(ORG_A, CONV, "new", "msg_1");
    const { cursor: a1 } = await cursorOf(ORG_A, "u1", [CONV]);
    const { cursor: b1 } = await cursorOf(ORG_B, "u2", [CONV]);
    expect(a1.versions[0]).toBe(a0.versions[0]! + 1);
    expect(b1.versions).toEqual(b0.versions);
    expect(messageVersionKey(ORG_A, CONV)).not.toBe(messageVersionKey(ORG_B, CONV));
    // Cursor de uma org nunca vale para a outra (org no hash do usuário/conjunto).
    expect(a0.userHash).not.toBe(b0.userHash);
    expect(a0.setHash).not.toBe(b0.setHash);
  });

  it("sem org ou conversa não faz nada; Redis fora não lança e vira `*` depois", async () => {
    await noteMessageChange(null, CONV, "new", "x");
    await noteMessageChange(ORG_A, null, "new", "x");
    expect(h.redis.calls).toEqual([]);

    const { cursor: base, state } = await cursorOf(ORG_A, "u1", [CONV]);
    h.redis.down = true;
    await expect(noteMessageChange(ORG_A, CONV, "upd", "msg_1")).resolves.toBeUndefined();
    h.redis.down = false;
    // A leitura seguinte aplica o pendente como `*` → delta vira reset.
    const now = await readMessageTimelineState(ORG_A, [CONV], base.versions);
    const cur = timelineCursorFromState(ORG_A, "u1", now!, 0);
    expect(cur.versions[0]).toBe(state.conversations[0]!.version + 1);
    expect(planTimelineDelta(base, cur, now!)).toEqual({ kind: "reset", reason: "desconhecido" });
  });

  it("outra réplica enxerga o bump na leitura seguinte (sem memória local)", async () => {
    vi.useFakeTimers();
    const { cursor: before } = await cursorOf(ORG_A, "u1", [CONV]);
    // "Réplica" B: módulo novo sobre o mesmo Redis.
    vi.resetModules();
    const replicaB = await import("./message-versions");
    await replicaB.noteMessageChange(ORG_A, CONV, "upd", "msg_1");
    // Réplica A lê de novo logo em seguida (bem abaixo de 5 s): versão nova.
    vi.advanceTimersByTime(10);
    const { cursor: after } = await cursorOf(ORG_A, "u1", [CONV]);
    expect(after.versions[0]).toBe(before.versions[0]! + 1);
  });
});

describe("message-versions — cursor, ETag e plano do delta", () => {
  it("cursor ida e volta; ETag da página casa só com o mesmo estado e no prazo", async () => {
    const { cursor } = await cursorOf(ORG_A, "u1", [CONV]);
    const withExpiry = { ...cursor, notAfter: Date.now() + 60_000 };
    const raw = encodeTimelineCursor(withExpiry);
    expect(decodeTimelineCursor(raw)).toEqual(withExpiry);
    expect(decodeTimelineCursor("lixo")).toBeNull();

    const tag = pageEtagTag(ORG_A, withExpiry, "40||||");
    expect(pageEtagMatches(timelineEtag(tag), pageEtagTag(ORG_A, cursor, "40||||"))).toBe(tag);
    // Outra consulta (limit) → outro ETag.
    expect(pageEtagMatches(timelineEtag(tag), pageEtagTag(ORG_A, cursor, "20||||"))).toBeNull();
    // Janela de 24 h acabou → não casa (a sessão mudou sem escrita).
    expect(
      pageEtagMatches(timelineEtag(tag), pageEtagTag(ORG_A, cursor, "40||||"), Date.now() + 61_000),
    ).toBeNull();

    expect(cursorEtagMatches(timelineEtag(raw), cursor)).not.toBeNull();
    await noteMessageChange(ORG_A, CONV, "new", "m9");
    const { cursor: next } = await cursorOf(ORG_A, "u1", [CONV]);
    expect(cursorEtagMatches(timelineEtag(raw), next)).toBeNull();
  });

  it("delta: novo, alterado e excluído desde o cursor", async () => {
    const { cursor: base } = await cursorOf(ORG_A, "u1", [CONV]);
    await noteMessageChange(ORG_A, CONV, "new", "m_new", "wamid.new");
    await noteMessageChange(ORG_A, CONV, "upd", "m_old");
    await noteMessageChange(ORG_A, CONV, "del", "m_gone");
    await noteMessageChange(ORG_A, CONV, "meta");
    const state = await readMessageTimelineState(ORG_A, [CONV], base.versions);
    const cur = timelineCursorFromState(ORG_A, "u1", state!, 0);
    const plan = planTimelineDelta(base, cur, state!);
    expect(plan.kind).toBe("delta");
    if (plan.kind !== "delta") return;
    expect([...plan.created]).toEqual(["m_new", "wamid.new"]);
    expect([...plan.updated]).toEqual(["m_old"]);
    expect([...plan.deleted]).toEqual(["m_gone"]);
    expect(plan.meta).toBe(true);
  });

  it("nada mudou → unchanged; outra conversa no conjunto / outro usuário → reset", async () => {
    const { cursor: base, state } = await cursorOf(ORG_A, "u1", [CONV]);
    expect(planTimelineDelta(base, base, state)).toEqual({ kind: "unchanged" });

    const { cursor: two, state: s2 } = await cursorOf(ORG_A, "u1", [CONV, "conv_2"]);
    expect(planTimelineDelta(base, two, s2).kind).toBe("reset");

    const other = timelineCursorFromState(ORG_A, "u2", state, 0);
    expect(planTimelineDelta(base, other, state).kind).toBe("reset");
  });

  it("diário truncado (cursor mais velho que o diário) → reset", async () => {
    const { cursor: base } = await cursorOf(ORG_A, "u1", [CONV]);
    for (let i = 0; i < 310; i++) await noteMessageChange(ORG_A, CONV, "upd", `m${i}`);
    const state = await readMessageTimelineState(ORG_A, [CONV], base.versions);
    const cur = timelineCursorFromState(ORG_A, "u1", state!, 0);
    expect(planTimelineDelta(base, cur, state!).kind).toBe("reset");
  });
});
