import { describe, expect, it } from "vitest";

import { anthropicNameToId, parseAnthropicPricing, parseOpenAiPricing, parseUsd } from "../official-prices";

// Trechos da página oficial da OpenAI (developers.openai.com/api/docs/pricing.md, 13/11/2026).
const OPENAI_MD = [
  "# Pricing",
  "",
  "Standard",
  "",
  "### Standard pricing data",
  "",
  "| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Long context input | Long context output |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| gpt-6.1-terra | $1.00 | $5.00 | $0.05 | $1.25 | $2.00 | $7.50 |",
  "| gpt-5.6-sol | $4.00 | $20.00 | $0.40 | $5.00 | $8.00 | $30.00 |",
  "| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | $10.00 | $45.00 |",
  "| gpt-5.5-pro (<272K context length) | $30.00 | $180.00 | - | - | $60.00 | $270.00 |",
  "",
  "| Model | Input | Output | Cached input |",
  "| --- | --- | --- | --- |",
  "| gpt-5.4-mini | $0.75 | $4.50 | $0.075 |",
  "| gpt-4o-mini | $0.15 | $0.60 | $0.075 |",
  "| o3 | $2.00 | $8.00 | $0.50 |",
  "",
  "### Batch pricing data",
  "",
  "#### Batch",
  "",
  "| Model | Input | Output | Cached input |",
  "| --- | --- | --- | --- |",
  "| gpt-6.1-terra | $0.50 | $2.50 | $0.025 |",
  "",
  "### Grouped Pricing Table data",
  "| Model | Modality | Input | Output | Cached input |",
  "| --- | --- | --- | --- | --- |",
  "| gpt-image-2 | Image | $8.00 | $30.00 | $2.00 |",
].join("\n");

// Trecho da página oficial da Anthropic (platform.claude.com/docs/en/about-claude/pricing.md, 13/11/2026).
const ANTHROPIC_MD = [
  "## Model pricing",
  "",
  "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |",
  "| Claude Opus 4.1 ([retired, except on Claude Models on Google Cloud (Google managed) and Bedrock](https://x)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
  "| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |",
  "| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |",
  "| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |",
  "",
  "### Batch processing",
  "",
  "| Model | Batch input | Batch output |",
  "| --- | --- | --- |",
  "| Claude Opus 5.5 | $2 / MTok | $10 / MTok |",
].join("\n");

describe("preço oficial — OpenAI", () => {
  const prices = parseOpenAiPricing(OPENAI_MD);

  it("lê a tarifa Standard por id (entrada e saída de contexto curto)", () => {
    expect(prices.get("gpt-6.1-terra")).toEqual({ inputPer1M: 1, outputPer1M: 5 });
    expect(prices.get("gpt-5.6-sol")).toEqual({ inputPer1M: 4, outputPer1M: 20 });
    expect(prices.get("gpt-5.4-mini")).toEqual({ inputPer1M: 0.75, outputPer1M: 4.5 });
    expect(prices.get("o3")).toEqual({ inputPer1M: 2, outputPer1M: 8 });
  });

  it("id com '(<272K context length)' vira o id puro", () => {
    expect(prices.get("gpt-5.5")).toEqual({ inputPer1M: 5, outputPer1M: 30 });
    expect(prices.get("gpt-5.5-pro")).toEqual({ inputPer1M: 30, outputPer1M: 180 });
  });

  it("batch e imagem não sobrescrevem nem entram", () => {
    expect(prices.get("gpt-6.1-terra")?.inputPer1M).toBe(1);
    expect(prices.has("gpt-image-2")).toBe(false);
  });

  it("página sem tabela: nada", () => {
    expect(parseOpenAiPricing("# Pricing\n\nNada aqui.").size).toBe(0);
  });
});

describe("preço oficial — Anthropic", () => {
  const prices = parseAnthropicPricing(ANTHROPIC_MD);

  it("converte o nome em id e lê entrada base e saída", () => {
    expect(prices.get("claude-opus-5-5")).toEqual({ inputPer1M: 4, outputPer1M: 20 });
    expect(prices.get("claude-sonnet-5")).toEqual({ inputPer1M: 2, outputPer1M: 10 });
    expect(prices.get("claude-opus-4-1")).toEqual({ inputPer1M: 15, outputPer1M: 75 });
  });

  it("Haiku 5.5 em duas linhas: fica a de prompts menores", () => {
    expect(prices.get("claude-haiku-5-5")).toEqual({ inputPer1M: 0.1, outputPer1M: 0.5 });
  });

  it("tabela de batch não entra", () => {
    expect(prices.get("claude-opus-5-5")?.inputPer1M).toBe(4);
  });

  it("nome → id", () => {
    expect(anthropicNameToId("Claude Sonnet 4.6")).toBe("claude-sonnet-4-6");
    expect(anthropicNameToId("Claude Mythos 5.2 ([limited availability](https://x))")).toBe("claude-mythos-5-2");
    expect(anthropicNameToId("Claude Opus 5 / Claude Opus 4.8")).toBeNull();
  });
});

it("valor em dólar", () => {
  expect(parseUsd("$1.25")).toBe(1.25);
  expect(parseUsd("$0.20 / MTok<sup>2</sup>")).toBe(0.2);
  expect(parseUsd("-")).toBeNull();
});
