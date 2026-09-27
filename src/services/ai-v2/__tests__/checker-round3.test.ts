import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/ai/provider", () => ({ generateWithTools: vi.fn() }));

import { checkClaimsWithModel, claimEchoesClient, isVagueClaim, notAFactClaim } from "../claim-check";
import { generateWithTools } from "@/services/ai/provider";

describe("checagem — rodada 3: frase vaga, eco do cliente, fonte que 'não traz'", () => {
  it("frase vaga sem dado concreto não é afirmação de fato", () => {
    expect(isVagueClaim("o retorno pode levar um pouco de tempo")).toBe(true);
    expect(isVagueClaim("O prazo de retorno pode variar conforme a solicitação")).toBe(true);
    // "Depende de X" afirma uma regra: continua conferido.
    expect(isVagueClaim("O valor da entrega depende do bairro e da modalidade escolhida")).toBe(false);
    expect(isVagueClaim("o prazo de análise depende do caso")).toBe(true);
    // Cortesia e aviso de transferência em outras formas.
    expect(notAFactClaim("Fico muito feliz em ajudar! 😊")).toBe(true);
    expect(notAFactClaim("preciso que um atendente analise a tela com você")).toBe(true);
    expect(notAFactClaim("alguém da equipe vai conferir o seu pedido")).toBe(true);
    expect(isVagueClaim("se o pedido é de seis meses, realmente fica confuso falar em cobranças depois")).toBe(true);
    expect(isVagueClaim("o prazo é de 5 dias úteis")).toBe(false);
    expect(isVagueClaim("O valor depende do plano Premium")).toBe(false);
    expect(notAFactClaim("o retorno pode levar um pouco de tempo")).toBe(true);
  });

  it("dizer que a fonte não traz a informação não é afirmação", () => {
    expect(notAFactClaim("O calendário informa as datas oficiais, mas não traz esse encontro")).toBe(true);
    expect(notAFactClaim("o material não menciona a taxa de entrega")).toBe(true);
    expect(notAFactClaim("O valor não está especificado para essa modalidade")).toBe(true);
    expect(notAFactClaim("A fatura traz o valor da taxa de entrega")).toBe(false);
  });

  it("repetir o que o cliente contou sobre a situação dele não é afirmação; confirmar a pergunta dele é", () => {
    const client = ["oi, o sistema não está aceitando arquivos acima de 60 páginas. já tentei duas vezes"];
    expect(claimEchoesClient("o sistema não está aceitando arquivos acima de 60 páginas", client)).toBe(true);
    expect(claimEchoesClient("você está no primeiro mês do plano", ["estou no primeiro mês do plano e quero cancelar"])).toBe(true);
    expect(claimEchoesClient("o sistema não está aceitando arquivos acima de 60 páginas", ["o sistema não está aceitando arquivos acima de 60 páginas, e agora?"])).toBe(true);
    expect(claimEchoesClient("a taxa é R$ 30", ["a taxa é R$ 30, né?"])).toBe(false);
    expect(claimEchoesClient("a taxa é R$ 30", ["qual é a taxa? é R$ 30?"])).toBe(false);
    expect(claimEchoesClient("o limite é de 40 páginas", ["o limite é de 40 páginas, certo?"])).toBe(false);
    expect(claimEchoesClient("o limite é de 40 páginas", ["enviei um arquivo de 60 páginas"])).toBe(false);
  });

  it("a checagem descarta eco do cliente e frase vaga; mantém o fato sem fonte", async () => {
    (generateWithTools as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: JSON.stringify({ unsupported: ["o sistema não está aceitando arquivos acima de 60 páginas", "o retorno pode levar um pouco de tempo", "a taxa de reenvio é R$ 12"] }),
      inputTokens: 10,
      outputTokens: 5,
    });
    const res = await checkClaimsWithModel({
      model: "gpt-4.1-mini",
      apiKey: "k",
      reply: "Entendi que o sistema não está aceitando arquivos acima de 60 páginas. O retorno pode levar um pouco de tempo. A taxa de reenvio é R$ 12.",
      sources: ["Reenvio de arquivo: pelo painel, em Documentos."],
      clientTexts: ["o sistema não está aceitando arquivos acima de 60 páginas, e agora?"],
    });
    expect(res.unsupported).toEqual(["a taxa de reenvio é R$ 12"]);
  });
});
