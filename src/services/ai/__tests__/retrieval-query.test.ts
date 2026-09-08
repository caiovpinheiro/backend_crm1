import { describe, expect, it } from "vitest";

import {
  buildRetrievalQuery,
  isDeicticMessage,
  needsHistoryContext,
  RETRIEVAL_SESSION_GAP_MS,
  trimToRecentSession,
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

describe("placeholder de mídia não contamina a query", () => {
  it("sintoma original: '[Imagem]' arrastou perguntas de 40 minutos antes", () => {
    // "[Imagem]" tem menos de 25 caracteres: era tratado como mensagem
    // curta e autorizava puxar histórico. O agente respondeu sobre troca de
    // polo e provas para quem estava tratando de cancelamento.
    expect(needsHistoryContext("[Imagem]")).toBe(false);

    const q = buildRetrievalQuery({
      userMessage: "[Imagem]",
      priorUserMessages: [
        "como faço para trocar de polo",
        "e a prova presencial tem que ir onde",
      ],
    });
    expect(q).toBe("");
    expect(q).not.toContain("polo");
    expect(q).not.toContain("prova");
  });

  it("mensagem vazia também é ausência de conteúdo", () => {
    expect(needsHistoryContext("   ")).toBe(false);
    expect(
      buildRetrievalQuery({
        userMessage: "   ",
        priorUserMessages: ["quero trancar a matrícula"],
      }),
    ).toBe("");
  });

  it("lote misto mantém só o que o cliente escreveu", () => {
    const q = buildRetrievalQuery({
      userMessage: "[Imagem]\nquero cancelar minha matrícula",
      priorUserMessages: ["[Documento]", "bom dia"],
    });
    expect(q).toBe("bom dia\nquero cancelar minha matrícula");
    expect(q).not.toContain("[Documento]");
    expect(q).not.toContain("[Imagem]");
  });

  it("placeholder no histórico não entra na query", () => {
    const q = buildRetrievalQuery({
      userMessage: "e o prazo?",
      priorUserMessages: ["[Áudio]", "quero trancar a matrícula"],
    });
    expect(q).toBe("quero trancar a matrícula\ne o prazo?");
  });
});

describe("assunto morto não pesa na busca", () => {
  // Conversa real de 08/09: o aluno perguntou o e-mail acadêmico às 17h30,
  // sumiu, e voltou às 19h57 falando de prova. O calendário oficial, que
  // tinha as datas, caiu para 5º lugar e ficou fora do topK=4.
  const at = (iso: string) => new Date(iso);

  it("silêncio longo corta o histórico anterior", () => {
    const history = [
      { role: "user" as const, content: "qual é meu email academico?", at: at("2026-09-08T17:30:12Z") },
      { role: "user" as const, content: "qual é meu email academico?", at: at("2026-09-08T17:30:43Z") },
      { role: "user" as const, content: "Oi", at: at("2026-09-08T19:57:30Z") },
      { role: "user" as const, content: "Sobre as provas?", at: at("2026-09-08T19:57:46Z") },
      { role: "user" as const, content: "Nao tem as datas?", at: at("2026-09-08T19:59:11Z") },
    ];

    const session = trimToRecentSession(history);
    expect(session.map((m) => m.content)).toEqual([
      "Oi",
      "Sobre as provas?",
      "Nao tem as datas?",
    ]);

    const q = buildRetrievalQuery({
      userMessage: "Nao tem as datas?",
      priorUserMessages: session.map((m) => m.content),
    });
    expect(q).toBe("Sobre as provas?\nNao tem as datas?");
    expect(q).not.toContain("email academico");
  });

  it("conversa contígua não é cortada", () => {
    const history = [
      { role: "user" as const, content: "primeira", at: at("2026-09-08T19:00:00Z") },
      { role: "user" as const, content: "segunda", at: at("2026-09-08T19:20:00Z") },
      { role: "user" as const, content: "terceira", at: at("2026-09-08T19:40:00Z") },
    ];
    expect(trimToRecentSession(history)).toHaveLength(3);
  });

  it("corta no silêncio mais recente, não no primeiro", () => {
    const history = [
      { role: "user" as const, content: "assunto antigo", at: at("2026-09-08T10:00:00Z") },
      { role: "user" as const, content: "assunto do meio", at: at("2026-09-08T14:00:00Z") },
      { role: "user" as const, content: "assunto de agora", at: at("2026-09-08T19:00:00Z") },
    ];
    expect(trimToRecentSession(history).map((m) => m.content)).toEqual([
      "assunto de agora",
    ]);
  });

  it("histórico sem timestamp (playground) não é cortado", () => {
    const history = [
      { role: "user" as const, content: "uma" },
      { role: "user" as const, content: "outra" },
    ];
    expect(trimToRecentSession(history)).toHaveLength(2);
  });

  it("o gap é de 30 minutos", () => {
    expect(RETRIEVAL_SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });
});

describe("repetição não vale duas vezes", () => {
  it("a mensagem atual não entra duas vezes na query", () => {
    // No inbox o histórico vem do banco e JÁ contém a mensagem atual: ela
    // era concatenada de novo no fim e saía com peso dobrado.
    const q = buildRetrievalQuery({
      userMessage: "Nao tem as datas?",
      priorUserMessages: ["Sobre as provas?", "Nao tem as datas?"],
    });
    expect(q).toBe("Sobre as provas?\nNao tem as datas?");
  });

  it("pergunta repetida no histórico entra uma vez só", () => {
    const q = buildRetrievalQuery({
      userMessage: "e agora?",
      priorUserMessages: [
        "qual é meu email academico?",
        "qual é meu email academico?",
        "Sobre as provas?",
      ],
    });
    expect(q).toBe(
      "qual é meu email academico?\nSobre as provas?\ne agora?",
    );
  });

  it("repetida não ocupa vaga do histórico", () => {
    // depth 2 (mensagem com assunto próprio): as duas vagas precisam ir para
    // assuntos distintos, não para a mesma pergunta duplicada.
    const q = buildRetrievalQuery({
      userMessage: "como faço a matrícula no curso de pedagogia a distância?",
      priorUserMessages: ["quero o boleto", "quero o boleto", "e a mensalidade"],
    });
    expect(q.split("\n").slice(0, 2)).toEqual([
      "quero o boleto",
      "e a mensalidade",
    ]);
  });
});
