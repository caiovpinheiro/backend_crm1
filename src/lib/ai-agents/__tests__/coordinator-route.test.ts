import { describe, expect, it } from "vitest";

import {
  isReplyToAgentQuestion,
  pickPeerByRoutingScope,
} from "@/lib/ai-agents/coordinator-route";

describe("P1-A roteamento por routingScope", () => {
  const peers = [
    {
      id: "1",
      name: "Agente X",
      archetype: "ATENDIMENTO",
      routingScope: "primeiro acesso, portal, senha, onboarding",
    },
    {
      id: "2",
      name: "Agente Y",
      archetype: "ATENDIMENTO",
      routingScope: "cancelar, trancar, desistir, churn",
    },
    {
      id: "3",
      name: "Agente Z",
      archetype: "ATENDIMENTO",
      routingScope: "horario, contrato, financeiro, suporte",
    },
  ];

  it("escolhe pelo escopo, não pelo nome", () => {
    const dest = pickPeerByRoutingScope("quero cancelar o curso", peers);
    expect(dest?.id).toBe("2");
  });

  it("renomear o agente não muda o destino", () => {
    const renamed = peers.map((p) =>
      p.id === "2" ? { ...p, name: "Desk 7" } : p,
    );
    const dest = pickPeerByRoutingScope("quero trancar", renamed);
    expect(dest?.name).toBe("Desk 7");
    expect(dest?.id).toBe("2");
  });
});

describe("resposta a pergunta do agente não é assunto novo", () => {
  it("reconhece resposta curta a uma pergunta", () => {
    expect(
      isReplyToAgentQuestion("Financeiro", "Qual o motivo do cancelamento?"),
    ).toBe(true);
    expect(isReplyToAgentQuestion("Sim", "Posso seguir?")).toBe(true);
  });

  it("mensagem longa traz assunto próprio mesmo depois de pergunta", () => {
    expect(
      isReplyToAgentQuestion(
        "na verdade mudei de ideia e quero falar sobre o meu boleto atrasado",
        "Qual o motivo do cancelamento?",
      ),
    ).toBe(false);
  });

  it("sem pergunta anterior, nada é suprimido", () => {
    expect(
      isReplyToAgentQuestion("Financeiro", "Certo, vou verificar."),
    ).toBe(false);
    expect(isReplyToAgentQuestion("Financeiro", null)).toBe(false);
  });

  it("mensagem vazia não conta como resposta", () => {
    expect(isReplyToAgentQuestion("   ", "Qual o motivo?")).toBe(false);
  });
});
