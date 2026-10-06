/**
 * C2 da auditoria de banco (05/10) — origens distintas dos contatos.
 *
 * - 20 aberturas do painel de filtros = 2 consultas (antes: 40 — os dois
 *   `SELECT DISTINCT` a cada chamada).
 * - A consulta não usa `DISTINCT` e filtra com `> ''` na coluna crua, que é
 *   a forma que casa com os índices da migration 20261005210000.
 * - Os índices da migration são exatamente as colunas que a consulta usa.
 * - Cache por org; uma org não responde pela outra.
 * - Depois de 5 min devolve o valor guardado e recalcula por trás.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/prisma", async () => {
  const { probe } = await import("@/test-setup/io-probe");
  return { prisma: probe.prisma };
});

import { getContactSourceOptions } from "@/services/contact-source-options";
import { probe } from "@/test-setup/io-probe";

type SqlLike = { sql: string; values: unknown[] };

function sqlOf(entryArgs: unknown): SqlLike {
  const [query] = entryArgs as [SqlLike];
  return query;
}

let sourcesByOrg: Record<string, (string | null)[]>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
  h.redis.store.clear();
  h.redis.calls.length = 0;
  probe.reset();
  sourcesByOrg = {
    org_1: ["whatsapp", " Indicação ", "anúncio", "   "],
    org_2: ["site"],
  };
  probe.setDbHandler((name, _op, args) => {
    if (name !== "$queryRaw") return undefined;
    const { sql, values } = sqlOf(args);
    const org = String(values[0]);
    if (sql.includes('"ad_utm_source"')) return org === "org_1" ? [{ v: "google" }] : [];
    return (sourcesByOrg[org] ?? []).map((v) => ({ v }));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getContactSourceOptions", () => {
  it("20 chamadas = 2 consultas; valores limpos e em ordem pt-BR", async () => {
    const { result, entries } = await probe.run(async () => {
      let last = await getContactSourceOptions("org_1");
      for (let i = 0; i < 19; i++) last = await getContactSourceOptions("org_1");
      return last;
    });
    expect(result).toEqual({
      sources: ["anúncio", "Indicação", "whatsapp"],
      utmSources: ["google"],
    });
    const pg = entries.filter((e) => e.kind === "pg");
    expect(pg.map((e) => e.label)).toEqual(["$queryRaw", "$queryRaw"]);
    // As duas saem juntas (uma fase).
    expect(probe.stats("pg", entries).phases).toBe(1);
  });

  it("a consulta pula pelo índice: sem DISTINCT, coluna crua, org como parâmetro", async () => {
    const { entries } = await probe.run(() => getContactSourceOptions("org_1"));
    const queries = entries.filter((e) => e.kind === "pg").map((e) => sqlOf(e.args));
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.sql).not.toMatch(/\bDISTINCT\b/i);
      expect(q.sql).toMatch(/WITH RECURSIVE/);
      // Só a org e o LIMIT são parâmetros — nada de `$n` dentro da comparação
      // da coluna além do valor anterior da própria CTE.
      expect(q.values).toEqual(["org_1", "org_1", 200]);
    }
    expect(queries[0]!.sql).toContain(`c."source" > ''`);
    expect(queries[0]!.sql).toContain(`c."source" > t.v`);
    expect(queries[0]!.sql).toContain(`ORDER BY c."source"`);
    expect(queries[1]!.sql).toContain(`c."ad_utm_source" > ''`);
  });

  it("a migration cria os índices nas colunas que a consulta percorre", () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20261005210000_contacts_org_source_idx/migration.sql",
      ),
      "utf8",
    );
    expect(migration).toContain(`ON "contacts" ("organizationId", "source");`);
    expect(migration).toContain(`ON "contacts" ("organizationId", "ad_utm_source");`);
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    expect(schema).toContain("@@index([organizationId, source])");
    expect(schema).toContain("@@index([organizationId, adUtmSource])");
  });

  it("uma org não responde pela outra", async () => {
    const one = await probe.run(() => getContactSourceOptions("org_1"));
    const two = await probe.run(() => getContactSourceOptions("org_2"));
    expect(one.result.sources).toContain("whatsapp");
    expect(two.result).toEqual({ sources: ["site"], utmSources: [] });
  });

  it("origem nova aparece em no máximo 10 min (5 fresco + recálculo por trás)", async () => {
    await probe.run(() => getContactSourceOptions("org_2"));
    sourcesByOrg.org_2 = ["site", "feira"];

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    const fresh = await probe.run(() => getContactSourceOptions("org_2"));
    expect(fresh.result.sources).toEqual(["site"]);
    expect(fresh.entries.filter((e) => e.kind === "pg")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(61_000);
    // Vencido: devolve o guardado na hora e dispara o recálculo.
    const stale = await probe.run(() => getContactSourceOptions("org_2"));
    expect(stale.result.sources).toEqual(["site"]);
    const next = await probe.run(() => getContactSourceOptions("org_2"));
    expect(next.result.sources).toEqual(["feira", "site"]);
  });
});
