/**
 * `pack.intercepts` sempre iterável.
 *
 * Bug: `TypeError: a.intercepts is not iterable` no `[ai-inbox] erro
 * não-fatal` — `runVerticalIntercepts` faz `for (const i of pack.intercepts)`
 * e o getter do pack academic devolvia o valor cru de um `require()` lazy
 * (cast, sem checagem em runtime). Alias `@/…` não resolve fora do bundler e
 * módulo em meio de inicialização (ciclo pack ↔ services/ai) devolve
 * `undefined` — nos dois casos o `for…of` quebrava.
 */
import { describe, expect, it } from "vitest";

import { getVerticalPack, listVerticalPackIds } from "@/verticals";

describe("vertical pack — intercepts", () => {
  it("pack academic devolve intercepts iteráveis", () => {
    const pack = getVerticalPack("academic")!;

    expect(Array.isArray(pack.intercepts)).toBe(true);
    expect([...pack.intercepts].length).toBeGreaterThan(0);
    expect(pack.intercepts.map((i) => i.phase)).toEqual(
      expect.arrayContaining(["pre_assignee", "post_assignee"]),
    );
  });

  it("todo pack do registry tem intercepts como array", () => {
    for (const id of listVerticalPackIds()) {
      const pack = getVerticalPack(id)!;
      expect(Array.isArray(pack.intercepts), `pack ${id}`).toBe(true);
    }
  });
});
