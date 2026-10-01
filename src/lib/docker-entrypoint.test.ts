import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Exercita o trecho REAL do `docker-entrypoint.sh` que decide se o
 * `prisma migrate deploy` é pulado (bloco entre os marcadores
 * `>>> skip-prisma-migrate` / `<<< skip-prisma-migrate`).
 *
 * Regressão coberta: o teste antigo era `[ -n "${SKIP_PRISMA_MIGRATE}" ]`,
 * que pulava a migration também com `SKIP_PRISMA_MIGRATE=0`.
 */
const entrypoint = readFileSync(
  resolve(process.cwd(), "docker-entrypoint.sh"),
  "utf8",
).replace(/\r\n/g, "\n");

function extractBlock(): string {
  const m = entrypoint.match(
    /# >>> skip-prisma-migrate\n([\s\S]*?)# <<< skip-prisma-migrate/,
  );
  if (!m) throw new Error("marcadores skip-prisma-migrate não encontrados");
  return m[1];
}

const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

function decide(value: string | undefined): "skip" | "run" {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SKIP_PRISMA_MIGRATE;
  if (value !== undefined) env.SKIP_PRISMA_MIGRATE = value;
  const script = `${extractBlock()}\nif should_skip_prisma_migrate; then echo skip; else echo run; fi\n`;
  const r = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.trim() as "skip" | "run";
}

describe("docker-entrypoint: SKIP_PRISMA_MIGRATE", () => {
  it("o bloco de migrate usa a função (não o teste de existência)", () => {
    expect(entrypoint).toContain("if should_skip_prisma_migrate; then");
    expect(entrypoint).not.toContain('[ -n "${SKIP_PRISMA_MIGRATE}" ]');
    expect(extractBlock()).toContain('case "${SKIP_PRISMA_MIGRATE:-0}" in');
  });

  it.skipIf(!hasSh)("o script inteiro é sintaticamente válido (sh -n)", () => {
    const r = spawnSync("sh", ["-n"], { input: entrypoint, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.skipIf(!hasSh).each([
    [undefined, "run"],
    ["", "run"],
    ["0", "run"],
    ["false", "run"],
    ["no", "run"],
    ["off", "run"],
    ["qualquer", "run"],
    ["1", "skip"],
    ["true", "skip"],
    ["TRUE", "skip"],
    ["yes", "skip"],
    ["on", "skip"],
  ] as const)("SKIP_PRISMA_MIGRATE=%j → %s", (value, expected) => {
    expect(decide(value)).toBe(expected);
  });
});
