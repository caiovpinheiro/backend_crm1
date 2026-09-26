import { describe, expect, it } from "vitest";

import { applyConfigChanges, getAtPath, parseConfigPath } from "../config-patch";

const base = {
  handoff: { defaultDestination: { type: "ai_agent", id: "a1" }, message: "Vou transferir." },
  themes: [
    { id: "t1", name: "Entrega", when: ["prazo"] },
    { id: "t2", name: "Troca", when: ["trocar", "prazo"] },
  ],
  rules: [{ id: "r1", conditions: [{ type: "keywords", values: ["pessoa", "humano"] }] }],
  allowedMessageModelIds: ["m1", "m2"],
};

describe("alterações na configuração", () => {
  it("lê o caminho com seletor por id e por posição", () => {
    expect(parseConfigPath("themes[id=t2].when")).toHaveLength(3);
    expect(getAtPath(base, "themes[id=t2].when")).toEqual(["trocar", "prazo"]);
    expect(getAtPath(base, "rules[id=r1].conditions[0].values")).toEqual(["pessoa", "humano"]);
    expect(getAtPath(base, "fallback.noSource.message")).toBeUndefined();
  });

  it("set, add, remove e remoção de item — sem mexer no original", () => {
    const out = applyConfigChanges(base, [
      { path: "handoff.defaultDestination", op: "set", value: { type: "department", id: "d1" } },
      { path: "themes[id=t1].when", op: "add", value: ["troca de prazo", "prazo"] },
      { path: "themes[id=t2].when", op: "remove", value: "prazo" },
      { path: "rules[id=r1].conditions[0].values", op: "set", value: ["falar com uma pessoa"] },
      { path: "allowedMessageModelIds", op: "remove", value: "m2" },
      { path: "fallback.noSource.message", op: "set", value: "Não tenho essa informação." },
    ]);
    expect(out.handoff.defaultDestination).toEqual({ type: "department", id: "d1" });
    expect(out.themes[0].when).toEqual(["prazo", "troca de prazo"]);
    expect(out.themes[1].when).toEqual(["trocar"]);
    expect(out.rules[0].conditions[0].values).toEqual(["falar com uma pessoa"]);
    expect(out.allowedMessageModelIds).toEqual(["m1"]);
    expect((out as unknown as { fallback: { noSource: { message: string } } }).fallback.noSource.message).toBe("Não tenho essa informação.");
    expect(base.themes[1].when).toEqual(["trocar", "prazo"]);

    const removed = applyConfigChanges(base, [{ path: "themes[id=t2]", op: "remove" }]);
    expect(removed.themes.map((t) => t.id)).toEqual(["t1"]);
  });

  it("caminho ou item inexistente: erro e nada muda", () => {
    expect(() => applyConfigChanges(base, [{ path: "themes[id=nao-existe].when", op: "add", value: "x" }])).toThrow(/Item não encontrado/);
    expect(() => applyConfigChanges(base, [{ path: "themes..when", op: "add", value: "x" }])).toThrow(/Caminho inválido/);
    expect(() => applyConfigChanges(base, [{ path: "handoff.message", op: "add", value: "x" }])).toThrow(/exige uma lista/);
  });

  it("nunca toca no protótipo dos objetos", () => {
    for (const path of ["__proto__.x", "handoff.__proto__.x", "themes[__proto__=a].when", "constructor.prototype.x", "handoff.constructor"]) {
      expect(() => applyConfigChanges(base, [{ path, op: "set", value: "y" }])).toThrow(/inválid/);
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(getAtPath(base, "__proto__")).toBeUndefined();
  });
});
