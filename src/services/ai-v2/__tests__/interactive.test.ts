import { describe, expect, it } from "vitest";

import { buildV2Interactive, matchPendingOption, optionsFromAgentMessage } from "@/services/ai-v2/interactive";
import { parseV2Counters } from "@/services/ai-v2/limits";
import { replyEndingButtons } from "@/services/ai-v2/reply-ending";

describe("buildV2Interactive", () => {
  it("até 3 opções curtas viram botões; o texto de reserva leva as opções numeradas", () => {
    const r = buildV2Interactive("Sobre qual assunto?", ["Assunto A", "Assunto B"]);
    expect(r.payload?.kind).toBe("buttons");
    expect(r.payload?.body).toBe("Sobre qual assunto?");
    expect(r.payload?.options.map((o) => o.title)).toEqual(["Assunto A", "Assunto B"]);
    expect(r.payload?.displayContent).toBe("Sobre qual assunto?\n[Botões: Assunto A, Assunto B]");
    expect(r.fallbackText).toBe("Sobre qual assunto?\n\n1. Assunto A\n2. Assunto B");
  });

  it("rótulo longo ou mais de 3 opções viram lista, com o rótulo inteiro na descrição", () => {
    const long = "Uma opção com rótulo bem mais comprido";
    const r = buildV2Interactive("Escolha:", ["Curta", long]);
    expect(r.payload?.kind).toBe("list");
    const row = r.payload!.options[1];
    expect(row.title.length).toBeLessThanOrEqual(24);
    expect(row.description).toBe(long);
    expect(buildV2Interactive("x", ["a", "b", "c", "d"]).payload?.kind).toBe("list");
  });

  it("remove repetidas e limita a 10", () => {
    const r = buildV2Interactive("x", ["Sim", "sim", ...Array.from({ length: 12 }, (_, i) => `Opção ${i}`)]);
    expect(r.labels[0]).toBe("Sim");
    expect(r.labels).toHaveLength(10);
  });

  it("resposta maior que o corpo interativo vai antes, e o corpo fica curto", () => {
    const body = "a".repeat(1100);
    const r = buildV2Interactive(body, ["Sim", "Não"]);
    expect(r.payload?.leadText).toBe(body);
    expect(r.payload!.body.length).toBeLessThan(100);
  });

  it("sem opções válidas não há mensagem interativa", () => {
    const r = buildV2Interactive("Oi", ["", "  "]);
    expect(r.payload).toBeNull();
    expect(r.fallbackText).toBe("Oi");
  });
});

describe("matchPendingOption", () => {
  const labels = ["Sim", "Não", "Uma opção com rótulo bem mais comprido"];

  it("clique (rótulo), rótulo digitado sem acento e número", () => {
    expect(matchPendingOption(labels, "Sim")).toBe("Sim");
    expect(matchPendingOption(labels, "nao")).toBe("Não");
    expect(matchPendingOption(labels, "2")).toBe("Não");
    expect(matchPendingOption(labels, "opção 1")).toBe("Sim");
  });

  it("resposta de lista chega como título + descrição", () => {
    expect(matchPendingOption(labels, "Uma opção com rótulo be…\nUma opção com rótulo bem mais comprido")).toBe(labels[2]);
  });

  it("texto livre e número fora da faixa não casam", () => {
    expect(matchPendingOption(labels, "sim, mas antes tenho outra dúvida")).toBeNull();
    expect(matchPendingOption(labels, "7")).toBeNull();
    expect(matchPendingOption([], "1")).toBeNull();
  });
});

describe("optionsFromAgentMessage", () => {
  it("lê só a marca de botões/lista do fim", () => {
    expect(optionsFromAgentMessage("Funcionou?\n[Botões: Sim, Não]")).toEqual(["Sim", "Não"]);
    expect(optionsFromAgentMessage("Qual?\n[Lista: A, B, C]")).toEqual(["A", "B", "C"]);
    expect(optionsFromAgentMessage("Qual?\n\n1. A\n2. B\n3. C")).toEqual([]);
    expect(optionsFromAgentMessage("Passos:\n1. Abra\n2. Entre\n\nMe avise se funcionou.")).toEqual([]);
    expect(optionsFromAgentMessage(null)).toEqual([]);
  });
});

describe("opções pendentes e botões do fecho", () => {
  it("counters guardam as opções pendentes", () => {
    expect(parseV2Counters({ pendingOptions: ["Sim", "Não", 3] }).pendingOptions).toEqual(["Sim", "Não"]);
    expect(parseV2Counters({}).pendingOptions).toBeUndefined();
  });

  it("botões do fecho: até 3, rótulo até 20", () => {
    const ending = {
      procedure: { enabled: true, phrases: ["Funcionou?"], buttons: ["Sim", " ", "Não", "Ainda com dúvida sobre isso", "x"] },
      info: { enabled: false, phrases: [] },
    };
    expect(replyEndingButtons(ending, "procedure")).toEqual(["Sim", "Não", "Ainda com dúvida sob"]);
    expect(replyEndingButtons(ending, "info")).toEqual([]);
    expect(replyEndingButtons(undefined, "procedure")).toEqual([]);
  });
});
