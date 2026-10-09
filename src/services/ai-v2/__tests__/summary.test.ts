import { describe, expect, it } from "vitest";

import { fallbackSummaryItems, outcomeLabel, renderSummary, summaryOneLine, summaryPrompt } from "../summary";

const items = {
  motivo: "Não conseguia entrar no aplicativo.",
  feito: "Enviada a orientação de acesso com e-mail e senha.",
  pendencia: "Nenhuma",
  resultado: "Encerrado: resolvido",
  proximo: "Se voltar sem conseguir entrar, verificar o cadastro.",
  dados: ["e-mail: informado", "pedido: 123"],
  marcos: ["10:02 — pediu ajuda", "10:05 — orientação enviada"],
};

describe("resumo do atendimento — texto", () => {
  it("mínimo: uma linha, sem pendência quando não há", () => {
    expect(renderSummary(items, "minimal")).toBe("Não conseguia entrar no aplicativo. → Encerrado: resolvido");
    expect(renderSummary({ ...items, pendencia: "Aguardando o comprovante" }, "minimal")).toBe(
      "Não conseguia entrar no aplicativo. → Encerrado: resolvido · Aguardando o comprovante",
    );
  });

  it("padrão: os cinco itens, um por linha, sem dados nem marcos", () => {
    const text = renderSummary(items, "standard");
    expect(text.split("\n")).toEqual([
      "Motivo: Não conseguia entrar no aplicativo.",
      "O que foi feito: Enviada a orientação de acesso com e-mail e senha.",
      "Pendência: Nenhuma",
      "Resultado: Encerrado: resolvido",
      "Próximo passo: Se voltar sem conseguir entrar, verificar o cadastro.",
    ]);
  });

  it("detalhado: acrescenta dados e mensagens-chave", () => {
    const text = renderSummary(items, "detailed");
    expect(text).toContain("Dados coletados: e-mail: informado; pedido: 123");
    expect(text).toContain("Mensagens-chave: 10:02 — pediu ajuda; 10:05 — orientação enviada");
  });

  it("linha do cartão fechado vem do texto gravado", () => {
    expect(summaryOneLine(renderSummary(items, "standard"))).toBe("Não conseguia entrar no aplicativo. → Encerrado: resolvido");
    expect(summaryOneLine(renderSummary({ ...items, pendencia: "Confirmar o pagamento" }, "standard"))).toBe(
      "Não conseguia entrar no aplicativo. → Encerrado: resolvido · Confirmar o pagamento",
    );
    // Texto no nível mínimo já é a linha.
    expect(summaryOneLine("Pedido atrasado → Transferido para a equipe")).toBe("Pedido atrasado → Transferido para a equipe");
  });
});

describe("resumo do atendimento — resultado e reserva", () => {
  it("resultado vem do sistema, não do modelo", () => {
    expect(outcomeLabel("close", "resolved")).toBe("Encerrado: resolvido");
    expect(outcomeLabel("close", "inactivity")).toBe("Encerrado por inatividade");
    expect(outcomeLabel("transfer", "ai_agent")).toBe("Transferido para outro agente de IA");
    expect(outcomeLabel("transfer", "department")).toBe("Transferido para a equipe");
    expect(outcomeLabel("turn", "")).toBe("Em andamento");
  });

  it("sem modelo: resumo pelo histórico, com pendência quando o cliente falou por último", () => {
    const at = new Date("2026-01-01T12:00:00Z");
    const fb = fallbackSummaryItems(
      [
        { role: "cliente", at, text: "Meu pedido não chegou" },
        { role: "agente", at, text: "Vou verificar o rastreio para você." },
        { role: "cliente", at, text: "E então?" },
      ],
      "Transferido para a equipe",
      "transfer",
    );
    expect(fb.motivo).toBe("Meu pedido não chegou");
    expect(fb.feito).toBe("Vou verificar o rastreio para você.");
    expect(fb.pendencia).toBe("Cliente escreveu por último, sem resposta");
    expect(fb.resultado).toBe("Transferido para a equipe");
    expect(fb.proximo).toBe("Continuar de onde parou");
  });

  it("prompt pede JSON, proíbe inventar e carrega o resultado", () => {
    const p = summaryPrompt("detailed", "Encerrado: resolvido");
    expect(p).toContain("Resultado deste atendimento: Encerrado: resolvido");
    expect(p).toContain("Não invente fatos");
    expect(p).toContain("\"marcos\"");
    expect(summaryPrompt("minimal", "x")).toContain("no máximo 12 palavras");
  });
});
