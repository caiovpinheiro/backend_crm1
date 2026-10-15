/**
 * Proteção contra sobrecarga (`overload-guard.ts`) com medidor e relógio
 * falsos: recusa (d) acessórias primeiro, depois (c) leituras pesadas, nunca
 * (a) essenciais nem (b) leituras comuns; histerese para sair.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyApiRequest } from "@/lib/api-cost-class";
import { enforceApiCostLimits, resetApiCostLimitForTests } from "@/lib/api-cost-limit";
import { registry } from "@/lib/metrics";
import {
  OverloadGuard,
  getOverloadConfig,
  isOverloadWarmingUp,
  nextOverloadState,
  overloadRejectsClass,
  setOverloadGuardForTests,
  type OverloadConfig,
} from "@/lib/overload-guard";

const CFG: OverloadConfig = getOverloadConfig({});

let clock = 0;
let p99 = 0;
let guard: OverloadGuard;

/** Uma fatia de 2 s (janela de 10 s / 5) com o p99 dado. */
function slice(ms: number) {
  p99 = ms;
  clock += 2_000;
  return guard.tick();
}

function call(method: string, path: string) {
  return enforceApiCostLimits({
    userId: "u1",
    organizationId: "org1",
    cls: classifyApiRequest({ method, path }),
    method,
    path,
  });
}

beforeEach(() => {
  clock = 1_000_000;
  p99 = 0;
  guard = new OverloadGuard(
    () => ({ p50Ms: p99 / 4, p99Ms: p99 }),
    () => clock,
    () => CFG,
  );
  setOverloadGuardForTests(guard);
  resetApiCostLimitForTests({ redis: null, now: () => clock, emit: () => undefined });
});

afterEach(() => {
  setOverloadGuardForTests(null);
  resetApiCostLimitForTests();
});

describe("configuração", () => {
  it("padrões: 200 ms / 10 s; nível 2 a partir de 500 ms; sai abaixo de 150 ms", () => {
    expect(CFG).toEqual({
      thresholdMs: 200,
      windowMs: 10_000,
      heavyThresholdMs: 500,
      recoverMs: 150,
      retryAfterMs: 5_000,
      warmupMs: 60_000,
    });
    expect(
      getOverloadConfig({
        OVERLOAD_P99_MS: "100",
        OVERLOAD_WINDOW_MS: "5000",
        OVERLOAD_HEAVY_P99_MS: "300",
        OVERLOAD_RECOVER_P99_MS: "80",
        OVERLOAD_RETRY_AFTER_MS: "60000",
        OVERLOAD_WARMUP_MS: "30000",
      }),
    ).toEqual({
      thresholdMs: 100,
      windowMs: 5_000,
      heavyThresholdMs: 300,
      recoverMs: 80,
      retryAfterMs: 5_000,
      warmupMs: 30_000,
    });
    expect(getOverloadConfig({ OVERLOAD_WARMUP_MS: "0" }).warmupMs).toBe(0);
    expect(getOverloadConfig({ OVERLOAD_P99_MS: "0" }).thresholdMs).toBe(0);
  });
});

describe("níveis (transição pura)", () => {
  it("entra em 1, sobe para 2 depois de mais uma janela acima, sai só abaixo do limite de recuperação", () => {
    let s = nextOverloadState({ level: 0, aboveSince: null }, { p99Ms: 250, now: 0 }, CFG);
    expect(s).toEqual({ level: 1, aboveSince: 0 });
    s = nextOverloadState(s, { p99Ms: 250, now: 9_999 }, CFG);
    expect(s.level).toBe(1);
    s = nextOverloadState(s, { p99Ms: 250, now: 10_000 }, CFG);
    expect(s.level).toBe(2);
    s = nextOverloadState(s, { p99Ms: 170, now: 12_000 }, CFG); // faixa de histerese
    expect(s.level).toBe(2);
    s = nextOverloadState(s, { p99Ms: 149, now: 14_000 }, CFG);
    expect(s).toEqual({ level: 0, aboveSince: null });
  });

  it("p99 acima do segundo limite vai direto ao nível 2", () => {
    expect(
      nextOverloadState({ level: 0, aboveSince: null }, { p99Ms: 600, now: 0 }, CFG).level,
    ).toBe(2);
  });

  it("OVERLOAD_P99_MS=0 desliga", () => {
    const off = { ...CFG, thresholdMs: 0 };
    expect(nextOverloadState({ level: 2, aboveSince: 0 }, { p99Ms: 9_999, now: 1 }, off).level).toBe(0);
  });

  it("quem é recusado em cada nível", () => {
    expect(overloadRejectsClass(0, "accessory")).toBe(false);
    expect(overloadRejectsClass(1, "accessory")).toBe(true);
    expect(overloadRejectsClass(1, "heavy_read")).toBe(false);
    expect(overloadRejectsClass(2, "heavy_read")).toBe(true);
    for (const level of [0, 1, 2] as const) {
      expect(overloadRejectsClass(level, "essential")).toBe(false);
      expect(overloadRejectsClass(level, "cached_read")).toBe(false);
    }
  });
});

describe("janela deslizante e recusa por classe", () => {
  it("recusa (d), depois (c), nunca (a) nem (b); volta ao normal com a janela calma", async () => {
    for (let i = 0; i < 5; i++) slice(20);
    expect(guard.snapshot().level).toBe(0);
    expect(await call("POST", "/api/agents/me/ping")).toBeNull();

    // Event loop atrasado: p99 250 ms.
    expect(slice(250).level).toBe(1);
    const ping = await call("POST", "/api/agents/me/ping");
    expect(ping?.status).toBe(503);
    expect(ping!.headers.get("Retry-After")).toBe("5");
    expect(await ping!.json()).toMatchObject({
      code: "OVERLOADED",
      class: "accessory",
      retryAfterMs: 5_000,
    });
    expect(await call("POST", "/api/presence/heartbeat")).not.toBeNull();
    expect(await call("GET", "/api/pipelines/p1/board")).toBeNull(); // (c) ainda passa
    expect(await call("POST", "/api/conversations/c1/messages")).toBeNull();
    expect(await call("GET", "/api/settings/channels")).toBeNull();

    // Continua acima por mais uma janela → (c) também.
    for (let i = 0; i < 4; i++) expect(slice(250).level).toBe(1);
    expect(slice(250).level).toBe(2);
    const board = await call("GET", "/api/pipelines/p1/board");
    expect(board?.status).toBe(503);
    expect(await board!.json()).toMatchObject({ code: "OVERLOADED", class: "heavy_read" });
    expect(await call("GET", "/api/deals/d1")).not.toBeNull();
    // (a) e (b) nunca.
    expect(await call("POST", "/api/conversations/c1/messages")).toBeNull();
    expect(await call("POST", "/api/conversations/c1/attachments")).toBeNull();
    expect(await call("PATCH", "/api/deals/d1")).toBeNull();
    expect(await call("POST", "/api/deals/d1/move")).toBeNull();
    expect(await call("GET", "/api/settings/channels")).toBeNull();

    // Histerese: 170 ms não tira do nível; a janela ainda tem fatias de 250.
    expect(slice(170).level).toBe(2);
    // Calmo: só sai quando a janela inteira fica abaixo de 150 ms.
    for (let i = 0; i < 4; i++) expect(slice(30).level).toBe(2);
    expect(slice(30).level).toBe(0);
    expect(await call("POST", "/api/agents/me/ping")).toBeNull();
    expect(await call("GET", "/api/pipelines/p1/board")).toBeNull();
  });

  it("p50/p99 da janela: p99 = maior fatia, p50 = mediana", () => {
    slice(100);
    slice(40);
    const snap = slice(60);
    expect(snap.p99Ms).toBe(100);
    expect(snap.p50Ms).toBe(15);
  });
});

describe("aquecimento do processo (OVERLOAD_WARMUP_MS, padrão 60 s)", () => {
  let uptime = 0;

  async function spared(cls: string): Promise<number> {
    const m = await registry.getSingleMetric("crm_overload_warmup_spared_total")?.get();
    return m?.values.find((v) => v.labels.class === cls)?.value ?? 0;
  }

  beforeEach(() => {
    uptime = 0;
    setOverloadGuardForTests(guard, { uptimeMs: () => uptime });
    delete process.env.OVERLOAD_WARMUP_MS;
  });
  afterEach(() => {
    delete process.env.OVERLOAD_WARMUP_MS;
  });

  it("nos primeiros 60 s mede (nível 2) mas não recusa; aos 60 s o nível medido vale na hora", async () => {
    uptime = 5_000;
    expect(slice(700).level).toBe(2); // cache frio / JIT: p99 700 ms
    expect(isOverloadWarmingUp()).toBe(true);
    const s0 = await spared("accessory");
    const h0 = await spared("heavy_read");
    expect(await call("POST", "/api/agents/me/ping")).toBeNull();
    expect(await call("GET", "/api/pipelines/p1/board")).toBeNull();
    expect((await spared("accessory")) - s0).toBe(1);
    expect((await spared("heavy_read")) - h0).toBe(1);

    uptime = 59_999;
    expect(await call("GET", "/api/pipelines/p1/board")).toBeNull();

    uptime = 60_000;
    expect(isOverloadWarmingUp()).toBe(false);
    const board = await call("GET", "/api/pipelines/p1/board");
    expect(board?.status).toBe(503);
    expect(await board!.json()).toMatchObject({ code: "OVERLOADED", class: "heavy_read" });
  });

  it("no aquecimento nada é recusado mesmo em nível 0 → a métrica não conta (só o que SERIA 503)", async () => {
    uptime = 1_000;
    slice(20);
    const s0 = await spared("accessory");
    expect(await call("POST", "/api/agents/me/ping")).toBeNull();
    expect(await spared("accessory")).toBe(s0);
  });

  it("OVERLOAD_WARMUP_MS=0 desliga: recusa desde o 1º segundo", async () => {
    process.env.OVERLOAD_WARMUP_MS = "0";
    uptime = 1_000;
    slice(250);
    expect((await call("POST", "/api/agents/me/ping"))?.status).toBe(503);
  });

  it("OVERLOAD_WARMUP_MS=20000: 20 s de aquecimento", async () => {
    process.env.OVERLOAD_WARMUP_MS = "20000";
    uptime = 19_000;
    slice(250);
    expect(await call("POST", "/api/agents/me/ping")).toBeNull();
    uptime = 20_000;
    expect((await call("POST", "/api/agents/me/ping"))?.status).toBe(503);
  });

  it("simulação de deploy: 90 s de event loop frio nos 1ºs 45 s, 20 abas → 0 recusas no aquecimento (antes dezenas)", async () => {
    // A cada fatia (2 s): 20 abas fazem 1 chamada acessória e 1 leitura pesada.
    async function run(warmup: string): Promise<{ warm503: number; after503: number }> {
      process.env.OVERLOAD_WARMUP_MS = warmup;
      guard = new OverloadGuard(
        () => ({ p50Ms: p99 / 4, p99Ms: p99 }),
        () => clock,
        () => CFG,
      );
      setOverloadGuardForTests(guard, { uptimeMs: () => uptime });
      resetApiCostLimitForTests({ redis: null, now: () => clock, emit: () => undefined });
      let warm503 = 0;
      let after503 = 0;
      for (uptime = 2_000; uptime <= 90_000; uptime += 2_000) {
        // Processo novo: p99 600 ms até 30 s, 250 ms até 45 s, depois 30 ms.
        slice(uptime <= 30_000 ? 600 : uptime <= 45_000 ? 250 : 30);
        for (let tab = 0; tab < 20; tab++) {
          for (const [m, path] of [
            ["POST", "/api/agents/me/ping"],
            ["GET", "/api/pipelines/p1/board"],
          ] as const) {
            const res = await enforceApiCostLimits({
              userId: `u${tab}`,
              organizationId: "org1",
              cls: classifyApiRequest({ method: m, path }),
              method: m,
              path,
            });
            if (res?.status === 503) {
              if (uptime < 60_000) warm503++;
              else after503++;
            }
          }
        }
      }
      return { warm503, after503 };
    }
    const before = await run("0");
    const after = await run("60000");
    expect(before.warm503).toBeGreaterThan(400);
    expect(after.warm503).toBe(0);
    // Passado o aquecimento a janela já está calma: ninguém recusado depois.
    expect(after.after503).toBe(0);
    process.stdout.write(
      `[gate E] deploy, 20 abas: 503 nos 1ºs 60 s sem aquecimento=${before.warm503}, com=${after.warm503}
`,
    );
  });
});
