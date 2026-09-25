import { beforeEach, describe, expect, it, vi } from "vitest";

import type { V2AgentConfig } from "@/lib/ai-v2/types";

const mocks = vi.hoisted(() => ({ embedTexts: vi.fn() }));

vi.mock("@/services/ai/provider", () => ({ embedTexts: mocks.embedTexts }));

import { clearThemeVectorCache, selectV2ThemeSemantic, themeEmbeddingText } from "../theme-semantic";

const THEMES = [
  { id: "docs", name: "Documentos", when: ["segunda via", "documento"], examples: [], instructions: "Ajude a emitir documentos." },
  { id: "pay", name: "Pagamentos", when: ["boleto"], examples: [], instructions: "Ajude com pagamentos." },
];
const cfg = { themes: THEMES } as unknown as V2AgentConfig;

// Vetores 2D: eixo x = "documentos", eixo y = "pagamentos".
const VEC: Record<string, number[]> = {
  [themeEmbeddingText(THEMES[0] as any)]: [1, 0],
  [themeEmbeddingText(THEMES[1] as any)]: [0, 1],
};

function embedWith(messageVector: number[]) {
  mocks.embedTexts.mockImplementation(async (texts: string[]) => ({
    embeddings: texts.map((t) => VEC[t] ?? messageVector),
    inputTokens: 1,
  }));
}

describe("selectV2ThemeSemantic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearThemeVectorCache();
  });

  it("gatilho casado vence sem gastar embedding", async () => {
    const r = await selectV2ThemeSemantic({ config: cfg, message: "quero a segunda via", apiKey: "k" });
    expect(r).toMatchObject({ method: "trigger", theme: { id: "docs" } });
    expect(mocks.embedTexts).not.toHaveBeenCalled();
  });

  it("sem gatilho, escolhe o assunto mais próximo em significado", async () => {
    embedWith([0.9, 0.2]);
    const r = await selectV2ThemeSemantic({
      config: cfg,
      message: "minha empresa pediu um comprovante de vínculo",
      apiKey: "k",
    });
    expect(r.method).toBe("semantic");
    expect(r.theme?.id).toBe("docs");
  });

  it("abaixo do mínimo mantém o assunto atual", async () => {
    embedWith([0.2, -1]);
    const r = await selectV2ThemeSemantic({
      config: cfg,
      message: "qual é a previsão do tempo amanhã cedo",
      currentThemeId: "pay",
      apiKey: "k",
    });
    expect(r).toMatchObject({ method: "kept", theme: { id: "pay" } });
  });

  it("para sair do assunto atual, o outro precisa de folga sobre ele", async () => {
    const base = { config: cfg, message: "ainda não apareceu nada aqui para mim", currentThemeId: "pay", apiKey: "k" };
    embedWith([0.52, 0.5]); // documentos 0,72 x pagamentos 0,69: quase empate
    expect(await selectV2ThemeSemantic(base)).toMatchObject({ method: "kept", theme: { id: "pay" } });
    clearThemeVectorCache();
    embedWith([0.6, 0.3]); // documentos 0,89 x pagamentos 0,45: troca clara
    expect(await selectV2ThemeSemantic(base)).toMatchObject({ method: "semantic", theme: { id: "docs" } });
  });

  it("similaridade baixa troca sem assunto atual, mas não tira do assunto atual", async () => {
    embedWith([0.45, -0.9]); // documentos 0,45
    const msg = "ainda não apareceu nada aqui para mim";
    expect((await selectV2ThemeSemantic({ config: cfg, message: msg, apiKey: "k" })).theme?.id).toBe("docs");
    clearThemeVectorCache();
    expect(await selectV2ThemeSemantic({ config: cfg, message: msg, currentThemeId: "pay", apiKey: "k" })).toMatchObject({
      method: "kept",
      theme: { id: "pay" },
    });
  });

  it("acompanhamento curto não troca de assunto nem gasta embedding", async () => {
    const r = await selectV2ThemeSemantic({ config: cfg, message: "consegue me enviar?", currentThemeId: "pay", apiKey: "k" });
    expect(r).toMatchObject({ method: "kept", theme: { id: "pay" } });
    expect(mocks.embedTexts).not.toHaveBeenCalled();
  });

  it("falha de embedding cai no assunto atual", async () => {
    mocks.embedTexts.mockRejectedValue(new Error("rate limit"));
    const r = await selectV2ThemeSemantic({
      config: cfg,
      message: "minha empresa pediu um comprovante de vínculo",
      currentThemeId: "pay",
      apiKey: "k",
    });
    expect(r).toMatchObject({ method: "kept", theme: { id: "pay" } });
  });

  it("vetores dos assuntos ficam em cache entre turnos", async () => {
    embedWith([0.9, 0.2]);
    await selectV2ThemeSemantic({ config: cfg, message: "minha empresa pediu um comprovante de vínculo", apiKey: "k" });
    await selectV2ThemeSemantic({ config: cfg, message: "preciso comprovar meu vínculo com vocês", apiKey: "k" });
    const themeCalls = mocks.embedTexts.mock.calls.filter((c) => (c[0] as string[]).length === 2);
    expect(themeCalls).toHaveLength(1);
  });
});

describe("gatilho x sentido", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearThemeVectorCache();
  });

  it("frase longa: sentido claramente de outro assunto vence o gatilho", async () => {
    embedWith([0.1, 0.99]); // pagamentos ~0,99; documentos ~0,10
    const r = await selectV2ThemeSemantic({ config: cfg, message: "preciso do documento para pagar o boleto atrasado deste mês", apiKey: "k" });
    expect(r.theme?.id).toBe("pay");
  });

  it("frase curta: gatilho vence sem gastar embedding", async () => {
    const r = await selectV2ThemeSemantic({ config: cfg, message: "segunda via", apiKey: "k" });
    expect(r).toMatchObject({ method: "trigger", theme: { id: "docs" } });
    expect(mocks.embedTexts).not.toHaveBeenCalled();
  });
});
