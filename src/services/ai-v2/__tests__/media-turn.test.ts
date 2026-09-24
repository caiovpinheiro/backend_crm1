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
  it("reconhece áudio e imagem pelo tipo da mensagem", () => {
    expect(understoodKindOf("ptt")).toBe("audio");
    expect(understoodKindOf("audio")).toBe("audio");
    expect(understoodKindOf("image")).toBe("image");
    expect(understoodKindOf("document")).toBeNull();
    expect(understoodKindOf("text")).toBeNull();
  });

  it("só entende quando a política é transcrever/descrever", () => {
    expect(shouldUnderstand(cfg("transcribe", "handoff"), "audio")).toBe(true);
    expect(shouldUnderstand(cfg("transcribe", "handoff"), "image")).toBe(false);
    expect(shouldUnderstand(cfg("ask_text", "describe"), "image")).toBe(true);
  });

  it("troca o marcador pelo conteúdo e mantém o texto do cliente", () => {
    const r = composeTurnText("bom dia\n[Áudio]", [{ kind: "audio", text: "quero saber a data da prova", content: "[Áudio]" }]);
    expect(r).toBe("bom dia\n[Áudio do cliente, transcrito]: quero saber a data da prova");
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
