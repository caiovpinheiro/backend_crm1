import { describe, expect, it } from "vitest";

import { adaptedKeepsContent } from "@/services/ai-v2/message-adapt";
import { procedureAdmittedMissing, repeatFallback } from "@/services/ai-v2/ground-reply";
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

  it("informação sem pedido recebe o fecho", () => {
    const reply = "O prazo é de 5 dias úteis.";
    expect(asksClient(reply)).toBe(false);
    expect(applyReplyEnding({ reply, ending }).added).toBe("Posso ajudar em algo mais?");
  });
});
