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

describe("docker-entrypoint: migrations no boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "entrypoint-mig-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // CLI falsa do Prisma: registra cada chamada e devolve saída/código pedidos.
  const fakeCli = join(dir, "fake-prisma.sh").replace(/\\/g, "/");
  writeFileSync(
    fakeCli,
    [
      'echo "$*" >> "$FAKE_CALLS"',
      'if [ -n "$FAKE_OUTPUT" ]; then printf "%s\\n" "$FAKE_OUTPUT"; fi',
      'exit "${FAKE_RC:-0}"',
      "",
    ].join("\n"),
  );

  const P3018 = [
    "Error: P3018",
    "",
    "A migration failed to apply. New migrations cannot be applied before the error is recovered from.",
    "",
    "Migration name: 20261002120000_exemplo_quebrado",
    "",
    "Database error code: 42P07",
  ].join("\n");
  const P3009 = [
    "Error: P3009",
    "",
    "migrate found failed migrations in the target database, new migrations will not be applied.",
    "The `20260716220000_tickets_unicos` migration started at 2026-10-02 12:00:00 UTC failed",
  ].join("\n");

  let seq = 0;
  function boot(env: Record<string, string | undefined>) {
    const calls = join(dir, `calls_${seq++}`).replace(/\\/g, "/");
    writeFileSync(calls, "");
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const k of [
      "SKIP_PRISMA_MIGRATE",
      "RUN_MIGRATIONS_ON_BOOT",
      "FAKE_RC",
      "FAKE_OUTPUT",
    ]) {
      delete base[k];
    }
    const fullEnv: NodeJS.ProcessEnv = {
      ...base,
      APP_MODE: "api",
      DATABASE_URL: "postgresql://fake/db",
      PRISMA_CLI: `sh ${fakeCli}`,
      FAKE_CALLS: calls,
      TMPDIR: dir.replace(/\\/g, "/"),
      ...env,
    };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete fullEnv[k];
    const script =
      "set -e\n" +
      extractBlock() +
      extractBlock("boot-migrations") +
      "\nif boot_migrations; then echo RESULT=ok; else echo RESULT=fail; fi\n";
    const r = spawnSync("sh", ["-c", script], { env: fullEnv, encoding: "utf8" });
    expect(r.status).toBe(0);
    const invoked = readFileSync(calls, "utf8").split("\n").filter(Boolean);
    return {
      out: r.stdout,
      ok: r.stdout.includes("RESULT=ok"),
      invoked,
    };
  }

  it("o fallback de reexecução em massa saiu do entrypoint", () => {
    // Só o comentário que explica a remoção pode citar o comando.
    expect(entrypoint).not.toMatch(/^\s*db execute|db execute --schema/m);
    expect(entrypoint).not.toContain("prisma/migrations/*/migration.sql");
    expect(entrypoint).toContain("if ! boot_migrations; then\n  exit 1\nfi");
  });

  it.skipIf(!hasSh)("sucesso: uma única chamada de migrate deploy e o boot segue", () => {
    const r = boot({});
    expect(r.ok).toBe(true);
    expect(r.invoked).toEqual(["migrate deploy --schema=prisma/schema.prisma"]);
  });

  it.skipIf(!hasSh)("falha (P3018): aborta, nomeia a migration e não reexecuta nada", () => {
    const r = boot({ FAKE_RC: "1", FAKE_OUTPUT: P3018 });
    expect(r.ok).toBe(false);
    expect(r.invoked).toEqual(["migrate deploy --schema=prisma/schema.prisma"]);
    expect(r.out).toContain("Error: P3018");
    expect(r.out).toContain("prisma migrate deploy falhou (exit 1)");
    expect(r.out).toContain("migration com falha: 20261002120000_exemplo_quebrado");
    expect(r.out).toContain("migrate resolve --rolled-back <nome>");
  });

  it.skipIf(!hasSh)("falha (P3009, migration marcada como falha): nomeia e aborta", () => {
    const r = boot({ FAKE_RC: "1", FAKE_OUTPUT: P3009 });
    expect(r.ok).toBe(false);
    expect(r.invoked).toHaveLength(1);
    expect(r.out).toContain("migration com falha: 20260716220000_tickets_unicos");
  });

  it.skipIf(!hasSh)("falha sem nome (ex.: lock/conexão): aborta com aviso genérico", () => {
    const r = boot({ FAKE_RC: "1", FAKE_OUTPUT: "Error: P1002" });
    expect(r.ok).toBe(false);
    expect(r.invoked).toHaveLength(1);
    expect(r.out).toContain("migration não identificada");
  });

  it.skipIf(!hasSh).each([
    [{ APP_MODE: "worker-automation" }, "somente API roda migrate"],
    [{ APP_MODE: "api-public" }, "somente API roda migrate"],
    [{ SKIP_PRISMA_MIGRATE: "1" }, "pulando migrate deploy"],
    [{ RUN_MIGRATIONS_ON_BOOT: "0" }, "NÃO rodam no boot"],
    [{ RUN_MIGRATIONS_ON_BOOT: "false" }, "NÃO rodam no boot"],
    [{ RUN_MIGRATIONS_ON_BOOT: "off" }, "NÃO rodam no boot"],
    [{ DATABASE_URL: "" }, "DATABASE_URL vazio"],
  ] as const)("não migra com %j", (env, msg) => {
    const r = boot(env);
    expect(r.ok).toBe(true);
    expect(r.invoked).toEqual([]);
    expect(r.out).toContain(msg);
  });

  it.skipIf(!hasSh).each([undefined, "", "1", "true", "on", "qualquer"])(
    "RUN_MIGRATIONS_ON_BOOT=%j mantém o migrate na API",
    (value) => {
      const r = boot({ RUN_MIGRATIONS_ON_BOOT: value });
      expect(r.ok).toBe(true);
      expect(r.invoked).toHaveLength(1);
    },
  );
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
