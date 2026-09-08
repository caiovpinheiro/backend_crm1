import { describe, expect, it } from "vitest";

import {
  buildUnknownAnswerBlock,
  messagePromisesTransfer,
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

/**
 * O gate rebaixou o modo para `acknowledge`, mas a frase do operador
 * continuava prometendo transferência: o MESMO bloco mandava dizer "vou te
 * transferir para um consultor agora" e, duas linhas abaixo, "NÃO transfira
 * só por não saber um item".
 */
describe("frase do operador contra o modo forçado", () => {
  const promise = "Vou te transferir para um consultor agora.";

  it("gate fechado: a frase que promete transferência não vai ao prompt", () => {
    const block = buildUnknownAnswerBlock(
      policy({ unknownAnswerMode: "handoff", unknownAnswerMessage: promise }),
      { transferBlocked: true },
    );

    expect(block).not.toContain(promise);
    expect(block).toContain("NÃO transfira");
    expect(block).toContain(
      "Ao admitir que não sabe, seja direto e mantenha o tom configurado.",
    );
  });

  it("modo acknowledge configurado na mão tem o mesmo tratamento", () => {
    const block = buildUnknownAnswerBlock(
      policy({
        unknownAnswerMode: "acknowledge",
        unknownAnswerMessage: "Já estou te encaminhando para a equipe.",
      }),
    );
    expect(block).not.toContain("encaminhando para a equipe");
  });

  it("frase sem promessa de transferência é mantida mesmo com o gate fechado", () => {
    const ok = "Essa eu não sei de cabeça, vou confirmar com a equipe.";
    const block = buildUnknownAnswerBlock(
      policy({ unknownAnswerMode: "handoff", unknownAnswerMessage: ok }),
      { transferBlocked: true },
    );
    expect(block).toContain(`"${ok}"`);
  });

  it("com o gate aberto, a frase do operador continua valendo", () => {
    const block = buildUnknownAnswerBlock(
      policy({ unknownAnswerMode: "handoff", unknownAnswerMessage: promise }),
    );
    expect(block).toContain(promise);
    expect(block).not.toContain("NÃO transfira");
  });
});

describe("messagePromisesTransfer", () => {
  it("reconhece as formas de prometer transferência", () => {
    for (const m of [
      "Vou te transferir para um consultor agora",
      "Já encaminhei seu caso",
      "vou te passar para o setor responsável",
      "Vou te conectar com alguém do time",
      "Te direciono para quem cuida disso",
    ]) {
      expect(messagePromisesTransfer(m), m).toBe(true);
    }
  });

  it("admitir e seguir não é promessa de transferência", () => {
    for (const m of [
      "Não sei te dizer isso agora",
      "Vou verificar com a equipe e te retorno",
      "Essa informação eu não tenho aqui",
      null,
      "",
    ]) {
      expect(messagePromisesTransfer(m), String(m)).toBe(false);
    }
  });
});
