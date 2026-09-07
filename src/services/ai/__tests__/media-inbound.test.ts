import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
    },
  },
}));

import {
  isContentlessInbound,
  mediaPlaceholderKind,
  probeInboundMedia,
  stripMediaPlaceholders,
} from "@/lib/ai-agents/media-placeholder";
import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { prisma } from "@/lib/prisma";
import { evaluateInboundMedia } from "@/services/ai/media-inbound";

/** Agente genérico: sem vertical pack. É o caso que precisa funcionar. */
const genericPolicy = normalizeInboxPolicy(null, null);

function mockInbound(
  rows: Array<{ content: string; messageType?: string; minutesAgo?: number }>,
) {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.message.findMany).mockResolvedValue(
    rows.map((r) => ({
      content: r.content,
      authorType: "contact",
      messageType: r.messageType ?? "text",
      createdAt: new Date(Date.now() - (r.minutesAgo ?? 0) * 60_000),
    })) as never,
  );
}

describe("reconhecimento de placeholder de mídia", () => {
  it("sintoma original: '[Imagem]' é ausência de conteúdo, não pergunta curta", () => {
    expect(mediaPlaceholderKind("[Imagem]")).toBe("image");
    expect(isContentlessInbound("[Imagem]")).toBe(true);
    expect(isContentlessInbound("")).toBe(true);
  });

  it("cobre os placeholders que webhook e worker realmente gravam", () => {
    expect(mediaPlaceholderKind("[Vídeo]")).toBe("video");
    expect(mediaPlaceholderKind("[Documento]")).toBe("document");
    expect(mediaPlaceholderKind("[Áudio]")).toBe("audio");
    expect(mediaPlaceholderKind("[audio]")).toBe("audio");
    expect(mediaPlaceholderKind("[ptt]")).toBe("audio");
    expect(mediaPlaceholderKind("[image] 👁")).toBe("image");
    expect(mediaPlaceholderKind("[Sticker]")).toBe("sticker");
    expect(mediaPlaceholderKind("[Contato compartilhado]")).toBe("contact");
    expect(mediaPlaceholderKind("[qualquer coisa]")).toBe("other");
  });

  it("legenda junto do placeholder é pedido de verdade", () => {
    expect(mediaPlaceholderKind("[Imagem] segue o comprovante")).toBeNull();
    expect(isContentlessInbound("quero cancelar minha matrícula")).toBe(false);
    // Documento nomeado: o filename é conteúdo útil.
    expect(isContentlessInbound("contrato-assinado.pdf")).toBe(false);
  });

  it("stripMediaPlaceholders limpa o lote agregado", () => {
    expect(stripMediaPlaceholders("[Imagem]\nquero cancelar")).toBe(
      "quero cancelar",
    );
    expect(stripMediaPlaceholders("[Imagem]\n[Vídeo]")).toBe("");
  });

  it("messageType tem prioridade sobre o texto", () => {
    expect(
      probeInboundMedia({ content: "orçamento.pdf", messageType: "document" }),
    ).toEqual({ kind: "document", contentless: false });
  });
});

describe("evaluateInboundMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sintoma original: imagem sem legenda NÃO segue para o LLM", async () => {
    mockInbound([{ content: "[Imagem]", messageType: "image" }]);
    const verdict = await evaluateInboundMedia({
      conversationId: "conv-1",
      userMessage: "[Imagem]",
      policy: genericPolicy,
    });
    expect(verdict.kinds).toEqual(["image"]);
    expect(verdict.hasUsableText).toBe(false);
    // Default seguro para agente SEM vertical pack.
    expect(verdict.action).toBe("handoff");
  });

  it("imagem com legenda segue o fluxo normal", async () => {
    mockInbound([
      { content: "[Imagem]", messageType: "image" },
      { content: "quero cancelar minha matrícula", messageType: "text" },
    ]);
    const verdict = await evaluateInboundMedia({
      conversationId: "conv-1",
      userMessage: "[Imagem]\nquero cancelar minha matrícula",
      policy: genericPolicy,
    });
    expect(verdict.hasUsableText).toBe(true);
    expect(verdict.action).toBeNull();
  });

  it("mensagem de texto puro não aciona nada", async () => {
    mockInbound([{ content: "como emito a segunda via do boleto" }]);
    const verdict = await evaluateInboundMedia({
      conversationId: "conv-1",
      userMessage: "como emito a segunda via do boleto",
      policy: genericPolicy,
    });
    expect(verdict.kinds).toEqual([]);
    expect(verdict.action).toBeNull();
  });

  it("figurinha não gera fila humana no default", async () => {
    mockInbound([{ content: "[Sticker]", messageType: "sticker" }]);
    const verdict = await evaluateInboundMedia({
      conversationId: "conv-1",
      userMessage: "[Sticker]",
      policy: genericPolicy,
    });
    expect(verdict.action).toBe("ignore");
  });

  it("política por agente vence o default, por tipo de mídia", async () => {
    const policy = normalizeInboxPolicy(
      { media: { actions: { image: "ask_text" } } },
      null,
    );
    mockInbound([{ content: "[Imagem]", messageType: "image" }]);
    expect(
      (
        await evaluateInboundMedia({
          conversationId: "conv-1",
          userMessage: "[Imagem]",
          policy,
        })
      ).action,
    ).toBe("ask_text");
  });

  it("lote com tipos diferentes usa a ação mais grave", async () => {
    mockInbound([
      { content: "[Sticker]", messageType: "sticker" },
      { content: "[Documento]", messageType: "document" },
    ]);
    const verdict = await evaluateInboundMedia({
      conversationId: "conv-1",
      userMessage: "[Sticker]\n[Documento]",
      policy: genericPolicy,
    });
    expect(verdict.kinds).toEqual(["document", "sticker"]);
    expect(verdict.action).toBe("handoff");
  });

  it("mídia fora da janela do lote não conta para o turno atual", async () => {
    mockInbound([
      { content: "[Imagem]", messageType: "image", minutesAgo: 40 },
      { content: "oi", messageType: "text", minutesAgo: 0 },
    ]);
    const verdict = await evaluateInboundMedia({
      conversationId: "conv-1",
      userMessage: "oi",
      policy: genericPolicy,
    });
    expect(verdict.kinds).toEqual([]);
    expect(verdict.action).toBeNull();
  });
});
