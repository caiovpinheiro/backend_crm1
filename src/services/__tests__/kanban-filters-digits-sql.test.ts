/**
 * C1 / 1.4 — o SQL enviado pela busca por dígitos precisa conter, byte a
 * byte, a expressão dos índices de expressão. Um `'\D'` dentro do template
 * `$queryRaw` é cozido pelo JS para `'D'`: o Postgres recebe outra
 * expressão, o índice não é usado e a máscara do telefone não é removida.
 *
 * A expressão esperada é lida da própria migration, para o teste quebrar se
 * o índice mudar sem o código acompanhar.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
}));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org_1" }),
}));

import {
  findContactIdsByPhoneDigits,
  findCustomFieldMatchesByDigits,
} from "../kanban-filters";

const MIGRATIONS = path.resolve(__dirname, "../../../prisma/migrations");

function migrationSql(dir: string): string {
  return readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8");
}

/** Texto SQL de cada chamada (as partes literais do template). */
function sentSql(): string[] {
  return queryRaw.mock.calls.map((call) => {
    const strings = call[0] as TemplateStringsArray;
    return Array.from(strings).join("$?");
  });
}

describe("busca por dígitos — SQL bate com a expressão do índice", () => {
  beforeEach(() => queryRaw.mockClear());

  it("telefone usa a expressão de contacts_org_phone_digits_rev_pattern_idx", async () => {
    const sql = migrationSql("20260911220000_db_index_hygiene");
    const m = /contacts_org_phone_digits_rev_pattern_idx"[\s\S]*?\((reverse\(regexp_replace\(COALESCE\(phone, ''\), '[^']*', '', 'g'\)\))\)/.exec(sql);
    expect(m).not.toBeNull();
    const indexExpr = m![1];
    expect(indexExpr).toBe(String.raw`reverse(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'))`);

    await findContactIdsByPhoneDigits("11945010493");

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [text] = sentSql();
    expect(text).toContain(indexExpr);
    expect(text).not.toContain("'D'");
  });

  it("campos personalizados usam a expressão dos índices *_cfv_value_digits_trgm_idx", async () => {
    const sql = migrationSql("20260911220000_db_index_hygiene");
    const m = /deal_cfv_value_digits_trgm_idx"[\s\S]*?\(\((regexp_replace\(value, '[^']*', '', 'g'\))\)/.exec(sql);
    expect(m).not.toBeNull();
    const indexExpr = m![1];

    await findCustomFieldMatchesByDigits("12345678900");

    const texts = sentSql();
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toContain(indexExpr);
      expect(text).not.toContain("'D'");
    }
  });
});
