import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Exercita o `scripts/healthcheck.mjs` real (HEALTHCHECK do Dockerfile). */
const script = resolve(process.cwd(), "scripts/healthcheck.mjs");
const dir = mkdtempSync(join(tmpdir(), "hc-"));
let server: Server;
let port = 0;
let status = 200;

function run(state: string | null, env: Record<string, string> = {}): Promise<number> {
  const stateFile = join(dir, `state-${Math.random().toString(36).slice(2)}`);
  if (state !== null) writeFileSync(stateFile, state);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv.APP_MODE;
  delete childEnv.PORT;
  Object.assign(childEnv, env, { HEALTHCHECK_STATE_FILE: stateFile, HEALTHCHECK_TIMEOUT_MS: "2000" });
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [script], { env: childEnv, stdio: "ignore" });
    child.on("error", rej);
    child.on("exit", (code) => res(code ?? -1));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.statusCode = req.url === "/api/health" ? status : 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("scripts/healthcheck.mjs", () => {
  it("worker sai 0 sem tocar HTTP", async () => {
    expect(await run("APP_MODE=worker-whatsapp\nPORT=1\n")).toBe(0);
  });

  it("modo desconhecido (sem arquivo e sem env) sai 0", async () => {
    expect(await run(null)).toBe(0);
  });

  it("api com /api/health 200 → 0; 503 (degraded) → 0; 500 → 1", async () => {
    status = 200;
    expect(await run(`APP_MODE=api\nPORT=${port}\n`)).toBe(0);
    status = 503;
    expect(await run(`APP_MODE=api-public\nPORT=${port}\n`)).toBe(0);
    status = 500;
    expect(await run(`APP_MODE=api\nPORT=${port}\n`)).toBe(1);
    status = 200;
  });

  it("api sem servidor ouvindo → 1", async () => {
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", () => r()));
    const closedPort = (free.address() as AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));
    expect(await run(`APP_MODE=api\nPORT=${closedPort}\n`)).toBe(1);
  });

  it("sem arquivo de estado usa APP_MODE/PORT do ambiente", async () => {
    status = 200;
    expect(await run(null, { APP_MODE: "api", PORT: String(port) })).toBe(0);
  });
});
