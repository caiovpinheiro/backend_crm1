import { describe, expect, it } from "vitest";

import { ARCHETYPE_MAP } from "@/lib/ai-agents/archetypes";
import {
  conversationHasAttendanceDemand,
  formatTabulationCatalogText,
  inboundMessageShowsDemand,
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
  it("só tabula com atendimento real, não encerra e ignora polo/curso de cadastro", () => {
    const prompt = ARCHETYPE_MAP.TABULACAO.systemPromptTemplate;
    expect(prompt).toMatch(/atendimento real/i);
    expect(prompt).toMatch(/NÃO encerra/i);
    expect(prompt).toMatch(/polo/i);
    expect(prompt).toMatch(/curso/i);
    expect(ARCHETYPE_MAP.TABULACAO.defaultTools).not.toContain(
      "close_conversation",
    );
  });
});
