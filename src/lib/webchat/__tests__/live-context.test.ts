import { describe, expect, it } from "vitest";

import {
  applyContextPatch,
  mergeContextStates,
  readContextState,
  sanitizeContextPatch,
} from "@/lib/webchat/live-context";

describe("sanitizeContextPatch", () => {
  it("aceita valores simples, null remove, o resto é ignorado", () => {
    const p = sanitizeContextPatch(
      { tela: "pagamento", passo: 3, ok: true, apagar: null, obj: { a: 1 }, lista: [1], nan: NaN, "chave x": "v" },
      { maxValueChars: 200 },
    );
    expect(p).toEqual({
      set: { tela: "pagamento", passo: 3, ok: true },
      remove: ["apagar"],
      ignored: ["obj", "lista", "nan", "chave x"],
    });
  });

  it("corta no limite de caracteres e limpa controle", () => {
    const p = sanitizeContextPatch({ erro: "linha1\nlinha2\u0000fim", longo: "x".repeat(50) }, { maxValueChars: 10 });
    expect(p?.set.erro).toBe("linha1 lin");
    expect(p?.set.longo).toHaveLength(10);
  });

  it("corpo que não é objeto = null", () => {
    expect(sanitizeContextPatch([1], { maxValueChars: 10 })).toBeNull();
    expect(sanitizeContextPatch("x", { maxValueChars: 10 })).toBeNull();
  });
});

describe("applyContextPatch (merge raso com limites)", () => {
  const patch = (set: Record<string, string | number | boolean>, remove: string[] = []) => ({
    set,
    remove,
    ignored: [],
  });

  it("substitui só as chaves enviadas", () => {
    const r = applyContextPatch({ a: "1", b: "2" }, patch({ b: "3", c: "4" }), 10);
    expect(r).toEqual({ state: { a: "1", b: "3", c: "4" }, changed: true, ignored: [] });
  });

  it("envio idêntico não muda", () => {
    expect(applyContextPatch({ a: "1" }, patch({ a: "1" }), 10).changed).toBe(false);
  });

  it("chave nova além de maxKeys é ignorada; existentes ainda atualizam", () => {
    const r = applyContextPatch({ a: "1", b: "2" }, patch({ a: "9", c: "3" }), 2);
    expect(r.state).toEqual({ a: "9", b: "2" });
    expect(r.ignored).toEqual(["c"]);
  });

  it("remoção libera espaço no mesmo envio", () => {
    const r = applyContextPatch({ a: "1", b: "2" }, patch({ c: "3" }, ["a"]), 2);
    expect(r.state).toEqual({ b: "2", c: "3" });
  });
});

describe("readContextState / mergeContextStates", () => {
  it("lê só valores simples com chave válida", () => {
    expect(readContextState({ a: 1, b: { x: 1 }, "c d": "x", e: "ok" })).toEqual({ a: 1, e: "ok" });
    expect(readContextState(null)).toEqual({});
  });

  it("chave repetida: vence o mais recente", () => {
    const old = { state: { a: "velho", b: "só antigo" }, updatedAt: new Date("2026-01-01") };
    const neu = { state: { a: "novo" }, updatedAt: new Date("2026-02-01") };
    expect(mergeContextStates(old, neu)).toEqual({
      state: { a: "novo", b: "só antigo" },
      updatedAt: neu.updatedAt,
    });
    expect(mergeContextStates(neu, old).state.a).toBe("novo");
  });
});
