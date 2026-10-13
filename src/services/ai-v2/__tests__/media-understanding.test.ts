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
import { clientWordsOnly, isBareFileName, readDocumentText, understandMedia } from "../media-understanding";

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

describe("documento do cliente", () => {
  it("nome de arquivo sozinho não é texto do cliente", () => {
    expect(isBareFileName("in_1791805923867_x.pdf")).toBe(true);
    expect(isBareFileName("Fatura Outubro.pdf")).toBe(false);
    expect(isBareFileName("segue o arquivo")).toBe(false);
    expect(isBareFileName(null)).toBe(false);
  });

  it("lê o texto do documento; arquivo sem texto volta erro (o agente pede print)", async () => {
    const ok = await readDocumentText(Buffer.from("Valor do documento\nR$ 300,00\nDesconto de R$ 120,00 até 13/10"), "text/plain", "fatura.txt");
    expect(ok.text).toContain("Desconto de R$ 120,00 até 13/10");
    const empty = await readDocumentText(Buffer.from(""), "application/pdf", "escaneado.pdf");
    expect(empty.text).toBeNull();
    expect(empty.error).toMatch(/sem texto legível/);
    const long = await readDocumentText(Buffer.from("linha de conteúdo\n".repeat(800)), "text/plain", null);
    expect(long.text!.length).toBeLessThan(6100);
    expect(long.text).toContain("[…documento cortado]");
  });
});

describe("só as palavras do cliente", () => {
  it("tira o texto lido da imagem e do documento, mantém a legenda, o áudio e o que ele escreveu", () => {
    const msg = 'olha aí aparece isso\n[Imagem enviada pelo cliente]: Tela de verificação. Botões: "Cancelar", "Continuar".\n[Documento enviado pelo cliente ("fatura.pdf")]: Cancelamento só pelo site.\n[Áudio do cliente, transcrito]: não consigo entrar';
    const out = clientWordsOnly(msg);
    expect(out).toContain("olha aí aparece isso");
    expect(out).toContain("não consigo entrar");
    expect(out).not.toMatch(/Cancelar|Cancelamento/);
    expect(clientWordsOnly('[Imagem enviada pelo cliente, com a legenda "quero cancelar"]: Tela inicial.')).toBe("quero cancelar");
  });
});
