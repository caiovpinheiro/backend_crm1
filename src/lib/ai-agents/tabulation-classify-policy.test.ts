import { describe, expect, it } from "vitest";

import { ARCHETYPE_MAP } from "@/lib/ai-agents/archetypes";
import {
  conversationHasAttendanceDemand,
  conversationHasRealAttendance,
  formatTabulationCatalogText,
  inboundMessageShowsDemand,
  classifyInboundIdleIntent,
  isAckOrGreetingText,
  isGreetingOnlyText,
  isIdleClosingText,
  isShortAckText,
  shouldFireConversationTabulatedTrigger,
  type AttendanceMessage,
} from "@/lib/ai-agents/tabulation-classify-policy";

function inbound(
  over: Partial<AttendanceMessage> & { content?: string | null },
): AttendanceMessage {
  return {
    direction: "in",
    isPrivate: false,
    messageType: "text",
    ...over,
  };
}

describe("isShortAckText", () => {
  it("reconhece ack curto", () => {
    for (const text of ["ok", "Ok!", "obrigado", "beleza 👍", "ok, obrigado", "🙏"]) {
      expect(isShortAckText(text), text).toBe(true);
    }
  });

  it("não trata pergunta ou pedido como ack", () => {
    expect(isShortAckText("ok, como recupero a senha?")).toBe(false);
    expect(isShortAckText("obrigado, mas o link não abre")).toBe(false);
  });
});

describe("isGreetingOnlyText", () => {
  it("reconhece cumprimento solto", () => {
    for (const text of [
      "Bom dia",
      "boa tarde",
      "Oi",
      "Oi Bia tarde",
      "Tudo bem?",
      "olá tudo bem",
    ]) {
      expect(isGreetingOnlyText(text), text).toBe(true);
    }
  });

  it("não trata dúvida ou pedido como cumprimento", () => {
    expect(isGreetingOnlyText("como recupero a senha?")).toBe(false);
    expect(isGreetingOnlyText("quero trocar de curso")).toBe(false);
    expect(
      isGreetingOnlyText("Gostaria de saber se meu filho deve algum valor"),
    ).toBe(false);
  });
});

describe("isIdleClosingText / classifyInboundIdleIntent", () => {
  it("ack e confirmação são idle; oi continua greeting", () => {
    expect(isIdleClosingText("ok")).toBe(true);
    expect(isIdleClosingText("obrigado")).toBe(true);
    expect(isIdleClosingText("Está tudo certo")).toBe(true);
    expect(isIdleClosingText("era só isso")).toBe(true);
    expect(isIdleClosingText("qualquer dúvida eu falo")).toBe(true);
    expect(isIdleClosingText("oi")).toBe(false);
    expect(isIdleClosingText("Bom dia")).toBe(false);
    expect(isIdleClosingText("como recupero a senha?")).toBe(false);
    expect(classifyInboundIdleIntent("ok")).toBe("idle");
    expect(classifyInboundIdleIntent("oi")).toBe("greeting");
    expect(classifyInboundIdleIntent("preciso de ajuda no boleto")).toBe(
      "demand",
    );
  });
});

describe("isAckOrGreetingText", () => {
  it("une ack curto e cumprimento", () => {
    expect(isAckOrGreetingText("ok")).toBe(true);
    expect(isAckOrGreetingText("obrigado")).toBe(true);
    expect(isAckOrGreetingText("Está tudo certo")).toBe(true);
    expect(isAckOrGreetingText("Bom dia")).toBe(true);
    expect(isAckOrGreetingText("como recupero a senha?")).toBe(false);
  });
});

describe("inboundMessageShowsDemand", () => {
  it("ack / vazio / evento → sem demanda", () => {
    expect(inboundMessageShowsDemand(inbound({ content: "ok" }))).toBe(false);
    expect(inboundMessageShowsDemand(inbound({ content: "obrigado" }))).toBe(
      false,
    );
    expect(inboundMessageShowsDemand(inbound({ content: "" }))).toBe(false);
    expect(inboundMessageShowsDemand(inbound({ content: "   " }))).toBe(false);
    expect(
      inboundMessageShowsDemand(
        inbound({
          content: "Ticket atribuído",
          messageType: "event:atribuicao",
        }),
      ),
    ).toBe(false);
    expect(
      inboundMessageShowsDemand({
        direction: "system",
        isPrivate: false,
        content: "Distribuído",
        messageType: "event",
      }),
    ).toBe(false);
    expect(inboundMessageShowsDemand(inbound({ content: "Bom dia" }))).toBe(
      false,
    );
    expect(inboundMessageShowsDemand(inbound({ content: "Tudo bem?" }))).toBe(
      false,
    );
  });

  it("dúvida ou imagem → demanda", () => {
    expect(
      inboundMessageShowsDemand(
        inbound({ content: "como recupero a senha do portal?" }),
      ),
    ).toBe(true);
    expect(
      inboundMessageShowsDemand(
        inbound({ content: "[Imagem]", messageType: "image" }),
      ),
    ).toBe(true);
    expect(
      inboundMessageShowsDemand(
        inbound({ content: "", mediaUrl: "https://cdn.example/comprovante.jpg" }),
      ),
    ).toBe(true);
  });

  it("outbound, nota privada e só empresa não contam", () => {
    expect(
      inboundMessageShowsDemand({
        direction: "out",
        isPrivate: false,
        content: "Como posso ajudar?",
      }),
    ).toBe(false);
    expect(
      inboundMessageShowsDemand(
        inbound({ content: "reclamação interna", isPrivate: true }),
      ),
    ).toBe(false);
  });
});

describe("conversationHasAttendanceDemand", () => {
  it("ticket sem inbound ou só ack não tem atendimento", () => {
    expect(conversationHasAttendanceDemand([])).toBe(false);
    expect(
      conversationHasAttendanceDemand([
        inbound({ content: "ok" }),
        { direction: "out", isPrivate: false, content: "De nada" },
      ]),
    ).toBe(false);
  });

  it("uma dúvida no recorte basta", () => {
    expect(
      conversationHasAttendanceDemand([
        inbound({ content: "ok" }),
        inbound({ content: "quero cancelar a matrícula" }),
      ]),
    ).toBe(true);
  });
});

describe("conversationHasRealAttendance", () => {
  it("dúvida sem resposta de atendente não é atendimento", () => {
    expect(
      conversationHasRealAttendance([
        inbound({ content: "como acesso o portal?" }),
        {
          direction: "out",
          authorType: "bot",
          content: "Olá! Bem vindo",
          senderName: "inicio - pipe",
        },
      ]),
    ).toBe(false);
  });

  it("dúvida + humano ou IA de atendimento", () => {
    expect(
      conversationHasRealAttendance([
        inbound({ content: "como acesso o portal?" }),
        {
          direction: "out",
          authorType: "human",
          content: "Vou te ajudar",
          senderName: "Joyce",
        },
      ]),
    ).toBe(true);
    expect(
      conversationHasRealAttendance(
        [
          inbound({ content: "como acesso o portal?" }),
          {
            direction: "out",
            authorType: "bot",
            aiAgentUserId: "atendimento-ai",
            content: "Segue o passo a passo",
          },
        ],
        "tabulador-1",
      ),
    ).toBe(true);
  });

  it("resposta do próprio tabulador não conta", () => {
    expect(
      conversationHasRealAttendance(
        [
          inbound({ content: "como acesso o portal?" }),
          {
            direction: "out",
            authorType: "bot",
            aiAgentUserId: "tabulador-1",
            content: "classificando",
          },
        ],
        "tabulador-1",
      ),
    ).toBe(false);
  });
});

describe("shouldFireConversationTabulatedTrigger", () => {
  it("dispara automação só quando closed === true", () => {
    expect(shouldFireConversationTabulatedTrigger(true)).toBe(true);
    expect(shouldFireConversationTabulatedTrigger(false)).toBe(false);
  });
});

describe("formatTabulationCatalogText", () => {
  const leaves = [
    {
      id: "leaf-fin",
      number: 2,
      path: "Financeiro > Boleto",
      departmentId: "fin",
      departmentName: "Financeiro",
    },
    {
      id: "leaf-atd",
      number: 1,
      path: "Acesso > Senha",
      departmentId: "atd",
      departmentName: "Atendimento",
    },
  ];

  it("prioriza o departamento da conversa e não oferece fallback de encerramento", () => {
    const text = formatTabulationCatalogText(leaves, "atd");
    expect(text.indexOf("Atendimento / Acesso > Senha")).toBeLessThan(
      text.indexOf("Financeiro / Financeiro > Boleto"),
    );
    expect(text).toContain("Departamento da conversa (preferido)");
    expect(text).not.toMatch(/fallback de encerramento:/i);
    expect(text).not.toContain("Fallback (baixa confiança");
  });
});

describe("arquétipo TABULACAO", () => {
  it("só tabula com atendimento real, não encerra e ignora cadastro", () => {
    const prompt = ARCHETYPE_MAP.TABULACAO.systemPromptTemplate;
    expect(prompt).toMatch(/atendimento real/i);
    expect(prompt).toMatch(/NÃO encerra/i);
    expect(prompt).toMatch(/dados de cadastro/i);
    expect(prompt).not.toMatch(/polo/i);
    expect(ARCHETYPE_MAP.TABULACAO.defaultTools).not.toContain(
      "close_conversation",
    );
  });
});
