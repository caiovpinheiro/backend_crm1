import { describe, expect, it } from "vitest";

import {
  buildRetrievalQuery,
  isDeicticMessage,
  needsHistoryContext,
} from "@/services/ai/retrieval-query";

describe("isDeicticMessage", () => {
  it("reconhece as continuações que apareceram na conversa real", () => {
    for (const m of ["ok", "Não fez ainda?", "já disse", "sim", "?", "quero"]) {
      expect(isDeicticMessage(m), m).toBe(true);
    }
  });

  it("não marca mensagem com assunto próprio", () => {
    for (const m of [
      "como recupero minha senha do portal?",
      "qual o valor da mensalidade de pedagogia",
    ]) {
      expect(isDeicticMessage(m), m).toBe(false);
    }
  });
});

describe("buildRetrievalQuery", () => {
  it("sintoma original: 'Não fez ainda?' sozinho não recupera nada", () => {
    const isolated = buildRetrievalQuery({ userMessage: "Não fez ainda?" });
    expect(isolated).toBe("Não fez ainda?");

    // Com histórico, o assunto entra na query.
    const withHistory = buildRetrievalQuery({
      userMessage: "Não fez ainda?",
      priorUserMessages: [
        "boa tarde",
        "preciso da segunda via do boleto de setembro",
      ],
    });
    expect(withHistory).toContain("segunda via do boleto");
    expect(withHistory).toContain("Não fez ainda?");
  });

  it("mensagem curta puxa mais histórico do que mensagem com assunto", () => {
    const history = [
      "quero saber sobre o curso de pedagogia",
      "e o valor da mensalidade",
      "tem desconto para ex-aluno",
      "qual a duração",
    ];
    const shortMsg = buildRetrievalQuery({
      userMessage: "ok",
      priorUserMessages: history,
    });
    const longMsg = buildRetrievalQuery({
      userMessage: "como faço a matrícula no curso de pedagogia a distância?",
      priorUserMessages: history,
    });
    expect(shortMsg.split("\n").length).toBeGreaterThan(
      longMsg.split("\n").length,
    );
  });

  it("histórico vem antes da mensagem atual (ordem cronológica)", () => {
    const q = buildRetrievalQuery({
      userMessage: "e o prazo?",
      priorUserMessages: ["quero trancar a matrícula"],
    });
    expect(q.indexOf("trancar")).toBeLessThan(q.indexOf("prazo"));
  });

  it("descarta 'ok'/'sim' do histórico — não agregam assunto", () => {
    const q = buildRetrievalQuery({
      userMessage: "ok",
      priorUserMessages: ["ok", "sim", "certo", "quero o boleto"],
    });
    expect(q).toBe("quero o boleto\nok");
  });

  it("sem histórico devolve a mensagem atual, nunca vazio", () => {
    expect(buildRetrievalQuery({ userMessage: "  senha do AVA " })).toBe(
      "senha do AVA",
    );
  });

  it("needsHistoryContext cobre mensagem curta não-dêitica", () => {
    expect(needsHistoryContext("boleto?")).toBe(true);
    expect(
      needsHistoryContext("como emito a segunda via do boleto no portal"),
    ).toBe(false);
  });
});
