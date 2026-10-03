import { describe, expect, it } from "vitest";

import { resolveApiSweepers, resolveAutomationExecution } from "./background-mode";

const PROD = { NODE_ENV: "production" };
const DEV = { NODE_ENV: "development" };

describe("resolveApiSweepers", () => {
  it("produção sem variável: API não sobe sweepers (padrão seguro)", () => {
    expect(resolveApiSweepers({ ...PROD, APP_MODE: "api" })).toEqual({
      enabled: false,
      reason: "production_default",
    });
    expect(resolveApiSweepers({ ...PROD })).toMatchObject({ enabled: false });
  });

  it("dev local sem variável: mantém os sweepers na API", () => {
    expect(resolveApiSweepers({ ...DEV, APP_MODE: "api" })).toEqual({
      enabled: true,
      reason: "dev_default",
    });
    expect(resolveApiSweepers({})).toMatchObject({ enabled: true });
  });

  it.each(["1", "true", "YES", "on", ' "1" '])("API_RUN_SWEEPERS=%j liga mesmo em produção", (v) => {
    expect(resolveApiSweepers({ ...PROD, API_RUN_SWEEPERS: v })).toEqual({
      enabled: true,
      reason: "explicit_on",
    });
  });

  it.each(["0", "false", "no", "OFF"])("API_RUN_SWEEPERS=%j desliga mesmo em dev", (v) => {
    expect(resolveApiSweepers({ ...DEV, API_RUN_SWEEPERS: v })).toEqual({
      enabled: false,
      reason: "explicit_off",
    });
  });

  it("legado: AUTOMATION_WORKER_MODE=external desliga em qualquer ambiente", () => {
    expect(resolveApiSweepers({ ...DEV, AUTOMATION_WORKER_MODE: "external" })).toEqual({
      enabled: false,
      reason: "automation_external",
    });
  });

  it("explícito vence o legado", () => {
    expect(
      resolveApiSweepers({ ...PROD, AUTOMATION_WORKER_MODE: "external", API_RUN_SWEEPERS: "1" }),
    ).toMatchObject({ enabled: true });
  });

  it.each(["api-public", "worker-whatsapp", "worker-automation"])(
    "APP_MODE=%s nunca sobe (nem com API_RUN_SWEEPERS=1)",
    (mode) => {
      expect(resolveApiSweepers({ ...DEV, APP_MODE: mode, API_RUN_SWEEPERS: "1" })).toEqual({
        enabled: false,
        reason: "not_api",
      });
    },
  );

  it("build e flag de teste desligam", () => {
    expect(resolveApiSweepers({ NEXT_PHASE: "phase-production-build" }).reason).toBe("build");
    expect(resolveApiSweepers({ CRM_SKIP_BACKGROUND_SERVERS: "1" }).reason).toBe("skip_flag");
  });
});

describe("resolveAutomationExecution", () => {
  it("API em produção sem variável: enfileira (worker-automation executa)", () => {
    expect(resolveAutomationExecution({ ...PROD, APP_MODE: "api" })).toEqual({
      mode: "external",
      defaulted: true,
    });
    expect(resolveAutomationExecution({ ...PROD, APP_MODE: "api-public" }).mode).toBe("external");
    expect(resolveAutomationExecution({ ...PROD }).mode).toBe("external");
  });

  it("workers sem variável: inalterado (inline)", () => {
    for (const mode of ["worker-meta-webhook", "worker-whatsapp", "worker-automation"]) {
      expect(resolveAutomationExecution({ ...PROD, APP_MODE: mode })).toEqual({
        mode: "inline",
        defaulted: true,
      });
    }
  });

  it("dev local sem variável: inline", () => {
    expect(resolveAutomationExecution({ ...DEV, APP_MODE: "api" }).mode).toBe("inline");
  });

  it("valor explícito vence o padrão", () => {
    expect(resolveAutomationExecution({ ...PROD, AUTOMATION_WORKER_MODE: "inline" })).toEqual({
      mode: "inline",
      defaulted: false,
    });
    expect(
      resolveAutomationExecution({ ...DEV, APP_MODE: "worker-meta-webhook", AUTOMATION_WORKER_MODE: ' "External" ' }),
    ).toEqual({ mode: "external", defaulted: false });
  });
});
