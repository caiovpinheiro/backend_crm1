import { describe, expect, it } from "vitest";

import {
  createMessageDedup,
  isMessageExternalIdUniqueViolation,
} from "@/lib/message-dedup";

/**
 * Fake do índice `messages_organizationId_externalId_key`: o segundo create
 * com o mesmo (org, externalId) estoura P2002 igual o Postgres faria via
 * Prisma. `externalId` null nunca colide (NULLS DISTINCT).
 */
function fakeMessagesTable() {
  const rows: Array<{ id: string; org: string; externalId: string | null }> = [];
  let seq = 0;
  return {
    rows,
    create(org: string, externalId: string | null) {
      if (
        externalId !== null &&
        rows.some((r) => r.org === org && r.externalId === externalId)
      ) {
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
          meta: { target: ["organizationId", "externalId"] },
        });
      }
      const row = { id: `msg-${++seq}`, org, externalId };
      rows.push(row);
      return row;
    },
  };
}

describe("isMessageExternalIdUniqueViolation", () => {
  it("reconhece P2002 no unique de externalId", () => {
    expect(
      isMessageExternalIdUniqueViolation({
        code: "P2002",
        meta: { target: ["organizationId", "externalId"] },
      }),
    ).toBe(true);
  });

  it("ignora P2002 de outro unique (organizationId, number)", () => {
    expect(
      isMessageExternalIdUniqueViolation({
        code: "P2002",
        meta: { target: ["organizationId", "number"] },
      }),
    ).toBe(false);
  });

  it("ignora erro que não é P2002", () => {
    expect(
      isMessageExternalIdUniqueViolation({ code: "P2003" }),
    ).toBe(false);
    expect(isMessageExternalIdUniqueViolation(new Error("boom"))).toBe(false);
    expect(isMessageExternalIdUniqueViolation(null)).toBe(false);
  });

  it("aceita P2002 sem meta.target (adapter que não reporta a coluna)", () => {
    expect(isMessageExternalIdUniqueViolation({ code: "P2002" })).toBe(true);
  });
});

describe("createMessageDedup", () => {
  it("mesma externalId duas vezes → uma única Message, sem exceção", async () => {
    const table = fakeMessagesTable();

    const first = await createMessageDedup(async () =>
      table.create("org-1", "wamid.AAA"),
    );
    const second = await createMessageDedup(async () =>
      table.create("org-1", "wamid.AAA"),
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(table.rows).toHaveLength(1);
  });

  it("corrida concorrente: só um vencedor, ninguém estoura", async () => {
    const table = fakeMessagesTable();

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        createMessageDedup(async () => table.create("org-1", "wamid.BBB")),
      ),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(table.rows).toHaveLength(1);
  });

  it("mesma externalId em orgs diferentes NÃO é duplicata", async () => {
    const table = fakeMessagesTable();

    expect(
      await createMessageDedup(async () => table.create("org-1", "wamid.CCC")),
    ).not.toBeNull();
    expect(
      await createMessageDedup(async () => table.create("org-2", "wamid.CCC")),
    ).not.toBeNull();
    expect(table.rows).toHaveLength(2);
  });

  it("externalId null nunca colide (mensagem interna/system)", async () => {
    const table = fakeMessagesTable();

    await createMessageDedup(async () => table.create("org-1", null));
    await createMessageDedup(async () => table.create("org-1", null));

    expect(table.rows).toHaveLength(2);
  });

  it("erro que não é duplicata continua subindo", async () => {
    await expect(
      createMessageDedup(async () => {
        throw new Error("conexão caiu");
      }),
    ).rejects.toThrow("conexão caiu");
  });
});
