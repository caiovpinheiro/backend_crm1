import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org-1" }),
}));

import { buildDealWhereFromFilters } from "@/services/kanban-filters";

describe("filtro de direção da última mensagem (Kanban)", () => {
  it("'Mensagem recebida' olha só conversas ativas e exclui contato com conversa ativa respondida", async () => {
    const conds = await buildDealWhereFromFilters({ lastMessageDirection: "in" });
    expect(conds).toContainEqual({
      contact: {
        is: {
          conversations: {
            none: { status: { not: "RESOLVED" }, lastMessageDirection: "out" },
          },
        },
      },
    });
    expect(conds).toContainEqual({
      contact: {
        is: {
          conversations: {
            some: { status: { not: "RESOLVED" }, lastMessageDirection: "in" },
          },
        },
      },
    });
  });

  it("'Mensagem enviada' segue a mesma regra com a direção oposta", async () => {
    const conds = await buildDealWhereFromFilters({ lastMessageDirection: "out" });
    expect(conds).toContainEqual({
      contact: {
        is: {
          conversations: {
            none: { status: { not: "RESOLVED" }, lastMessageDirection: "in" },
          },
        },
      },
    });
    expect(conds).toContainEqual({
      contact: {
        is: {
          conversations: {
            some: { status: { not: "RESOLVED" }, lastMessageDirection: "out" },
          },
        },
      },
    });
  });

  it("status de conversa escolhido pelo usuário não é sobrescrito", async () => {
    const conds = await buildDealWhereFromFilters({
      lastMessageDirection: "in",
      conversationStatus: "closed",
    });
    expect(conds).toContainEqual({
      contact: {
        is: { conversations: { some: { status: "RESOLVED", lastMessageDirection: "in" } } },
      },
    });
  });
});
