/**
 * Contexto vivo e timeline mudando de dono: visitante anônimo → contato
 * (identify) e merge de contatos. Banco simulado em memória.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { adoptAnonymousVisitorData, mergeContactVisitorData } from "@/lib/webchat/visitor-data";

type Ctx = {
  id: string;
  channelId: string;
  contactId: string | null;
  sessionId: string | null;
  state: Record<string, unknown>;
  updatedAt: Date;
};
type Ev = { id: string; contactId: string | null; sessionId: string | null };

let contexts: Ctx[] = [];
let events: Ev[] = [];

const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => row[k] === v);

const tx = {
  webchatEvent: {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Ev> }) => {
      const hit = events.filter((e) => matches(e, where));
      hit.forEach((e) => Object.assign(e, data));
      return { count: hit.length };
    },
  },
  webchatLiveContext: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      contexts.find((c) => matches(c, where)) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      contexts.filter((c) => matches(c, where)),
    update: async ({ where, data }: { where: { id: string }; data: Partial<Ctx> }) => {
      const row = contexts.find((c) => c.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      contexts = contexts.filter((c) => c.id !== where.id);
    },
  },
} as never;

const d = (s: string) => new Date(s);
const ctxRow = (p: Partial<Ctx> & { id: string }): Ctx => ({
  channelId: "ch",
  contactId: null,
  sessionId: null,
  state: {},
  updatedAt: d("2026-01-01"),
  ...p,
});

beforeEach(() => {
  contexts = [];
  events = [];
});

describe("adoptAnonymousVisitorData", () => {
  it("contato sem contexto: a linha anônima passa a ser do contato", async () => {
    contexts.push(ctxRow({ id: "x1", sessionId: "s1", state: { a: "1" } }));
    events.push({ id: "e1", contactId: null, sessionId: "s1" }, { id: "e2", contactId: null, sessionId: "s2" });
    await adoptAnonymousVisitorData(tx, { sessionId: "s1", contactId: "ct" });
    expect(contexts).toEqual([ctxRow({ id: "x1", contactId: "ct", state: { a: "1" } })]);
    expect(events).toEqual([
      { id: "e1", contactId: "ct", sessionId: null },
      { id: "e2", contactId: null, sessionId: "s2" },
    ]);
  });

  it("contato já tem contexto no canal: funde (mais recente vence) e apaga a anônima", async () => {
    contexts.push(
      ctxRow({ id: "c1", contactId: "ct", state: { a: "velho", b: "2" } }),
      ctxRow({ id: "x1", sessionId: "s1", state: { a: "novo" }, updatedAt: d("2026-01-02") }),
    );
    await adoptAnonymousVisitorData(tx, { sessionId: "s1", contactId: "ct" });
    expect(contexts).toEqual([
      ctxRow({ id: "c1", contactId: "ct", state: { a: "novo", b: "2" }, updatedAt: d("2026-01-02") }),
    ]);
  });

  it("sem nada anônimo: não faz nada", async () => {
    await adoptAnonymousVisitorData(tx, { sessionId: "s9", contactId: "ct" });
    expect(contexts).toEqual([]);
  });
});

describe("mergeContactVisitorData", () => {
  it("reponta eventos e contextos; mesmo canal funde, canal diferente só troca o dono", async () => {
    contexts.push(
      ctxRow({ id: "k1", channelId: "ch1", contactId: "keep", state: { a: "k" }, updatedAt: d("2026-03-01") }),
      ctxRow({ id: "r1", channelId: "ch1", contactId: "rm", state: { a: "r", z: "1" }, updatedAt: d("2026-02-01") }),
      ctxRow({ id: "r2", channelId: "ch2", contactId: "rm", state: { b: "2" } }),
    );
    events.push({ id: "e1", contactId: "rm", sessionId: null });
    await mergeContactVisitorData(tx, "keep", "rm");
    expect(events[0].contactId).toBe("keep");
    expect(contexts.map((c) => [c.id, c.contactId, c.state])).toEqual([
      ["k1", "keep", { a: "k", z: "1" }],
      ["r2", "keep", { b: "2" }],
    ]);
  });
});
