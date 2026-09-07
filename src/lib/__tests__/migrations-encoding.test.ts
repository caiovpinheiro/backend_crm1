import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Migration salva como "UTF-8 com BOM" (padrão de vários editores no
 * Windows) quebra o deploy: o Postgres lê o U+FEFF como token e devolve
 * `42601 syntax error at or near ""` na PRIMEIRA linha, mesmo com o SQL
 * perfeito. Pior, o Prisma marca a migration como falha no
 * `_prisma_migrations` e trava TODAS as seguintes até alguém rodar
 * `migrate resolve --rolled-back` à mão no banco.
 *
 * Barato de checar, caro de descobrir em produção.
 */
const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .map((entry) => join(MIGRATIONS_DIR, entry))
    .filter((path) => statSync(path).isDirectory())
    .map((dir) => join(dir, "migration.sql"))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

describe("encoding das migrations", () => {
  it("nenhuma migration começa com BOM", () => {
    const comBom = migrationFiles().filter((file) => {
      const buf = readFileSync(file);
      return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    });

    expect(
      comBom.map((f) => f.replace(process.cwd(), "")),
      "salve como UTF-8 sem BOM — o Postgres rejeita o U+FEFF inicial",
    ).toEqual([]);
  });

  it("nenhuma migration tem U+FEFF no meio do arquivo", () => {
    // BOM no meio aparece quando alguém concatena arquivos ou cola de um
    // editor que injeta o caractere — mesmo erro, ainda mais difícil de ver.
    const comFeff = migrationFiles().filter((file) =>
      readFileSync(file, "utf8").includes("\uFEFF"),
    );

    expect(comFeff.map((f) => f.replace(process.cwd(), ""))).toEqual([]);
  });
});
