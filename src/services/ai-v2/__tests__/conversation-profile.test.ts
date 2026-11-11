import { describe, expect, it } from "vitest";

import {
  askedQuestions,
  askedQuestionsSection,
  bubblesPromptLine,
  conversationProfileOf,
  memoryFieldsOf,
  memoryPromptSection,
  profileAllowsOpinion,
  profilePromptSection,
  splitReplyBubbles,
} from "../conversation-profile";

describe("perfil de conversa", () => {
  it("sem perfil ou com valor desconhecido fica em suporte, sem bloco novo no prompt", () => {
    expect(conversationProfileOf({})).toBe("support");
    expect(conversationProfileOf({ conversationProfile: "x" as never })).toBe("support");
    expect(profilePromptSection({})).toBe("");
    expect(profileAllowsOpinion({})).toBe(false);
  });

  it("venda e pós-venda podem comentar a escolha; cobrança não", () => {
    expect(profileAllowsOpinion({ conversationProfile: "sales" })).toBe(true);
    expect(profileAllowsOpinion({ conversationProfile: "aftercare" })).toBe(true);
    expect(profileAllowsOpinion({ conversationProfile: "collections" })).toBe(false);
    expect(profilePromptSection({ conversationProfile: "sales" })).toContain("venda consultiva");
    expect(profilePromptSection({ conversationProfile: "collections" })).toContain("Nunca ameace");
  });
});

describe("memória da pessoa", () => {
  it("venda usa a lista padrão; configuração própria vale sobre ela; suporte não tem", () => {
    expect(memoryFieldsOf({ conversationProfile: "sales" }).map((f) => f.key)).toEqual(["motivo", "momento", "objecao", "preferencia"]);
    expect(memoryFieldsOf({ conversationProfile: "sales", personMemory: [{ key: "pedido", label: "Número do pedido" }] }).map((f) => f.key)).toEqual(["pedido"]);
    expect(memoryFieldsOf({})).toEqual([]);
    expect(memoryPromptSection({}, { motivo: "x" })).toBe("");
  });

  it("mostra o que já sabe e o que falta", () => {
    const section = memoryPromptSection({ conversationProfile: "sales" }, { momento: "ano que vem" });
    expect(section).toContain('chave "momento"): ano que vem');
    expect(section).toContain('chave "motivo"): ainda não sabe');
    expect(section).toContain("não pergunte de novo");
  });
});

describe("perguntas já feitas", () => {
  const history = [
    { role: "assistant" as const, content: "Te mandei aqui embaixo. O que achou?" },
    { role: "user" as const, content: "achei caro?" },
    { role: "assistant" as const, content: "Entendo. O que pesa mais pra você agora: valor, tempo ou alguma dúvida?" },
  ];

  it("só as do agente, sem repetir", () => {
    expect(askedQuestions(history)).toEqual(["O que achou?", "O que pesa mais pra você agora: valor, tempo ou alguma dúvida?"]);
  });

  it("vai ao prompt fora do perfil suporte", () => {
    expect(askedQuestionsSection({}, history)).toBe("");
    expect(askedQuestionsSection({ conversationProfile: "sales" }, history)).toContain("Não repita nenhuma delas");
  });
});

describe("balões", () => {
  it("só instrui no modo split", () => {
    expect(bubblesPromptLine({})).toBe("");
    expect(bubblesPromptLine({ replyBubbles: "split" })).toContain("até 3 mensagens curtas");
  });

  it("divide por linha em branco, até 3, e junta o excedente no último", () => {
    expect(splitReplyBubbles("Oi!\n\nTe mandei aqui embaixo.\n\nGostou?")).toEqual(["Oi!", "Te mandei aqui embaixo.", "Gostou?"]);
    expect(splitReplyBubbles("A\n\nB\n\nC\n\nD")).toEqual(["A", "B", "C\n\nD"]);
    expect(splitReplyBubbles("Uma mensagem só.")).toEqual(["Uma mensagem só."]);
  });

  it("lista e passo a passo não se dividem", () => {
    const steps = "Faz assim:\n\n1. Abra o app\n2. Toque em Entrar";
    expect(splitReplyBubbles(steps)).toEqual([steps]);
  });
});
