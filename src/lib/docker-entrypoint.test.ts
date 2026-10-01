import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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

function extractBlock(name = "skip-prisma-migrate"): string {
  const start = `# >>> ${name}\n`;
  const end = `# <<< ${name}`;
  const from = entrypoint.indexOf(start);
  const to = entrypoint.indexOf(end);
  if (from < 0 || to < from) throw new Error(`marcadores ${name} não encontrados`);
  return entrypoint.slice(from + start.length, to);
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

describe("docker-entrypoint: GIT_SHA da imagem", () => {
  const dir = mkdtempSync(join(tmpdir(), "entrypoint-sha-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const IMAGE_SHA = "0123456789abcdef0123456789abcdef01234567";
  let seq = 0;

  function boot(fileContent: string | null, envSha: string | undefined) {
    const file = join(dir, `BUILD_SHA_${seq++}`).replace(/\\/g, "/");
    if (fileContent !== null) writeFileSync(file, fileContent);
    const env: NodeJS.ProcessEnv = { ...process.env, BUILD_SHA_FILE: file };
    delete env.GIT_SHA;
    if (envSha !== undefined) env.GIT_SHA = envSha;
    const script = extractBlock("build-sha") + "\nprintf 'FINAL=%s' \"$GIT_SHA\"\n";
    const r = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    return { out: r.stdout, final: r.stdout.match(/FINAL=(.*)$/)?.[1] ?? "" };
  }

  it.skipIf(!hasSh)("usa o SHA gravado na imagem e loga no boot", () => {
    const r = boot(`${IMAGE_SHA}\n`, undefined);
    expect(r.final).toBe(IMAGE_SHA);
    expect(r.out).toContain(`[entrypoint] build: GIT_SHA=${IMAGE_SHA}`);
    expect(r.out).not.toContain("aviso");
  });

  it.skipIf(!hasSh)("GIT_SHA fixo do painel perde para o da imagem, com aviso", () => {
    const r = boot(IMAGE_SHA, "valor-fixo-do-painel");
    expect(r.final).toBe(IMAGE_SHA);
    expect(r.out).toContain("difere do da imagem");
  });

  it.skipIf(!hasSh)("imagem sem o build arg (unknown) ou sem o arquivo: mantém o ambiente", () => {
    expect(boot("unknown", "do-ambiente").final).toBe("do-ambiente");
    expect(boot(null, "do-ambiente").final).toBe("do-ambiente");
    const r = boot(null, undefined);
    expect(r.final).toBe("");
    expect(r.out).toContain("[entrypoint] build: GIT_SHA=unknown");
  });

  it("Dockerfile grava o build arg em ENV, arquivo e label; o workflow passa o commit", () => {
    const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG GIT_SHA=unknown");
    expect(dockerfile).toContain("ENV GIT_SHA=${GIT_SHA}");
    expect(dockerfile).toContain("> /app/BUILD_SHA");
    expect(dockerfile).toContain("org.opencontainers.image.revision");

    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/build-and-deploy.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/build-args: \|\s+GIT_SHA=\$\{\{ github\.sha \}\}/);
  });
});
