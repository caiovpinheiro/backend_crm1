import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org-1" }),
}));

import { buildDealWhereFromFilters } from "@/services/kanban-filters";

function expected(dir: "in" | "out", closedOnlyIds: string[]) {
  return {
    OR: [
      {
        contact: {
          is: {
            AND: [
              {
                conversations: {
                  some: { status: { not: "RESOLVED" }, lastMessageDirection: dir },
                },
              },
              {
                conversations: {
                  none: {
                    status: { not: "RESOLVED" },
                    lastMessageDirection: dir === "in" ? "out" : "in",
                  },
                },
              },
            ],
          },
        },
      },
      { contactId: { in: closedOnlyIds } },
    ],
  };
}

describe("filtro de direção da última mensagem (Kanban)", () => {
  beforeEach(() => queryRaw.mockReset());

  it("'Mensagem recebida': conversa ativa respondida não entra; só encerradas vale a mais recente", async () => {
    queryRaw.mockResolvedValueOnce([{ id: "c-closed" }]);
    const conds = await buildDealWhereFromFilters({ lastMessageDirection: "in" });
    expect(conds).toContainEqual(expected("in", ["c-closed"]));
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0]).toContain("in");
  });

  it("'Mensagem enviada' segue a mesma regra com a direção oposta", async () => {
    queryRaw.mockResolvedValueOnce([]);
    const conds = await buildDealWhereFromFilters({ lastMessageDirection: "out" });
    expect(conds).toContainEqual(expected("out", []));
    expect(queryRaw.mock.calls[0]).toContain("out");
  });

  it("com status de conversa escolhido, mantém o filtro combinado na mesma conversa", async () => {
    const conds = await buildDealWhereFromFilters({
      lastMessageDirection: "in",
      conversationStatus: "closed",
    });
    expect(conds).toContainEqual({
      contact: {
        is: { conversations: { some: { status: "RESOLVED", lastMessageDirection: "in" } } },
      },
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
