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
