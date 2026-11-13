import { describe, expect, it } from "vitest";

import {
  V2_MODELS,
  inferV2ModelCaps,
  isAgentChatModelId,
  modelFamilyVersion,
  prettyModelLabel,
  unknownModelPriceCeiling,
  v2FastAuxModel,
} from "../models";
import { mergeModelCatalog, resolveModelPrice, type ModelCatalogRow } from "../model-catalog";
import { getModelPricing } from "@/lib/ai-agents/pricing";

const seen = (modelId: string, extra: Partial<ModelCatalogRow> = {}): ModelCatalogRow => ({
  modelId,
  provider: modelId.startsWith("claude-") ? "anthropic" : "openai",
  firstSeenAt: "2026-11-13T12:00:00Z",
  lastSeenAt: "2026-11-13T12:00:00Z",
  ...extra,
});

describe("filtro: só modelos de chat e texto", () => {
  it.each([
    "gpt-6.1-terra",
    "gpt-4o-mini",
    "gpt-4.1-nano",
    "o3",
    "o4-mini",
    "gpt-5.6-sol-2026-07-01",
  ])("OpenAI aceita %s", (id) => expect(isAgentChatModelId("openai", id)).toBe(true));

  it.each([
    "text-embedding-3-small",
    "whisper-1",
    "tts-1-hd",
    "dall-e-3",
    "gpt-image-1",
    "omni-moderation-latest",
    "gpt-4o-audio-preview",
    "gpt-4o-realtime-preview",
    "gpt-4o-mini-transcribe",
    "gpt-4o-search-preview",
    "gpt-3.5-turbo-instruct",
    "davinci-002",
    "babbage-002",
    "sora-2",
    "codex-mini-latest",
    "chatgpt-4o-latest",
    "ft:gpt-4o-mini:org::abc",
    "GPT-4O",
  ])("OpenAI recusa %s", (id) => expect(isAgentChatModelId("openai", id)).toBe(false));

  it("Anthropic: Claude atual sim; instant e Claude 2 não", () => {
    expect(isAgentChatModelId("anthropic", "claude-sonnet-5-5")).toBe(true);
    expect(isAgentChatModelId("anthropic", "claude-haiku-4-5-20251001")).toBe(true);
    expect(isAgentChatModelId("anthropic", "claude-instant-1.2")).toBe(false);
    expect(isAgentChatModelId("anthropic", "claude-2.1")).toBe(false);
    expect(isAgentChatModelId("anthropic", "gpt-4o")).toBe(false);
  });

  it("capacidades deduzidas pelo id", () => {
    expect(inferV2ModelCaps("gpt-6.1-terra")).toMatchObject({ provider: "openai", reasoning: true, temperature: false, jsonMode: true });
    expect(inferV2ModelCaps("gpt-4.1-nano")).toMatchObject({ reasoning: false, temperature: true });
    expect(inferV2ModelCaps("o3")).toMatchObject({ reasoning: true });
    expect(inferV2ModelCaps("claude-sonnet-5-5")).toMatchObject({ provider: "anthropic", reasoning: true, jsonMode: false });
    expect(inferV2ModelCaps("claude-haiku-5-5")).toMatchObject({ reasoning: false, temperature: true });
    expect(inferV2ModelCaps("text-embedding-3-small")).toBeUndefined();
  });

  it("modelo descoberto que raciocina não vira auxiliar rápido", () => {
    expect(v2FastAuxModel("gpt-6.1-terra")).toBe("gpt-4.1-mini");
  });

  it("família e nome legível", () => {
    expect(modelFamilyVersion("gpt-6.1-terra")).toBe(6.1);
    expect(modelFamilyVersion("claude-sonnet-4-5-20250929")).toBe(4.5);
    expect(modelFamilyVersion("claude-3-5-haiku-20241022")).toBe(3.5);
    expect(modelFamilyVersion("claude-opus-5")).toBe(5);
    expect(prettyModelLabel("gpt-6.1-terra")).toBe("GPT-6.1 Terra");
    expect(prettyModelLabel("gpt-4.1-nano")).toBe("GPT-4.1 nano");
    expect(prettyModelLabel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
  });
});

describe("merge do catálogo com a lista fixa", () => {
  it("sem nada descoberto, a lista é a fixa de hoje", () => {
    const list = mergeModelCatalog([]);
    expect(list.map((m) => m.id).sort()).toEqual(V2_MODELS.map((m) => m.id).sort());
    expect(list.every((m) => m.source === "builtin" && m.priceSource === "builtin")).toBe(true);
  });

  it("descoberto entra na lista; fixo continua", () => {
    const list = mergeModelCatalog([seen("gpt-6.1-terra"), seen("gpt-4o-mini")]);
    const terra = list.find((m) => m.id === "gpt-6.1-terra");
    expect(terra).toMatchObject({ source: "discovered", name: "GPT-6.1 Terra", provider: "openai", missing: false });
    expect(list.filter((m) => m.id === "gpt-4o-mini")).toHaveLength(1);
    expect(list).toHaveLength(V2_MODELS.length + 1);
  });

  it("linha que não é de chat (ou nunca vista no provedor) não entra", () => {
    const list = mergeModelCatalog([
      seen("text-embedding-3-large"),
      { modelId: "gpt-9-x", provider: "openai", inputPer1M: 1, outputPer1M: 2 },
    ]);
    expect(list.some((m) => m.id === "text-embedding-3-large" || m.id === "gpt-9-x")).toBe(false);
  });

  it("versão com data some quando o nome sem data está na lista", () => {
    const list = mergeModelCatalog([seen("gpt-6.1-terra"), seen("gpt-6.1-terra-2026-10-01"), seen("claude-opus-5-20260301")]);
    expect(list.some((m) => m.id === "gpt-6.1-terra-2026-10-01")).toBe(false);
    expect(list.some((m) => m.id === "claude-opus-5-20260301")).toBe(false);
  });

  it("descoberto que sumiu do provedor: fica (marcado) só se alguém usa", () => {
    const rows = [seen("gpt-6.1-terra", { missingSince: "2026-12-01T00:00:00Z" })];
    expect(mergeModelCatalog(rows).some((m) => m.id === "gpt-6.1-terra")).toBe(false);
    const kept = mergeModelCatalog(rows, { inUse: ["gpt-6.1-terra"] }).find((m) => m.id === "gpt-6.1-terra");
    expect(kept).toMatchObject({ missing: true, missingSince: "2026-12-01T00:00:00.000Z" });
  });

  it("fixo que sumiu do provedor continua, marcado", () => {
    const list = mergeModelCatalog([{ modelId: "gpt-4-turbo", provider: "openai", missingSince: "2026-11-13T12:00:00Z" }]);
    expect(list.find((m) => m.id === "gpt-4-turbo")).toMatchObject({ source: "builtin", missing: true });
  });

  it("ordem: OpenAI antes, família mais nova primeiro, antigos no fim", () => {
    const list = mergeModelCatalog([seen("gpt-6.1-terra", { providerCreatedAt: "2026-11-01T00:00:00Z" }), seen("claude-sonnet-5-5")]);
    const ids = list.map((m) => m.id);
    expect(ids[0]).toBe("gpt-6.1-terra");
    expect(ids.indexOf("gpt-6.1-terra")).toBeLessThan(ids.indexOf("gpt-6-sol"));
    expect(ids.indexOf("gpt-6-sol")).toBeLessThan(ids.indexOf("gpt-4o-mini"));
    expect(ids.indexOf("gpt-3.5-turbo")).toBeLessThan(ids.indexOf("claude-sonnet-5-5"));
    expect(ids.indexOf("gpt-4o")).toBeLessThan(ids.indexOf("gpt-4-turbo"));
    expect(ids.indexOf("claude-sonnet-5-5")).toBeLessThan(ids.indexOf("claude-opus-5"));
    expect(ids.indexOf("claude-opus-5")).toBeLessThan(ids.indexOf("claude-haiku-4-5"));
  });
});

describe("modelo sem preço", () => {
  it("descoberto sem preço: desconhecido na tela, teto do provedor na estimativa", () => {
    const terra = mergeModelCatalog([seen("gpt-6.1-terra")]).find((m) => m.id === "gpt-6.1-terra")!;
    const ceiling = unknownModelPriceCeiling("openai");
    expect(terra).toMatchObject({ inputPer1M: null, outputPer1M: null, priceSource: "unknown" });
    expect(terra.estimateInputPer1M).toBe(ceiling.inputPer1M);
    expect(terra.estimateOutputPer1M).toBe(ceiling.outputPer1M);
    // Teto = o maior preço atual da lista fixa do provedor (antigos fora).
    expect(ceiling).toEqual({ inputPer1M: 4, outputPer1M: 20 });
    expect(unknownModelPriceCeiling("anthropic")).toEqual({ inputPer1M: 5, outputPer1M: 25 });
  });

  it("preço preenchido pelo admin vale (e vence a tabela do código)", () => {
    const list = mergeModelCatalog([
      seen("gpt-6.1-terra", { inputPer1M: 1, outputPer1M: 5 }),
      { modelId: "gpt-4o-mini", provider: "openai", inputPer1M: 0.2, outputPer1M: 0.8 },
    ]);
    expect(list.find((m) => m.id === "gpt-6.1-terra")).toMatchObject({ inputPer1M: 1, outputPer1M: 5, priceSource: "org", estimateInputPer1M: 1 });
    expect(list.find((m) => m.id === "gpt-4o-mini")).toMatchObject({ inputPer1M: 0.2, priceSource: "org" });
  });

  it("preço oficial do provedor: depois do admin, antes da tabela do código; versão com data usa o do nome sem data", () => {
    const list = mergeModelCatalog([
      seen("gpt-6.1-terra", { officialInputPer1M: 1, officialOutputPer1M: 5, officialPriceAt: "2026-11-13T15:00:00Z" }),
      { modelId: "gpt-5.6-sol", provider: "openai", officialInputPer1M: 3, officialOutputPer1M: 15 },
      seen("gpt-5.4", { inputPer1M: 9, outputPer1M: 9, officialInputPer1M: 2.5, officialOutputPer1M: 15 }),
    ]);
    expect(list.find((m) => m.id === "gpt-6.1-terra")).toMatchObject({
      inputPer1M: 1,
      outputPer1M: 5,
      priceSource: "official",
      officialPriceAt: "2026-11-13T15:00:00.000Z",
    });
    expect(list.find((m) => m.id === "gpt-5.6-sol")).toMatchObject({ inputPer1M: 3, priceSource: "official" });
    expect(list.find((m) => m.id === "gpt-5.4")).toMatchObject({ inputPer1M: 9, priceSource: "org" });
    expect(resolveModelPrice("gpt-6.1-terra-2026-10-01", null, { officialInputPer1M: 1, officialOutputPer1M: 5 })).toEqual({
      inputPer1M: 1,
      outputPer1M: 5,
      source: "official",
    });
  });

  it("preço pela metade (só entrada) ou inválido não conta", () => {
    expect(resolveModelPrice("gpt-6.1-terra", { inputPer1M: 1, outputPer1M: null }).source).toBe("unknown");
    expect(resolveModelPrice("gpt-6.1-terra", { inputPer1M: Number.NaN, outputPer1M: 2 }).source).toBe("unknown");
    expect(resolveModelPrice("gpt-4o-mini", { inputPer1M: -1, outputPer1M: 2 }).source).toBe("builtin");
  });

  it("estimativa sem organização (pricing.ts) não cai no preço do 4o mini para modelo novo", () => {
    expect(getModelPricing("gpt-6.1-terra")).toEqual({ inputPer1M: 4, outputPer1M: 20 });
    expect(getModelPricing("claude-sonnet-5-5")).toEqual({ inputPer1M: 5, outputPer1M: 25 });
    expect(getModelPricing("gpt-4o-mini")).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6 });
    expect(getModelPricing("algo-desconhecido")).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6 });
  });
});
