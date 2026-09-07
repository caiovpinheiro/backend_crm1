import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOOL_CALL_LIMITS,
  ToolCallGovernor,
  denialPayload,
  normalizeToolCallLimits,
  replayPayload,
  toolCallKey,
} from "@/services/ai/tool-governor";

const limits = { maxToolCallsPerRun: 24, maxRepeatsPerTool: 3 };

describe("toolCallKey", () => {
  it("trata a mesma chamada com ordem de chaves diferente como repetição", () => {
    const a = toolCallKey("transfer_to_department", {
      department: "Atendimento",
      reason: "aluno pediu",
    });
    const b = toolCallKey("transfer_to_department", {
      reason: "aluno pediu",
      department: "Atendimento",
    });
    expect(a).toBe(b);
  });

  it("normaliza caixa e espaços — 'Atendimento' e 'atendimento ' são a mesma tentativa", () => {
    expect(toolCallKey("t", { d: "Atendimento" })).toBe(
      toolCallKey("t", { d: "atendimento " }),
    );
  });

  it("distingue argumentos de verdade diferentes", () => {
    expect(toolCallKey("t", { d: "Atendimento" })).not.toBe(
      toolCallKey("t", { d: "Financeiro" }),
    );
  });
});

describe("ToolCallGovernor", () => {
  it("sintoma original: nove chamadas idênticas no mesmo run", () => {
    const g = new ToolCallGovernor(limits);
    const args = { department: "Atendimento" };

    expect(g.decide("execute_distribution", args)).toEqual({ action: "run" });
    g.record("execute_distribution", args, { ok: false, error: "sem agente" });

    // As oito repetições seguintes não reexecutam: voltam do cache.
    for (let i = 0; i < 8; i++) {
      const d = g.decide("execute_distribution", args);
      expect(d.action).toBe("replay");
      if (d.action === "replay") {
        expect(d.previousResult).toEqual({ ok: false, error: "sem agente" });
      }
    }
    expect(g.stats()).toMatchObject({ totalCalls: 1, replays: 8 });
  });

  it("o aviso de repetição diz explicitamente que já foi tentado", () => {
    const payload = replayPayload("execute_distribution", { ok: false });
    expect(payload.alreadyAttempted).toBe(true);
    expect(payload.warning).toContain("já chamou");
    expect(payload.warning).toContain("NÃO repita");
    expect(payload.previousResult).toEqual({ ok: false });
  });

  it("teto por ferramenta barra a 4ª chamada com argumentos diferentes", () => {
    const g = new ToolCallGovernor(limits);
    for (let i = 0; i < 3; i++) {
      expect(g.decide("consultar_matricula", { cpf: `${i}` }).action).toBe(
        "run",
      );
      g.record("consultar_matricula", { cpf: `${i}` }, { ok: true });
    }
    const denied = g.decide("consultar_matricula", { cpf: "9" });
    expect(denied).toEqual({ action: "deny", reason: "tool_cap" });
    expect(g.limitHit).toBe(true);
  });

  it("teto global barra qualquer ferramenta e marca limitHit", () => {
    const g = new ToolCallGovernor({
      maxToolCallsPerRun: 2,
      maxRepeatsPerTool: 99,
    });
    g.record("a", { i: 1 }, {});
    g.record("b", { i: 2 }, {});
    expect(g.decide("c", { i: 3 })).toEqual({
      action: "deny",
      reason: "run_cap",
    });
    expect(g.limitHit).toBe(true);
  });

  it("recusa devolve ok:false com limitReached, não uma exceção", () => {
    expect(denialPayload("execute_distribution", "tool_cap")).toMatchObject({
      ok: false,
      limitReached: true,
    });
  });

  it("chamada distinta continua passando enquanto há folga", () => {
    const g = new ToolCallGovernor(limits);
    g.record("add_tag", { tag: "quente" }, { ok: true });
    expect(g.decide("add_tag", { tag: "frio" }).action).toBe("run");
    expect(g.limitHit).toBe(false);
  });
});

describe("normalizeToolCallLimits", () => {
  it("0, negativo e null caem no default seguro", () => {
    expect(
      normalizeToolCallLimits({ maxToolCallsPerRun: 0, maxRepeatsPerTool: -1 }),
    ).toEqual(DEFAULT_TOOL_CALL_LIMITS);
    expect(normalizeToolCallLimits(null)).toEqual(DEFAULT_TOOL_CALL_LIMITS);
  });

  it("respeita valor configurado pelo operador", () => {
    expect(
      normalizeToolCallLimits({ maxToolCallsPerRun: 5, maxRepeatsPerTool: 2 }),
    ).toEqual({ maxToolCallsPerRun: 5, maxRepeatsPerTool: 2 });
  });
});
