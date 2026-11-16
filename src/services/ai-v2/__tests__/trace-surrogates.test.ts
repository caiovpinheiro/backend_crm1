import { describe, expect, it } from "vitest";

import { dropLoneSurrogates, runWithV2Trace, sliceWholeChars, takeV2TraceForLog, traceStep } from "../trace";

// DNAWORK #83167: nome "Francisco Ribamar 🏽🏼🏽" no título do negócio; o corte
// do passo em 300 caiu no meio do emoji e o log do turno foi recusado.
const isWellFormed = (s: string) => dropLoneSurrogates(s) === s;

describe("corte de texto sem partir emoji", () => {
  it("sliceWholeChars não deixa meio emoji no fim", () => {
    const s = "a".repeat(9) + "\u{1F3FD}b";
    expect(sliceWholeChars(s, 10)).toBe("a".repeat(9));
    expect(sliceWholeChars(s, 11)).toBe("a".repeat(9) + "\u{1F3FD}");
    expect(sliceWholeChars("abc", 10)).toBe("abc");
  });

  it("dropLoneSurrogates tira só as metades soltas", () => {
    expect(dropLoneSurrogates("x\uD83Cy")).toBe("xy");
    expect(dropLoneSurrogates("x\uDFFDy")).toBe("xy");
    expect(dropLoneSurrogates("ok \u{1F3FD}\u{1F3FC} 😊")).toBe("ok \u{1F3FD}\u{1F3FC} 😊");
  });

  it("passo longo com emoji na posição do corte fica bem formado", async () => {
    // Emoji começa na posição 299: o corte em 300 cairia no meio dele.
    const detail = "x".repeat(299) + "\u{1F3FD}\u{1F3FC}\u{1F3FD} (8 campos)";
    const trace = await runWithV2Trace(async () => {
      traceStep("dados", detail);
      return takeV2TraceForLog();
    });
    const out = trace![0].detail;
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(out.endsWith("…")).toBe(true);
  });
});
