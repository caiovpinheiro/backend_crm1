import { describe, expect, it } from "vitest";

import { pickPeerByRoutingScope } from "@/lib/ai-agents/coordinator-route";

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
