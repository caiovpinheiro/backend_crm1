import { describe, expect, it } from "vitest";

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { allowedActionTypes, themeToolRestriction } from "../action-policy";
import { defaultV2Counters, evaluateV2StopLimits } from "../limits";

const base = { name: "A", tone: "t" };

describe("config: campos que a tela grava", () => {
  it("mensagem apagada na tela vale como não preenchida", () => {
    const c = normalizeV2Config({
      ...base,
      handoff: { defaultDestination: { type: "department" }, message: "  " },
      entry: { confirmationMessage: "", identificationMessage: "" },
      media: { audio: { action: "handoff", handoffMessage: "" } },
      fallback: { error: { message: "" } },
    } as never);
    expect(c.handoff.message).toBe("Vou transferir para um atendente.");
    expect(c.entry.confirmationMessage).toBeUndefined();
    expect(c.entry.identificationMessage).toBeUndefined();
    expect(c.media.audio.handoffMessage).toBeUndefined();
    expect(c.fallback?.error?.message).toBeUndefined();
  });

  it("regra guarda ligada/desligada (padrão ligada) e assunto guarda transferência direta", () => {
    const c = normalizeV2Config({
      ...base,
      rules: [
        { id: "a", name: "A", enabled: false },
        { id: "b", name: "B" },
      ],
      themes: [{ id: "t", name: "T", instructions: "", directHandoff: true }],
    } as never);
    expect(c.rules.map((r) => r.enabled)).toEqual([false, true]);
    expect(c.themes[0].directHandoff).toBe(true);
  });
});

describe("action-policy", () => {
  const config = normalizeV2Config({ ...base, enabledTools: ["ask_with_options"] } as never);

  it("assunto com lista vazia (como a tela cria) não restringe", () => {
    const theme = { id: "t", name: "T", instructions: "", allowedTools: [] } as never;
    expect(themeToolRestriction(theme)).toBeNull();
    expect(allowedActionTypes(config, theme).has("ask_with_options")).toBe(true);
  });

  it("assunto com lista restringe às ações dele", () => {
    const theme = { id: "t", name: "T", instructions: "", allowedTools: ["add_tag"] } as never;
    const allowed = allowedActionTypes(config, theme);
    expect(allowed.has("add_tag")).toBe(true);
    expect(allowed.has("ask_with_options")).toBe(false);
  });
});

describe("avisar e silenciar", () => {
  it("avisa só no turno em que o limite é atingido", () => {
    const config = normalizeV2Config({ ...base, limits: { nonsenseLimit: 2, nonsenseAction: "warn_and_silence" } } as never);
    const counters = { ...defaultV2Counters(), nonsenseMessages: 2 };
    expect(evaluateV2StopLimits(config, counters, "a", { countLoop: false })).toMatchObject({ blocksReply: true, warn: true });
    counters.nonsenseMessages = 3;
    expect(evaluateV2StopLimits(config, counters, "b", { countLoop: false })).toMatchObject({ blocksReply: true, warn: false });
  });

  it("com transferência configurada não avisa, transfere", () => {
    const config = normalizeV2Config({ ...base, limits: { nonsenseLimit: 2, nonsenseAction: "handoff" } } as never);
    const r = evaluateV2StopLimits(config, { ...defaultV2Counters(), nonsenseMessages: 2 }, "a", { countLoop: false });
    expect(r).toMatchObject({ action: "handoff", warn: false });
  });
});

describe("guarda de saída", () => {
  it("remover link não autorizado mantém as linhas do passo a passo", async () => {
    const { guardV2Output } = await import("../output-guard");
    const text = ["1. Acesse https://fora.com/x", "2. Clique em Entrar", "3. Pronto"].join(String.fromCharCode(10));
    const r = guardV2Output(text, ["permitido.com"]);
    expect(r.text.split(String.fromCharCode(10))).toEqual(["1. Acesse", "2. Clique em Entrar", "3. Pronto"]);
  });
});
