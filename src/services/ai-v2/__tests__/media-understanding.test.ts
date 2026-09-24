import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/fetch-authorized-audio", () => ({
  fetchAuthorizedAudioBuffer: vi.fn(async () => ({ buffer: Buffer.from("ogg"), contentType: "audio/ogg" })),
}));
vi.mock("@/lib/groq-transcribe", () => ({ transcribeWithGroq: vi.fn(async () => ({ text: "via groq" })) }));
vi.mock("@/services/ai/provider", () => ({
  transcribeWithOpenAI: vi.fn(async () => "via chave do agente"),
  generateWithTools: vi.fn(async () => ({ text: "Tela com erro: senha expirada" })),
}));

import { transcribeWithGroq } from "@/lib/groq-transcribe";
import { generateWithTools, transcribeWithOpenAI } from "@/services/ai/provider";
import { understandMedia } from "../media-understanding";

const base = { organizationId: "org", userId: "u", model: "gpt-4o", message: { id: "m1", messageType: "ptt", mediaUrl: "https://x/a.ogg", content: "[Áudio]" } };

describe("understandMedia", () => {
  beforeEach(() => vi.clearAllMocks());

  it("áudio usa a chave do próprio agente, sem Groq", async () => {
    const r = await understandMedia({ ...base, kind: "audio", apiKey: "sk-agente" });
    expect(r.text).toBe("via chave do agente");
    expect(transcribeWithOpenAI).toHaveBeenCalledWith("sk-agente", expect.any(Uint8Array));
    expect(transcribeWithGroq).not.toHaveBeenCalled();
  });

  it("agente sem chave: usa o serviço do servidor", async () => {
    const r = await understandMedia({ ...base, kind: "audio", apiKey: null });
    expect(r.text).toBe("via groq");
    expect(transcribeWithOpenAI).not.toHaveBeenCalled();
  });

  it("falha na chave do agente vira erro explicado, sem inventar texto", async () => {
    (transcribeWithOpenAI as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("401 invalid key"));
    const r = await understandMedia({ ...base, kind: "audio", apiKey: "sk-ruim" });
    expect(r.text).toBeNull();
    expect(r.error).toContain("chave do agente");
  });

  it("imagem é lida pelo modelo do agente", async () => {
    const r = await understandMedia({ ...base, message: { ...base.message, messageType: "image" }, kind: "image", apiKey: "sk-agente" });
    expect(r.text).toContain("senha expirada");
    expect((generateWithTools as ReturnType<typeof vi.fn>).mock.calls[0][0].apiKey).toBe("sk-agente");
  });
});
