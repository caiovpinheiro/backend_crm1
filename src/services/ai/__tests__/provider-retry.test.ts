import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fiação do timeout/retry na fachada do provider: `generateWithTools` tem que
 * (a) desligar o retry interno do SDK (`maxRetries: 0` — senão o SDK retenta
 * por dentro de uma tentativa que o nosso timeout já deveria ter abortado),
 * (b) repassar o `abortSignal`, senão o timeout só abandona a Promise e o
 * socket segue aberto, e (c) retentar só erro transitório.
 */

const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (args: unknown) => generateTextMock(args),
  embedMany: vi.fn(),
  stepCountIs: (n: number) => n,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => (model: string) => ({ modelId: model }),
}));

vi.mock("@/services/ai/llm-retry", async (importOriginal) => {
  const real = await importOriginal<
    typeof import("@/services/ai/llm-retry")
  >();
  return {
    ...real,
    // Sem espera real no teste; o resto (classificação, timeout, contagem
    // de tentativas) é o código de produção.
    callLlmWithRetry: (
      fn: (signal: AbortSignal) => Promise<unknown>,
      options: Record<string, unknown> = {},
    ) => real.callLlmWithRetry(fn, { ...options, sleepFn: async () => {} }),
  };
});

import { generateWithTools } from "@/services/ai/provider";

const OK = {
  text: "oi",
  steps: [],
  usage: { inputTokens: 10, outputTokens: 5 },
};

const ARGS = {
  model: "gpt-4o-mini",
  apiKey: "sk-teste",
  system: "prompt",
  messages: [],
};

function apiError(statusCode: number, message: string) {
  return Object.assign(new Error(message), {
    name: "AI_APICallError",
    statusCode,
  });
}

describe("generateWithTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passa abortSignal e maxRetries: 0 para o SDK", async () => {
    generateTextMock.mockResolvedValue(OK);

    await generateWithTools(ARGS);

    const passed = generateTextMock.mock.calls[0][0] as {
      abortSignal?: AbortSignal;
      maxRetries?: number;
    };
    expect(passed.maxRetries).toBe(0);
    expect(passed.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("erro transitório (429) → retenta e devolve o texto", async () => {
    generateTextMock
      .mockRejectedValueOnce(apiError(429, "rate limited"))
      .mockResolvedValueOnce(OK);

    const result = await generateWithTools(ARGS);

    expect(result.text).toBe("oi");
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("401 (chave inválida) → NÃO retenta", async () => {
    generateTextMock.mockRejectedValue(apiError(401, "Incorrect API key"));

    await expect(generateWithTools(ARGS)).rejects.toThrow("Incorrect API key");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("timeout: aborta o request de verdade (o signal chega no SDK)", async () => {
    generateTextMock.mockImplementation(
      (args: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          args.abortSignal.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            ),
          );
        }),
    );

    process.env.AI_LLM_TIMEOUT_MS = "20";
    process.env.AI_LLM_MAX_ATTEMPTS = "1";
    try {
      // A exceção sobe pro runner, que grava AIAgentRun FAILED +
      // errorMessage (runner.ts, catch do executeAgentRun).
      await expect(generateWithTools(ARGS)).rejects.toThrow("foi abortada");
    } finally {
      delete process.env.AI_LLM_TIMEOUT_MS;
      delete process.env.AI_LLM_MAX_ATTEMPTS;
    }
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});
