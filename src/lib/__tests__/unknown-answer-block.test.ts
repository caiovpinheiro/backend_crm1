import { describe, expect, it } from "vitest";

import {
  buildUnknownAnswerBlock,
  normalizeInboxPolicy,
} from "@/lib/ai-agents/steering";

function policy(over: Record<string, unknown> = {}) {
  return normalizeInboxPolicy(over);
}

describe("buildUnknownAnswerBlock", () => {
  it("pede o marcador de confiança quando o handoff por confiança está ligado", () => {
    const block = buildUnknownAnswerBlock(policy({ confidenceThreshold: 0.55 }));
    expect(block).toContain("[CONFIANCA:X.X]");
    expect(block).toContain("0.55");
  });

  it("omite o marcador quando o handoff por confiança está desligado", () => {
    const block = buildUnknownAnswerBlock(
      policy({ lowConfidenceHandoff: false }),
    );
    expect(block).not.toContain("[CONFIANCA:X.X]");
    // A proibição de inventar vale nos dois casos.
    expect(block).toContain("PROIBIDO inventar");
  });

  it("modo handoff manda transferir na mesma resposta", () => {
    expect(buildUnknownAnswerBlock(policy())).toContain("transfira");
  });

  it("modo clarify pergunta antes de transferir", () => {
    const block = buildUnknownAnswerBlock(
      policy({ unknownAnswerMode: "clarify" }),
    );
    expect(block).toContain("UMA pergunta objetiva");
  });

  it("modo acknowledge proíbe transferir só por não saber", () => {
    const block = buildUnknownAnswerBlock(
      policy({ unknownAnswerMode: "acknowledge" }),
    );
    expect(block).toContain("NÃO transfira");
  });

  it("usa a frase configurada ao admitir que não sabe", () => {
    const block = buildUnknownAnswerBlock(
      policy({ unknownAnswerMessage: "Não sei te dizer isso." }),
    );
    expect(block).toContain('"Não sei te dizer isso."');
  });

  it("pack academic mantém os modelos internos ligados por padrão", () => {
    expect(normalizeInboxPolicy({}, "academic").useMessageModels).toBe(true);
    expect(normalizeInboxPolicy({}).useMessageModels).toBe(false);
  });

  it("modo inválido cai no default handoff", () => {
    expect(policy({ unknownAnswerMode: "xpto" }).unknownAnswerMode).toBe(
      "handoff",
    );
  });
});
