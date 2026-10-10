/**
 * GET /api/products?search= (B6 / R3-BD-1).
 *
 * - A expressão do SQL enviado é a MESMA dos índices GIN trigram da
 *   migration (`public.crm_fold(name)` / `public.crm_fold(sku)`), sem
 *   parâmetro dentro dela — senão o Postgres não usa o índice.
 * - Ids + total numa ida só (`count(*) OVER ()`); COUNT à parte só para
 *   página além do fim.
 * - Termo com menos de 2 letras não filtra.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  raw: [] as Prisma.Sql[],
  rawResults: [] as unknown[][],
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async (first: unknown, ...values: unknown[]) => {
      // Template (`strings`, ...values) → Prisma.Sql para inspecionar.
      const { Prisma } = await import("@prisma/client");
      const sql = Array.isArray(first)
        ? Prisma.sql(first as unknown as TemplateStringsArray, ...values)
        : (first as Prisma.Sql);
      h.raw.push(sql);
      return h.rawResults.shift() ?? [];
    }),
    product: { findMany: h.findMany, count: h.count },
  },
}));
vi.mock("@/lib/api-auth", async () => {
  const { runWithContext } = await import("@/lib/request-context");
  return {
    authenticateApiRequest: vi.fn(async () => ({
      ok: true,
      user: { id: "u1", role: "ADMIN", organizationId: "org_1", isSuperAdmin: false },
    })),
    runWithApiUserContext: (_u: unknown, fn: () => unknown) =>
      runWithContext({ organizationId: "org_1", userId: "u1", isSuperAdmin: false } as never, fn),
  };
});
vi.mock("@/lib/authz/resource-policy", () => ({
  requirePermissionForUser: vi.fn(async () => null),
}));
vi.mock("@/lib/org-settings", () => ({ getOrgSetting: vi.fn(async () => null) }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { GET } from "@/app/api/products/route";
import { PRODUCT_NAME_FOLD_SQL, PRODUCT_SKU_FOLD_SQL } from "@/lib/product-search";

const MIGRATION = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20261005200000_products_search_fold_trgm/migration.sql",
  ),
  "utf8",
);
/** Só o SQL executado (sem os comentários `--` do cabeçalho). */
const MIGRATION_BODY = MIGRATION.split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

/** `public.crm_fold("name")` / `public.crm_fold(p.name)` → `public.crm_fold(name)`. */
function normalizeExpr(expr: string): string {
  return expr.replace(/"/g, "").replace(/\bp\./g, "").replace(/\s+/g, "");
}

function indexExpressions(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?"(\w+)"\s+ON "products" USING GIN \((.+?) gin_trgm_ops\)/g;
  for (const m of sql.matchAll(re)) out.set(m[1]!, m[2]!);
  return out;
}

function call(qs: string) {
  return GET(new Request(`http://localhost/api/products?${qs}`));
}

beforeEach(() => {
  h.raw.length = 0;
  h.rawResults.length = 0;
  h.findMany.mockReset().mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
    (args.where.id?.in ?? ["p1"]).map((id) => ({ id, name: id, metaLinks: [] })),
  );
  h.count.mockReset().mockResolvedValue(1);
});

describe("migration da busca de produtos", () => {
  it("função IMMUTABLE e índices GIN trigram sobre a mesma expressão (corpo e cabeçalho CONCURRENTLY)", () => {
    expect(MIGRATION_BODY).toMatch(
      /CREATE OR REPLACE FUNCTION public\.crm_fold\(text\) RETURNS text\s+LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT/,
    );
    expect(MIGRATION_BODY).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    const body = indexExpressions(MIGRATION_BODY);
    expect([...body.keys()].sort()).toEqual([
      "products_name_fold_trgm_idx",
      "products_sku_fold_trgm_idx",
    ]);
    // O cabeçalho traz os mesmos índices com CONCURRENTLY para o operador.
    const header = indexExpressions(MIGRATION.replace(/^--\s?/gm, ""));
    expect(MIGRATION).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_name_fold_trgm_idx"/);
    expect(MIGRATION).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_sku_fold_trgm_idx"/);
    for (const [name, expr] of body) expect(header.get(name)).toBe(expr);
    // Índice de SKU é parcial.
    expect(MIGRATION_BODY).toMatch(
      /public\.crm_fold\("sku"\) gin_trgm_ops\)\s+WHERE "sku" IS NOT NULL;/,
    );
  });
});

describe("GET /api/products?search=", () => {
  it("expressão do SQL enviado == expressão do índice, sem parâmetro dentro", async () => {
    h.rawResults.push([{ id: "p2", total: 3 }, { id: "p1", total: 3 }]);
    const res = await call("search=Administração&perPage=2");
    expect(res.status).toBe(200);
    expect(h.raw).toHaveLength(1);
    const sql = h.raw[0]!;
    const text = sql.strings.join("?");

    const idx = indexExpressions(MIGRATION_BODY);
    const nameIdx = normalizeExpr(idx.get("products_name_fold_trgm_idx")!);
    const skuIdx = normalizeExpr(idx.get("products_sku_fold_trgm_idx")!);
    expect(normalizeExpr(PRODUCT_NAME_FOLD_SQL)).toBe(nameIdx);
    expect(normalizeExpr(PRODUCT_SKU_FOLD_SQL)).toBe(skuIdx);

    // A expressão inteira está num único pedaço de texto (nenhum `$n` dentro)
    // e é ela que vem antes do LIKE.
    expect(sql.strings.some((s) => s.includes(`${PRODUCT_NAME_FOLD_SQL} LIKE `))).toBe(true);
    expect(
      sql.strings.some((s) => s.includes(`p.sku IS NOT NULL AND ${PRODUCT_SKU_FOLD_SQL} LIKE `)),
    ).toBe(true);
    expect(text).not.toMatch(/translate\(/);
    // Ordenação usa a mesma expressão (sem parâmetros de acento).
    expect(text).toMatch(/END,\s+public\.crm_fold\(p\.name\),\s+p\.id/);
    // Termo dobrado só como valor do LIKE.
    expect(sql.values).toContain("%administracao%");
    expect(sql.values).not.toContain("áàâãäåéèêëíìîïóòôõöúùûüýÿçñ");
  });

  it("ids + total numa ida só (count(*) OVER ()), ordem do ranking preservada", async () => {
    h.rawResults.push([{ id: "p2", total: 7 }, { id: "p1", total: 7 }]);
    const res = await call("search=adm&perPage=2");
    const body = (await res.json()) as { products: Array<{ id: string }>; total: number };
    expect(h.raw).toHaveLength(1);
    expect(h.raw[0]!.strings.join("?")).toContain("count(*) OVER ()::int AS total");
    expect(body.total).toBe(7);
    expect(body.products.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(h.count).not.toHaveBeenCalled();
  });

  it("página além do fim: COUNT à parte só nesse caso", async () => {
    h.rawResults.push([], [{ total: 4 }]);
    const res = await call("search=adm&perPage=2&page=5");
    const body = (await res.json()) as { products: unknown[]; total: number };
    expect(h.raw).toHaveLength(2);
    expect(h.raw[1]!.strings.join("?")).toMatch(/SELECT count\(\*\)::int AS total/);
    expect(body).toMatchObject({ products: [], total: 4 });
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("busca sem resultado na 1ª página: sem COUNT e sem findMany", async () => {
    h.rawResults.push([]);
    const res = await call("search=zzz");
    expect(await res.json()).toMatchObject({ products: [], total: 0 });
    expect(h.raw).toHaveLength(1);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("termo com menos de 2 letras não filtra (lista normal)", async () => {
    const res = await call("search=a");
    expect(res.status).toBe(200);
    expect(h.raw).toHaveLength(0);
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: "asc" }, where: { isActive: true } }),
    );
  });
});
