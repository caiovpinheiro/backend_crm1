import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/services/ai/agent-key", () => ({ tryGetAgentApiKey: vi.fn() }));
vi.mock("@/services/ai/provider", () => ({ generateWithTools: vi.fn() }));
vi.mock("@/lib/fetch-authorized-audio", () => ({ fetchAuthorizedAudioBuffer: vi.fn() }));
vi.mock("@/lib/groq-transcribe", () => ({ transcribeWithGroq: vi.fn() }));

import { composeTurnText, shouldUnderstand } from "../media-turn";
import { mediaTextLine, understoodKindOf } from "../media-understanding";
import type { V2AgentConfig } from "@/lib/ai-v2/types";

const cfg = (audio: string, image: string) =>
  ({ media: { audio: { action: audio }, image: { action: image }, document: { action: "handoff" } } }) as unknown as V2AgentConfig;

describe("mídia do turno", () => {
  it("reconhece áudio, imagem e documento pelo tipo da mensagem", () => {
    expect(understoodKindOf("ptt")).toBe("audio");
    expect(understoodKindOf("audio")).toBe("audio");
    expect(understoodKindOf("image")).toBe("image");
    expect(understoodKindOf("document")).toBe("document");
    expect(understoodKindOf("text")).toBeNull();
  });

  it("documento: lido só com a política “ler”; o nome do arquivo sai do texto e volta junto do conteúdo", () => {
    const withDoc = (action: string) => ({ media: { audio: { action: "handoff" }, image: { action: "handoff" }, document: { action } } }) as unknown as V2AgentConfig;
    expect(shouldUnderstand(withDoc("describe"), "document")).toBe(true);
    expect(shouldUnderstand(withDoc("ask_text"), "document")).toBe(false);
    const text = composeTurnText("fatura_outubro.pdf\nnão entendi esse valor", [{ kind: "document", text: "Valor do documento R$ 300,00", content: "fatura_outubro.pdf" }]);
    expect(text).toBe('não entendi esse valor\n[Documento enviado pelo cliente ("fatura_outubro.pdf")]: Valor do documento R$ 300,00');
    expect(mediaTextLine("document", "x", "segue a fatura")).toBe('[Documento enviado pelo cliente, com a legenda "segue a fatura"]: x');
  });

  it("só entende quando a política é transcrever/descrever", () => {
    expect(shouldUnderstand(cfg("transcribe", "handoff"), "audio")).toBe(true);
    expect(shouldUnderstand(cfg("transcribe", "handoff"), "image")).toBe(false);
    expect(shouldUnderstand(cfg("ask_text", "describe"), "image")).toBe(true);
  });

  it("troca o marcador pelo conteúdo e mantém o texto do cliente", () => {
    const r = composeTurnText("bom dia\n[Áudio]", [{ kind: "audio", text: "quero saber a data da entrega", content: "[Áudio]" }]);
    expect(r).toBe("bom dia\n[Áudio do cliente, transcrito]: quero saber a data da entrega");
  });

  it("legenda da imagem vai junto da leitura, sem repetir solta", () => {
    const r = composeTurnText("olha esse erro", [{ kind: "image", text: "Tela com a mensagem: Senha expirada.", content: "olha esse erro" }]);
    expect(r).toBe('[Imagem enviada pelo cliente, com a legenda "olha esse erro"]: Tela com a mensagem: Senha expirada.');
  });

  it("linha igual no turno e no histórico (o motor compara o texto)", () => {
    const line = mediaTextLine("audio", "oi", "[Áudio]");
    expect(composeTurnText("[Áudio]", [{ kind: "audio", text: "oi", content: "[Áudio]" }])).toBe(line);
  });
});
