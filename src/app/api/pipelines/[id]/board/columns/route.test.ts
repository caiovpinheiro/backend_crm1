/**
 * POST /api/pipelines/:id/board/columns — "Carregar mais" por cursor.
 *
 * A rota repete a sequência de autorização do POST /board. Aqui: escopo do
 * pipeline negado não consulta nada; etapa que o usuário não pode ver não
 * chega ao serviço; o where de visibilidade entregue ao serviço é o mesmo
 * do board (visibilidade do usuário AND visibilidade de funil); erros do
 * cursor viram 400 com `code`.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getBoardColumnPages: vi.fn(),
  requirePipelineScope: vi.fn(),
  getVisibilityFilter: vi.fn(),
  loadAuthzContext: vi.fn(),
  resolvePipelineByPublicRef: vi.fn(),
  getPipelineMeta: vi.fn(),
  hiddenStages: new Set<string>(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: vi.fn(async (handler: (session: unknown) => unknown) =>
    handler({
      user: { id: "user_1", organizationId: "org_1", role: "MEMBER", isSuperAdmin: false },
    }),
  ),
}));
vi.mock("@/lib/authz", () => ({
  loadAuthzContext: h.loadAuthzContext,
  canViewStage: (_authz: unknown, stageId: string) => !h.hiddenStages.has(stageId),
}));
vi.mock("@/lib/authz/funnel-visibility", () => ({
  funnelDealWhere: () => ({ stageId: { notIn: ["s-hidden"] } }),
  andDealWhere: (a: unknown, b: unknown) => ({ AND: [a, b] }),
}));
vi.mock("@/lib/authz/resource-policy", () => ({
  requirePipelineScope: h.requirePipelineScope,
}));
vi.mock("@/lib/visibility", () => ({ getVisibilityFilter: h.getVisibilityFilter }));
vi.mock("@/services/pipelines", () => ({
  resolvePipelineByPublicRef: h.resolvePipelineByPublicRef,
  getPipelineMeta: h.getPipelineMeta,
}));
vi.mock("@/services/kanban-filters", () => ({
  parseAdvancedDealFilters: (raw: unknown) => (raw && typeof raw === "object" ? raw : {}),
}));
vi.mock("@/services/deals", () => {
  class BoardColumnPageError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "BoardColumnPageError";
    }
  }
  return {
    BoardColumnPageError,
    getBoardColumnPages: h.getBoardColumnPages,
    isValidDealStatus: (v: string) => ["OPEN", "WON", "LOST"].includes(v),
  };
});

import { POST } from "@/app/api/pipelines/[id]/board/columns/route";
import { BoardColumnPageError } from "@/services/deals";

function post(body: unknown, id = "8") {
  return POST(
    new Request(`http://localhost/api/pipelines/${id}/board/columns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.hiddenStages.clear();
  h.loadAuthzContext.mockResolvedValue({ isAdmin: false });
  h.resolvePipelineByPublicRef.mockResolvedValue({ id: "pipe_cuid", name: "Vendas" });
  h.getPipelineMeta.mockResolvedValue(null);
  h.requirePipelineScope.mockResolvedValue(null);
  h.getVisibilityFilter.mockResolvedValue({ dealWhere: { ownerId: "user_1" } });
  h.getBoardColumnPages.mockResolvedValue([
    { stageId: "s1", deals: [{ id: "d1" }], nextCursor: "abc", hasMore: true },
  ]);
});

describe("POST /api/pipelines/[id]/board/columns", () => {
  it("devolve só as páginas pedidas; serviço recebe o pipeline resolvido, o where do board e os parâmetros", async () => {
    const res = await post({
      status: "ALL",
      sort: "createdAt",
      direction: "desc",
      filters: { tagIds: ["t1"] },
      columns: [{ stageId: "s1", cursor: "c1", limit: 10 }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      columns: [{ stageId: "s1", deals: [{ id: "d1" }], nextCursor: "abc", hasMore: true }],
    });
    expect(h.getBoardColumnPages).toHaveBeenCalledWith(
      "pipe_cuid",
      { AND: [{ ownerId: "user_1" }, { stageId: { notIn: ["s-hidden"] } }] },
      "ALL",
      { tagIds: ["t1"] },
      {
        sortField: "createdAt",
        sortDirection: "desc",
        columns: [{ stageId: "s1", cursor: "c1", limit: 10 }],
      },
    );
    expect(h.requirePipelineScope).toHaveBeenCalledWith(expect.anything(), "view", "pipe_cuid");
  });

  it("status ausente/inválido → undefined (padrão OPEN no serviço); sort inválido → undefined", async () => {
    await post({ status: "QUALQUER", sort: "name", columns: [{ stageId: "s1", cursor: "c1" }] });
    const args = h.getBoardColumnPages.mock.calls[0]!;
    expect(args[2]).toBeUndefined();
    expect(args[4]).toEqual({
      sortField: undefined,
      sortDirection: undefined,
      columns: [{ stageId: "s1", cursor: "c1", limit: undefined }],
    });
  });

  it("escopo do pipeline negado: devolve a negação e não consulta cards", async () => {
    h.requirePipelineScope.mockResolvedValue(
      NextResponse.json({ message: "Sem acesso." }, { status: 403 }),
    );
    const res = await post({ columns: [{ stageId: "s1", cursor: "c1" }] });
    expect(res.status).toBe(403);
    expect(h.getBoardColumnPages).not.toHaveBeenCalled();
  });

  it("pipeline inexistente → 404", async () => {
    h.resolvePipelineByPublicRef.mockResolvedValue(null);
    const res = await post({ columns: [{ stageId: "s1", cursor: "c1" }] }, "nao-existe");
    expect(res.status).toBe(404);
    expect(h.getBoardColumnPages).not.toHaveBeenCalled();
  });

  it("etapa que o usuário não pode ver não chega ao serviço", async () => {
    h.hiddenStages.add("s-hidden");
    await post({
      columns: [
        { stageId: "s-hidden", cursor: "c0" },
        { stageId: "s1", cursor: "c1" },
      ],
    });
    expect(h.getBoardColumnPages.mock.calls[0]![4].columns).toEqual([
      { stageId: "s1", cursor: "c1", limit: undefined },
    ]);

    h.getBoardColumnPages.mockClear();
    const res = await post({ columns: [{ stageId: "s-hidden", cursor: "c0" }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ columns: [] });
    expect(h.getBoardColumnPages).not.toHaveBeenCalled();
  });

  it("corpo sem `columns` válido → 400 invalid_request", async () => {
    for (const body of [{}, { columns: [] }, { columns: [{ stageId: "s1" }] }, { columns: "x" }, "{"]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_request");
    }
    expect(h.getBoardColumnPages).not.toHaveBeenCalled();
  });

  it("cursor inválido / sem suporte → 400 com o código do serviço", async () => {
    h.getBoardColumnPages.mockRejectedValue(
      new BoardColumnPageError("invalid_cursor", "Cursor inválido."),
    );
    const res = await post({ columns: [{ stageId: "s1", cursor: "zzz" }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "Cursor inválido.", code: "invalid_cursor" });
  });

  it("erro inesperado → 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.getBoardColumnPages.mockRejectedValue(new Error("boom"));
    const res = await post({ columns: [{ stageId: "s1", cursor: "c1" }] });
    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});
