import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resposta por áudio: o que o motor garante sem depender do modelo
 * (permissão, limites, queda para texto) e o contrato com o provedor de voz.
 */

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(async (_sql: string, ..._v: unknown[]): Promise<unknown[]> => []),
  executeRaw: vi.fn(async (_sql: string, ..._v: unknown[]) => 1),
  sendMedia: vi.fn(async (_args: Record<string, unknown>) => 1),
  saveFile: vi.fn(async (_args: Record<string, unknown>) => ({ url: "/api/storage/org-1/automation-media/voz.mp3", absolutePath: "x" })),
}));

vi.mock("@/lib/prisma-base", () => ({ prismaBase: { $queryRawUnsafe: mocks.queryRaw, $executeRawUnsafe: mocks.executeRaw } }));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock("@/lib/secret-crypto", () => ({ encryptSecret: (s: string) => `enc:${s}`, decryptSecret: (s: string) => s.replace(/^enc:/, "") }));
vi.mock("@/lib/storage/local", () => ({ generateFileName: () => "voz.mp3", saveFile: mocks.saveFile }));
vi.mock("@/services/ai/send-agent-media", () => ({
  sendAgentFollowUpMedia: mocks.sendMedia,
  mediaNotSentTrace: (what: string) => `${what} não enviados`,
}));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { defaultV2Counters, parseV2Counters } from "../limits";
import {
  VOICE_PERMISSION_QUESTION_DEFAULT,
  applyVoiceConsent,
  decideVoice,
  deliverVoiceReply,
  speakableText,
  speechMatchesReply,
  stripAudioTags,
  voiceCompanionText,
  voiceKeyFields,
  voicePromptSection,
  writtenData,
} from "../voice";
import { elevenLabsProvider, resolveVoiceSettings } from "../voice-provider";

const LONG = "Funciona assim: você escolhe a opção, a equipe confirma os dados e em seguida libera o acesso para você começar.";

const config = (voice: Record<string, unknown> = {}) =>
  normalizeV2Config({ name: "A", tone: "t", voice: { enabled: true, voiceId: "voz-1", mode: "agent", ...voice } } as never);

const decide = (over: Partial<Parameters<typeof decideVoice>[0]> = {}) =>
  decideVoice({
    config: config(),
    counters: { ...defaultV2Counters(), voiceConsent: "granted" },
    modelWantsVoice: true,
    clientAudioThisTurn: false,
    autonomous: true,
    hasKey: true,
    replyText: LONG,
    hasOptions: false,
    charsToday: 0,
    ...over,
  });

describe("texto falado e texto escrito", () => {
  it("a fala sai sem link, marcação, emoji nem marcador de lista", () => {
    expect(speakableText("*Olha só* 😀\n- primeiro passo\n- segundo: veja em https://exemplo.com/a .")).toBe("Olha só primeiro passo segundo: veja em.");
  });

  it("por escrito vai só o dado (valor, data, horário, link), não a frase inteira", () => {
    const reply = "Funciona assim. O valor é R$ 1.120,50 por mês, com 10% de desconto. A parte prática está prevista a partir de agosto de 2027, de uma a três vezes por mês. O prazo vai até 10/12, às 18h. Veja em https://exemplo.com/a.";
    expect(writtenData(reply)).toEqual(["R$ 1.120,50", "10%", "agosto de 2027", "10/12", "18h", "https://exemplo.com/a"]);
    expect(voiceCompanionText(config(), reply)).toBe("Por escrito: R$ 1.120,50 · 10% · agosto de 2027 · 10/12 · 18h · https://exemplo.com/a");
    expect(writtenData("Dia 5 de março de 2027 começa a turma.")).toEqual(["5 de março de 2027"]);
  });

  it("sem dado para escrever, vai a linha configurada ou a padrão", () => {
    expect(voiceCompanionText(config(), "Funciona assim, sem segredo.")).toBe("Te respondi por áudio.");
    expect(voiceCompanionText(config({ companionText: "Segue o áudio." }), "Funciona assim, sem segredo.")).toBe("Segue o áudio.");
  });

  it("marcações de interpretação saem do texto escrito; colchete com número não é marcação", () => {
    expect(stripAudioTags("[animada] Que bom! [pausa] Vamos lá. Veja o item [2].")).toBe("Que bom! Vamos lá. Veja o item [2].");
    expect(voiceCompanionText(config(), "[confiante] O valor é R$ 50,00.")).toBe("Por escrito: R$ 50,00");
  });

  it("o roteiro falado só vale com os mesmos números da resposta e sem link", () => {
    const reply = "A mensalidade é R$ 120,00 e o prazo vai até 10/12.";
    expect(speechMatchesReply("[animada] Olha, fica cento e vinte por mês, e dá pra entrar até 10/12, tá?", reply)).toBe(true);
    expect(speechMatchesReply("Fica R$ 99,00 por mês.", reply)).toBe(false);
    expect(speechMatchesReply("Entra em https://exemplo.com e vê.", reply)).toBe(false);
    expect(speechMatchesReply("[animada]", reply)).toBe(false);
  });
});

describe("quando a resposta vai por áudio", () => {
  it("com permissão, dentro dos limites e pedido pelo modelo: fala a própria resposta", () => {
    expect(decide()).toEqual({ action: "speak", spoken: LONG, plain: LONG });
  });

  it("com roteiro falado, fala o roteiro; as marcações só vão ao provedor no modelo que as aceita", () => {
    const speech = "[animada] Olha, funciona assim: você escolhe, a equipe confirma e já libera o acesso pra você.";
    const plain = "Olha, funciona assim: você escolhe, a equipe confirma e já libera o acesso pra você.";
    expect(decide({ speech })).toEqual({ action: "speak", spoken: plain, plain });
    expect(decide({ speech, config: config({ model: "eleven_v3" }) })).toEqual({ action: "speak", spoken: speech, plain });
  });

  it("desligada, sem voz escolhida, sem chave ou em modo sugestão: texto", () => {
    expect(decide({ config: config({ enabled: false }) }).action).toBe("none");
    expect(decide({ config: config({ voiceId: "" }) }).action).toBe("none");
    expect(decide({ hasKey: false }).action).toBe("none");
    expect(decide({ autonomous: false }).action).toBe("none");
  });

  it("modo espelho só responde por áudio a quem mandou áudio; aí não precisa de permissão", () => {
    const mirror = config({ mode: "mirror" });
    const fresh = defaultV2Counters();
    expect(decide({ config: mirror, counters: fresh }).action).toBe("none");
    expect(decide({ config: mirror, counters: fresh, modelWantsVoice: false, clientAudioThisTurn: true }).action).toBe("speak");
  });

  it("sem permissão guardada: pergunta uma vez no lugar da resposta; depois de perguntar, segue em texto até o cliente responder", () => {
    const fresh = defaultV2Counters();
    expect(decide({ counters: fresh })).toEqual({ action: "ask", question: VOICE_PERMISSION_QUESTION_DEFAULT });
    expect(decide({ config: config({ permissionQuestion: "Pode ser por áudio?" }), counters: fresh })).toEqual({ action: "ask", question: "Pode ser por áudio?" });
    expect(decide({ counters: { ...fresh, voiceAsked: true } }).action).toBe("none");
    expect(decide({ counters: { ...fresh, voiceClientAudio: true } }).action).toBe("speak");
  });

  it("cliente que recusou nunca recebe áudio, nem mandando áudio", () => {
    const denied = { ...defaultV2Counters(), voiceConsent: "denied" as const };
    expect(decide({ counters: denied }).action).toBe("none");
    expect(decide({ counters: denied, clientAudioThisTurn: true }).action).toBe("none");
  });

  it("limites: curta demais, longa demais, botões, teto por conversa e teto diário", () => {
    expect(decide({ replyText: "Tudo certo!" }).action).toBe("none");
    expect(decide({ config: config({ maxChars: 80 }) }).action).toBe("none");
    expect(decide({ hasOptions: true }).action).toBe("none");
    expect(decide({ counters: { ...defaultV2Counters(), voiceConsent: "granted", voiceCount: 4 } }).action).toBe("none");
    expect(decide({ config: config({ dailyCharCap: 150 }), charsToday: 100 }).action).toBe("none");
    expect(decide({ config: config({ dailyCharCap: 0 }), charsToday: 999999 }).action).toBe("speak");
  });

  it("o sim só vale depois da pergunta; o não vale sempre e não é desfeito", () => {
    const c = defaultV2Counters();
    applyVoiceConsent(c, true);
    expect(c.voiceConsent).toBeUndefined();
    c.voiceAsked = true;
    applyVoiceConsent(c, true);
    expect(c.voiceConsent).toBe("granted");
    applyVoiceConsent(c, false);
    applyVoiceConsent(c, true);
    expect(c.voiceConsent).toBe("denied");
    expect(parseV2Counters({ ...c, voiceCount: 2, voiceClientAudio: true })).toMatchObject({ voiceConsent: "denied", voiceAsked: true, voiceCount: 2, voiceClientAudio: true });
  });

  it("o modelo só fica sabendo de áudio quando pode haver áudio no turno", () => {
    const base = { counters: defaultV2Counters(), clientAudioThisTurn: false, autonomous: true, hasKey: true };
    expect(voicePromptSection({ ...base, config: config({ guidance: "Use para explicar." }) })).toContain("Use para explicar.");
    expect(voicePromptSection({ ...base, config: config() })).toContain("o sistema pergunta antes");
    expect(voicePromptSection({ ...base, config: config({ mode: "mirror" }) })).toBe("");
    expect(voicePromptSection({ ...base, config: config({ mode: "mirror" }), clientAudioThisTurn: true })).toContain("O cliente mandou áudio");
    expect(voicePromptSection({ ...base, config: config(), hasKey: false })).toBe("");
    expect(voicePromptSection({ ...base, config: config(), autonomous: false })).toBe("");
    expect(voicePromptSection({ ...base, config: config(), counters: { ...defaultV2Counters(), voiceConsent: "denied" } })).toBe("");
  });
});

describe("chave do provedor de voz", () => {
  it("não mexe sem valor, limpa com vazio, cifra e guarda só os 4 últimos como dica", () => {
    expect(voiceKeyFields(undefined)).toBeNull();
    expect(voiceKeyFields("")).toEqual({ voiceApiKeyEnc: null, voiceApiKeyHint: null });
    expect(voiceKeyFields('  "chave-de-teste-0123456789abcd"  ')).toEqual({ voiceApiKeyEnc: "enc:chave-de-teste-0123456789abcd", voiceApiKeyHint: "abcd" });
    expect(() => voiceKeyFields("curta")).toThrow();
  });
});

describe("provedor de voz e entrega", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mocks.queryRaw.mockResolvedValue([{ enc: "enc:chave-de-teste-0123456789abcd" }]);
    mocks.sendMedia.mockResolvedValue(1);
  });
  afterEach(() => vi.unstubAllGlobals());

  const audioResponse = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });

  it("pede ao provedor o modelo rápido, em português, com a chave só no cabeçalho", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    const audio = await elevenLabsProvider.synthesize({ apiKey: "segredo", voiceId: "voz 1", text: "Olá" });
    expect(audio).toMatchObject({ mime: "audio/mpeg", ext: "mp3" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voz%201?output_format=mp3_44100_64");
    expect(url).not.toContain("segredo");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("segredo");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Olá",
      model_id: "eleven_flash_v2_5",
      language_code: "pt",
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
    });
  });

  it("modelo e ajustes do agente vão ao provedor; cada modelo tem o seu padrão", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await elevenLabsProvider.synthesize({ apiKey: "segredo", voiceId: "v", text: "Olá", model: "eleven_multilingual_v2", settings: { stability: 0.2, speed: 1.1 } });
    const multilingual = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(multilingual.model_id).toBe("eleven_multilingual_v2");
    expect("language_code" in multilingual).toBe(false);
    expect(multilingual.voice_settings).toEqual({ stability: 0.2, similarity_boost: 0.75, style: 0.3, use_speaker_boost: true, speed: 1.1 });

    // O v3 só tem três níveis de estabilidade; velocidade fica na faixa do provedor.
    expect(resolveVoiceSettings("eleven_v3", { stability: 0.3, speed: 3 })).toMatchObject({ stability: 0.5, speed: 1.2 });
    expect(resolveVoiceSettings("eleven_v3", { stability: 0.2 }).stability).toBe(0);
    expect(resolveVoiceSettings("modelo-desconhecido").stability).toBe(0.4);
  });

  it("erro do provedor vira motivo claro, sem a chave", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(elevenLabsProvider.synthesize({ apiKey: "segredo", voiceId: "v", text: "Olá" })).rejects.toThrow("o provedor de voz recusou a chave");
  });

  const deliver = () =>
    deliverVoiceReply({ organizationId: "org-1", agentId: "ag-1", agentUserId: "u-1", conversationId: "conv-1", contactId: "c-1", config: config(), spoken: `[animada] ${LONG}`, plain: LONG, record: "Resposta escrita." });

  it("gera, guarda e manda só como mensagem de voz, com volume padronizado e o texto escrito gravado; conta o uso", async () => {
    fetchMock.mockResolvedValue(audioResponse());
    expect(await deliver()).toEqual({ sent: true });
    const media = mocks.sendMedia.mock.calls[0][0] as { attachments: Array<Record<string, unknown>>; waitForSendMs: number };
    expect(media.attachments[0]).toMatchObject({ mimeType: "audio/mpeg", caption: "Resposta escrita.", voiceOnly: true, normalizeLoudness: true });
    expect(media.waitForSendMs).toBeGreaterThan(0);
    expect(mocks.executeRaw.mock.calls.some((c) => String(c[0]).includes("ai_simple_voice_usage") && c.includes(LONG.length))).toBe(true);
  });

  it("provedor fora, áudio que não saiu ou agente sem chave: não enviado, e quem chama responde em texto", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 429 }));
    expect(await deliver()).toMatchObject({ sent: false });
    expect(mocks.sendMedia).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(audioResponse());
    mocks.sendMedia.mockResolvedValueOnce(0);
    expect(await deliver()).toMatchObject({ sent: false });

    mocks.queryRaw.mockResolvedValue([{ enc: null }]);
    expect(await deliver()).toEqual({ sent: false, reason: "sem chave do provedor de voz" });
  });
});
