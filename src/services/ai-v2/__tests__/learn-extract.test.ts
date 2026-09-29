import { describe, expect, it } from "vitest";

import { buildTranscript, isSuccess, parseAnalysis, parseDocs, searchTerms, speaker } from "@/services/ai-v2/learn-extract";

const at = new Date("2026-09-01T12:00:00Z");

describe("searchTerms", () => {
  it("assunto + sinônimos, com versão sem acento, sem curtos nem curingas", () => {
    const t = searchTerms("Configuração inicial", ["senha", "ok", "100%_certo"]);
    expect(t).toContain("configuração inicial");
    expect(t).toContain("configuracao inicial");
    expect(t).toContain("senha");
    expect(t).not.toContain("ok");
    expect(t.some((x) => x.includes("%") || x.includes("_"))).toBe(false);
  });
});

describe("buildTranscript", () => {
  const msgs = [
    { direction: "in", authorType: "human", content: "oi", createdAt: at },
    { direction: "out", authorType: "bot", content: "Olá! Em que posso ajudar?", createdAt: at, isAi: true },
    { direction: "in", authorType: "human", content: "Sou a Joana Prado, não consigo fazer a configuração inicial. Meu fone 11 98888-7777", createdAt: at },
    { direction: "out", authorType: "human", content: "Abra o menu Ajustes e toque em Começar.", createdAt: at },
    { direction: "in", authorType: "human", content: "Consegui, deu certo!", createdAt: at },
  ];

  it("recorta a partir do assunto, marca quem falou e mascara nome e telefone", () => {
    const tr = buildTranscript(msgs, ["configuração inicial"], ["Joana Prado"]);
    expect(tr.hitIndex).toBe(2);
    expect(tr.text).toContain("Agente IA: Olá!");
    expect(tr.text).toContain("Equipe: Abra o menu Ajustes");
    expect(tr.text).not.toContain("Joana");
    expect(tr.text).not.toContain("98888");
    expect(tr.clientText).toContain("Consegui, deu certo!");
  });

  it("identifica automação (bot sem agente IA)", () => {
    expect(speaker({ direction: "out", authorType: "bot", content: "x", createdAt: at })).toBe("Automação");
  });
});

describe("parseAnalysis / isSuccess", () => {
  const client = "não consigo entrar\nConsegui, deu certo!";

  it("resolvido só com trecho do cliente que existe", () => {
    const a = parseAnalysis({ onTopic: true, outcome: "resolved", clientConfirmation: "Consegui, deu certo!", steps: ["Abra o menu"] }, client)!;
    expect(a.outcome).toBe("resolved");
    expect(isSuccess(a, false)).toBe(true);

    const invented = parseAnalysis({ onTopic: true, outcome: "resolved", clientConfirmation: "Funcionou perfeitamente", steps: ["Abra o menu"] }, client)!;
    expect(invented.outcome).toBe("unclear");
    expect(invented.clientConfirmation).toBeNull();
    expect(isSuccess(invented, false)).toBe(false);
  });

  it("com filtro de tabulação, 'não ficou claro' conta; 'não resolveu' e fora do assunto nunca", () => {
    const unclear = parseAnalysis({ onTopic: true, outcome: "unclear", steps: ["Passo"] }, client)!;
    expect(isSuccess(unclear, true)).toBe(true);
    expect(isSuccess(parseAnalysis({ onTopic: true, outcome: "unresolved", steps: ["Passo"] }, client)!, true)).toBe(false);
    expect(isSuccess(parseAnalysis({ onTopic: false, outcome: "resolved", clientConfirmation: "Consegui", steps: ["Passo"] }, client)!, true)).toBe(false);
    expect(isSuccess(parseAnalysis({ onTopic: true, outcome: "resolved", clientConfirmation: "Consegui", steps: [] }, client)!, false)).toBe(false);
  });

  it("JSON inválido → null", () => {
    expect(parseAnalysis(null, client)).toBeNull();
    expect(parseAnalysis("texto", client)).toBeNull();
  });
});

describe("parseDocs", () => {
  it("filtra vazios, limita a 3 e só aceita referências válidas", () => {
    const long = "Quando usar: quando o cliente pede ajuda.\nPasso a passo:\n1. Abra o menu.";
    const docs = parseDocs(
      {
        docs: [
          { title: "Caminho A", content: long, basedOn: [1, 2, 2, 9, "x"] },
          { title: "", content: long },
          { title: "Curto", content: "x" },
          { title: "B", content: long, basedOn: [] },
          { title: "C", content: long },
          { title: "D", content: long },
        ],
      },
      3,
    );
    expect(docs.map((d) => d.title)).toEqual(["Caminho A", "B", "C"]);
    expect(docs[0].basedOn).toEqual([1, 2]);
    expect(parseDocs({}, 2)).toEqual([]);
  });
});
