import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));
const ctx = vi.hoisted(() => ({ organizationId: "org-1" }));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: ctx.organizationId }),
}));

import {
  buildDealWhereFromFilters,
  isContactLastMessageReady,
  resetContactLastMessageReadyForTests,
} from "@/services/kanban-filters";

/** Caminho antigo (organização ainda sem `contacts.lastMessageDirection`). */
function expectedLegacy(dir: "in" | "out", closedOnlyIds: string[]) {
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

function sqlText(call: unknown[]): string {
  const [first] = call as [TemplateStringsArray | Prisma.Sql];
  return Array.isArray(first) ? first.join("?") : (first as Prisma.Sql).strings.join("?");
}

const PENDING = [{ pending: true }];
const READY = [{ pending: false }];

beforeEach(() => {
  queryRaw.mockReset();
  resetContactLastMessageReadyForTests();
  ctx.organizationId = "org-1";
  vi.useRealTimers();
});

describe("filtro de direção da última mensagem (Kanban) — coluna pronta", () => {
  it("organização preenchida: um predicado no contato, sem pré-consulta de ids", async () => {
    queryRaw.mockResolvedValueOnce(READY);
    const conds = await buildDealWhereFromFilters({ lastMessageDirection: "in" });
    expect(conds).toContainEqual({ contact: { is: { lastMessageDirection: "in" } } });
    // Só a sonda de prontidão; o LATERAL por contato (989 ms em produção) não roda.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(sqlText(queryRaw.mock.calls[0]!)).not.toContain("LATERAL");

    // Pronta fica guardada pela vida do processo: as próximas não sondam.
    const out = await buildDealWhereFromFilters({ lastMessageDirection: "out" });
    expect(out).toContainEqual({ contact: { is: { lastMessageDirection: "out" } } });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("a sonda é por organização e procura conversa com mensagem cujo contato está NULL", async () => {
    queryRaw.mockResolvedValueOnce(READY);
    expect(await isContactLastMessageReady("org-1")).toBe(true);
    const text = sqlText(queryRaw.mock.calls[0]!);
    expect(text).toMatch(/INNER JOIN contacts c ON c\.id = v\."contactId"/);
    expect(text).toMatch(/c\."lastMessageAt" IS NULL/);
    // "Com mensagem": coluna da conversa OU mensagem de chat em `messages` —
    // cobre a janela em que o backfill da conversa ainda não passou.
    expect(text).toMatch(/v\."lastMessageAt" IS NOT NULL\s+OR EXISTS \(\s+SELECT 1 FROM messages m/);
    // O recorte de mensagem de chat é o mesmo da prévia (fragmento aninhado).
    const nested = (queryRaw.mock.calls[0] as unknown[])
      .filter((a): a is Prisma.Sql => typeof a === "object" && a !== null && "strings" in a)
      .map((a) => a.strings.join("?"))
      .join(" ");
    expect(nested).toContain(`m."messageType" NOT LIKE 'event%'`);
    expect(nested).toContain(`m."direction" IN ('in', 'out')`);
    expect(queryRaw.mock.calls[0]).toContain("org-1");

    // Outra organização não herda o resultado.
    queryRaw.mockResolvedValueOnce(PENDING);
    expect(await isContactLastMessageReady("org-2")).toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[1]).toContain("org-2");
  });

  it("pendente: reconsulta no máximo uma vez por minuto e troca sozinha quando o backfill termina", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));
    queryRaw.mockResolvedValueOnce(PENDING);
    expect(await isContactLastMessageReady("org-1")).toBe(false);
    expect(await isContactLastMessageReady("org-1")).toBe(false);
    expect(queryRaw).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-06T12:01:01.000Z"));
    queryRaw.mockResolvedValueOnce(READY);
    expect(await isContactLastMessageReady("org-1")).toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("sonda falhando (migration pendente) mantém o caminho antigo", async () => {
    queryRaw.mockRejectedValueOnce(new Error('column c."lastMessageAt" does not exist'));
    queryRaw.mockResolvedValueOnce([{ id: "c-closed" }]);
    const conds = await buildDealWhereFromFilters({ lastMessageDirection: "in" });
    expect(conds).toContainEqual(expectedLegacy("in", ["c-closed"]));
  });
});

describe("filtro de direção da última mensagem (Kanban) — caminho antigo (backfill pendente)", () => {
  it("'Mensagem recebida': conversa ativa respondida não entra; só encerradas vale a mais recente", async () => {
    queryRaw.mockResolvedValueOnce(PENDING);
    queryRaw.mockResolvedValueOnce([{ id: "c-closed" }]);
    const conds = await buildDealWhereFromFilters({ lastMessageDirection: "in" });
    expect(conds).toContainEqual(expectedLegacy("in", ["c-closed"]));
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[1]).toContain("in");
  });

  it("'Mensagem enviada' segue a mesma regra com a direção oposta", async () => {
    queryRaw.mockResolvedValueOnce(PENDING);
    queryRaw.mockResolvedValueOnce([]);
    const conds = await buildDealWhereFromFilters({ lastMessageDirection: "out" });
    expect(conds).toContainEqual(expectedLegacy("out", []));
    expect(queryRaw.mock.calls[1]).toContain("out");
  });
});

describe("filtro de direção combinado com status de conversa", () => {
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
