/**
 * Merge manual do operador com contato de visitante do webchat: a sessão do
 * widget acompanha o contato que fica e o visitante passa a ser "dono" dele
 * (`webchatVisitorId`), senão a próxima mensagem abriria um contato novo
 * (o widget só usa o contato nascido na sessão).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as { op: string; args: unknown }[],
  contacts: new Map<string, { id: string; webchatVisitorId: string | null; externalId?: string | null }>(),
}));

vi.mock("@/lib/conversation-last-message", () => ({ carryContactLastMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/prisma", () => {
  // Qualquer modelo/método do tx: registra a chamada e devolve vazio.
  const tx = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_m, method: string) => async (args: unknown) => {
              h.calls.push({ op: `${model}.${method}`, args });
              if (method === "findMany") return [];
              if (method === "findUnique" || method === "findFirst") return null;
              return { count: 0 };
            },
          },
        ),
    },
  );
  return {
    prisma: {
      contact: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.contacts.get(where.id) ?? null),
      },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    },
  };
});

import { mergeContacts } from "@/services/merge-contacts";

beforeEach(() => {
  h.calls.length = 0;
  h.contacts.clear();
});

describe("mergeContacts × webchat", () => {
  it("removido era do visitante e o que fica não tem: o visitante passa a ser dono do que fica", async () => {
    h.contacts.set("ct-keep", { id: "ct-keep", webchatVisitorId: null });
    h.contacts.set("ct-visit", { id: "ct-visit", webchatVisitorId: "wv_1" });
    const res = await mergeContacts("ct-keep", "ct-visit");
    expect(res.ok).toBe(true);
    const ops = h.calls.map((c) => c.op);
    const sessions = ops.indexOf("webchatSession.updateMany");
    const updates = h.calls.filter((c) => c.op === "contact.update").map((c) => c.args);
    expect(updates).toEqual([
      { where: { id: "ct-visit" }, data: { webchatVisitorId: null } },
      { where: { id: "ct-keep" }, data: { webchatVisitorId: "wv_1" } },
    ]);
    expect(sessions).toBeGreaterThanOrEqual(0);
    // Libera o unique antes de gravar no que fica, e tudo antes do delete.
    expect(ops.lastIndexOf("contact.update")).toBeLessThan(ops.indexOf("contact.delete"));
  });

  it("o que fica já é de outro visitante: não mexe no webchatVisitorId", async () => {
    h.contacts.set("ct-keep", { id: "ct-keep", webchatVisitorId: "wv_a" });
    h.contacts.set("ct-visit", { id: "ct-visit", webchatVisitorId: "wv_b" });
    await mergeContacts("ct-keep", "ct-visit");
    expect(h.calls.filter((c) => c.op === "contact.update")).toEqual([]);
  });
  it("v2: contexto/timeline acompanham e o externalId do removido passa para o que fica", async () => {
    h.contacts.set("ct-keep", { id: "ct-keep", webchatVisitorId: null, externalId: null });
    h.contacts.set("ct-rm", { id: "ct-rm", webchatVisitorId: null, externalId: "ext-1" });
    await mergeContacts("ct-keep", "ct-rm");
    const ops = h.calls.map((c) => c.op);
    expect(h.calls).toContainEqual({
      op: "webchatEvent.updateMany",
      args: { where: { contactId: "ct-rm" }, data: { contactId: "ct-keep" } },
    });
    expect(ops).toContain("webchatLiveContext.findMany");
    expect(h.calls.filter((c) => c.op === "contact.update").map((c) => c.args)).toEqual([
      { where: { id: "ct-rm" }, data: { externalId: null } },
      { where: { id: "ct-keep" }, data: { externalId: "ext-1" } },
    ]);
    expect(ops.lastIndexOf("contact.update")).toBeLessThan(ops.indexOf("contact.delete"));
  });

  it("v2: os dois têm externalId -> fica o do keep", async () => {
    h.contacts.set("ct-keep", { id: "ct-keep", webchatVisitorId: null, externalId: "ext-k" });
    h.contacts.set("ct-rm", { id: "ct-rm", webchatVisitorId: null, externalId: "ext-r" });
    await mergeContacts("ct-keep", "ct-rm");
    expect(h.calls.filter((c) => c.op === "contact.update")).toEqual([]);
  });
});
