import { describe, expect, it } from "vitest";

import {
  askedQuestions,
  askedQuestionsSection,
  bubblesPromptLine,
  conversationProfileOf,
  memoryFieldsOf,
  memoryPromptSection,
  profileAllowsOpinion,
  isAutomatedBusinessReply,
  productCardSlot,
  promisesConfirmation,
  withoutRepeatedQuestion,
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

describe("posição do cartão de produto entre as bolhas", () => {
  it("depois da bolha que anuncia; senão antes da pergunta final; uma bolha só, no fim", () => {
    expect(productCardSlot(["Fica R$ 129,01. Te mandei o curso aqui embaixo 😊", "Ficou mais alguma dúvida?"])).toBe(1);
    expect(productCardSlot(["Boa escolha!", "Segue o cartão com os detalhes.", "Vamos garantir sua vaga?"])).toBe(2);
    expect(productCardSlot(["Boa escolha!", "A matrícula é isenta.", "O que achou? 😊"])).toBe(2);
    expect(productCardSlot(["Boa escolha!", "A matrícula é isenta."])).toBeNull();
    expect(productCardSlot(["Te mandei o curso aqui embaixo."])).toBeNull();
  });
});

describe("pergunta repetida e promessa de confirmar", () => {
  it("tira só a pergunta igual à anterior; sem sobrar conteúdo, fica como está", () => {
    const last = "Sem problema! Que horas fica bom pra você fazer a prova?";
    expect(withoutRepeatedQuestion("Combinado, amanhã então! Que horas fica bom pra você? Te mando o link nessa hora.", last))
      .toBe("Combinado, amanhã então! Te mando o link nessa hora.");
    expect(withoutRepeatedQuestion("Que horas fica bom pra você fazer a prova?", last)).toBe("Que horas fica bom pra você fazer a prova?");
    expect(withoutRepeatedQuestion("Show! Você prefere pelo celular ou computador?", last)).toBe("Show! Você prefere pelo celular ou computador?");
  });

  it("reconhece a promessa de confirmar", () => {
    expect(promisesConfirmation("Sobre trancamento, isso eu te confirmo aqui, tá?")).toBe(true);
    expect(promisesConfirmation("Isso eu te confirmo na inscrição, tá?", "Isso eu te confirmo na inscrição, tá?")).toBe(true);
    expect(promisesConfirmation("O cancelamento é sem multa.")).toBe(false);
  });
});

describe("mensagem automática de empresa", () => {
  it("reconhece resposta automática; mensagem de cliente não", () => {
    expect(isAutomatedBusinessReply("Olá! Agradecemos seu contato. Em breve retornaremos. Nosso horário de atendimento é de segunda a sexta, das 8h às 18h.")).toBe(true);
    expect(isAutomatedBusinessReply("Esta é uma mensagem automática.")).toBe(true);
    expect(isAutomatedBusinessReply("Obrigado pelo contato! Quero saber de Administração")).toBe(false);
    expect(isAutomatedBusinessReply("Agradecemos seu contato, qual o valor do curso?")).toBe(false);
  });
});

describe("promisesConfirmation: passo do processo não é promessa de retorno (rodada 2, PRE2-05)", () => {
  it("\"te confirmo na inscrição\" não pede anotação; \"te confirmo aqui\" pede", () => {
    expect(promisesConfirmation("O valor final eu te confirmo na inscrição, tá?")).toBe(false);
    expect(promisesConfirmation("Sobre trancamento, isso eu te confirmo aqui, tá?")).toBe(true);
  });
});

