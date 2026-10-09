import { describe, expect, it } from "vitest";

import { adaptedKeepsContent } from "@/services/ai-v2/message-adapt";
import { admittedMissingInstructions, procedureAdmittedMissing, repeatFallback } from "@/services/ai-v2/ground-reply";
import { applyReplyEnding, asksClient } from "@/services/ai-v2/reply-ending";

describe("repeatFallback", () => {
  it("depois de cumprimento não pergunta se ficou dúvida; depois de explicação, pergunta", () => {
    expect(repeatFallback("Oi! Tudo bem por aqui. Como posso ajudar você hoje?")).not.toContain("dúvida");
    expect(repeatFallback(null)).not.toContain("dúvida");
    const explanation = "Para acessar, abra o aplicativo, toque em Entrar, informe seu usuário e a senha cadastrada, confirme o código recebido por mensagem e aguarde a tela inicial carregar.";
    expect(repeatFallback(explanation)).toContain("Ficou alguma dúvida");
  });
});

describe("adaptedKeepsContent", () => {
  const original = "Olá! O prazo é de 5 dias úteis. Acesse https://exemplo.com/guia para ver o passo a passo.";

  it("aceita troca de tratamento e ordem mantendo links e números", () => {
    expect(adaptedKeepsContent(original, "Oi, tudo bem? Para ver o passo a passo, acesse https://exemplo.com/guia. O prazo é de 5 dias úteis.").ok).toBe(true);
  });

  it("recusa link perdido, link novo, número mudado e texto vazio", () => {
    expect(adaptedKeepsContent(original, "O prazo é de 5 dias úteis.").ok).toBe(false);
    expect(adaptedKeepsContent(original, "Prazo de 5 dias úteis: https://exemplo.com/guia e https://outro.com").ok).toBe(false);
    expect(adaptedKeepsContent(original, "O prazo é de 7 dias úteis. https://exemplo.com/guia").ok).toBe(false);
    expect(adaptedKeepsContent(original, "  ").ok).toBe(false);
  });

  it("recusa versão muito maior que a original", () => {
    expect(adaptedKeepsContent("Curta 1.", `Curta 1. ${"texto ".repeat(80)}`).ok).toBe(false);
  });
});

describe("procedureAdmittedMissing", () => {
  it("instrução numa resposta cuja decisão admite que a base não traz o procedimento", () => {
    expect(
      procedureAdmittedMissing(
        "Para anexar, selecione a categoria e o serviço e inclua os arquivos no formulário.",
        "A base não informa um procedimento geral de anexação.",
      ),
    ).toBe(true);
  });

  it("sem admissão, ou sem instrução, não marca", () => {
    expect(procedureAdmittedMissing("Selecione a opção Documentos e anexe o arquivo.", "O trecho descreve o envio.")).toBe(false);
    expect(procedureAdmittedMissing("Qual solicitação você está fazendo?", "A base não informa um procedimento geral.")).toBe(false);
    expect(procedureAdmittedMissing("Selecione a opção.", undefined)).toBe(false);
  });

  it("admissão em outras palavras: 'não está especificada', 'não há informação', 'o material não trata', 'sem orientação'", () => {
    const reply = "Para verificar se há opção de parcelamento, acesse o portal e confira em Financeiro.";
    expect(procedureAdmittedMissing(reply, "A possibilidade de parcelamento não está especificada e depende de análise do setor Financeiro.")).toBe(true);
    expect(procedureAdmittedMissing(reply, "Não há informação sobre parcelamento nos materiais.")).toBe(true);
    expect(procedureAdmittedMissing(reply, "O material não trata de parcelamento; encaminhei ao setor.")).toBe(true);
    expect(procedureAdmittedMissing(reply, "Sem orientação sobre parcelamento na base.")).toBe(true);
  });

  it("fato da situação do cliente ou do material não é admissão ('não consta no cadastro', 'não foi encontrado no portal', 'não está previsto')", () => {
    expect(procedureAdmittedMissing("Acesse o portal e atualize o cadastro.", "O e-mail não consta no cadastro do cliente.")).toBe(false);
    expect(procedureAdmittedMissing("Acesse o portal e gere a segunda via.", "O documento não foi encontrado no portal pelo cliente.")).toBe(false);
    expect(procedureAdmittedMissing("Acesse o portal e gere a segunda via.", "O reajuste não está previsto no contrato.")).toBe(false);
  });
});

describe("admittedMissingInstructions", () => {
  it("tira só a instrução sobre o assunto admitido; o reconhecimento fica", () => {
    const reply =
      "Boa tarde! Entendo que você queira regularizar a fatura. Para verificar se há opção de negociação ou parcelamento disponível, acesse o Portal do Cliente, na aba Financeiro, e confira as opções. O setor Financeiro precisa confirmar.";
    expect(admittedMissingInstructions(reply, "A possibilidade de parcelamento não está especificada e depende de análise do setor Financeiro.")).toEqual([
      "Para verificar se há opção de negociação ou parcelamento disponível, acesse o Portal do Cliente, na aba Financeiro, e confira as opções.",
    ]);
  });

  it("instrução sobre outro assunto fica: o material pode cobrir esse", () => {
    const reply = "Abra a solicitação em Portal > Solicitações e anexe o comprovante. O prazo de análise não está informado no material.";
    expect(admittedMissingInstructions(reply, "O material não especifica o prazo de análise, mas orienta a abrir a solicitação pelo portal.")).toEqual([]);
  });

  it("admissão sem assunto ('não há informação sobre isso'): toda instrução sai", () => {
    expect(admittedMissingInstructions("Acesse o portal e selecione a opção desejada. Depois me avise.", "Não há informação sobre isso nos materiais.")).toEqual([
      "Acesse o portal e selecione a opção desejada.",
    ]);
  });
});

describe("fecho x pedido ao cliente", () => {
  const ending = { procedure: { enabled: false, phrases: [] }, info: { enabled: true, phrases: ["Posso ajudar em algo mais?"] } };

  it("resposta que pede informação ao cliente não recebe fecho", () => {
    const reply = "Para indicar o caminho certo, preciso saber qual solicitação você está fazendo.";
    expect(asksClient(reply)).toBe(true);
    expect(applyReplyEnding({ reply, ending }).added).toBeNull();
    expect(asksClient("Qual o serviço? Assim te passo o caminho.")).toBe(true);
    expect(asksClient("Me diga o número do pedido.")).toBe(true);
  });

  it("pedido direto de um dado, sem pergunta, também não recebe fecho; passo de lista sim", () => {
    const reply = "Para eu orientar sobre o prazo e a troca, informe o *número do pedido*, por favor.";
    expect(asksClient(reply)).toBe(true);
    expect(applyReplyEnding({ reply, ending }).added).toBeNull();
    expect(asksClient("Preciso do número do pedido antes de explicar as condições.")).toBe(true);
    expect(asksClient("Para trocar:\n1. Abra Pedidos.\n2. Informe o motivo e confirme o endereço.")).toBe(false);
  });

  it("informação sem pedido recebe o fecho", () => {
    const reply = "O prazo é de 5 dias úteis.";
    expect(asksClient(reply)).toBe(false);
    expect(applyReplyEnding({ reply, ending }).added).toBe("Posso ajudar em algo mais?");
  });
});
