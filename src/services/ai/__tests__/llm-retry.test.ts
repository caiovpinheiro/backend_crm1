import { describe, expect, it, vi } from "vitest";

import {
  callLlmWithRetry,
  isTransientLlmError,
  LlmTimeoutError,
  backoffMs,
} from "@/services/ai/llm-retry";

/** Erro no formato que o AI SDK devolve (APICallError). */
function apiError(statusCode: number, message = "erro da OpenAI") {
  return Object.assign(new Error(message), {
    name: "AI_APICallError",
    statusCode,
  });
}

const noSleep = async () => {};

describe("isTransientLlmError", () => {
  it("429 (rate limit) e 5xx são transitórios", () => {
    expect(isTransientLlmError(apiError(429))).toBe(true);
    expect(isTransientLlmError(apiError(500))).toBe(true);
    expect(isTransientLlmError(apiError(502))).toBe(true);
    expect(isTransientLlmError(apiError(503))).toBe(true);
    expect(isTransientLlmError(apiError(408))).toBe(true);
  });

  it("timeout é transitório", () => {
    expect(isTransientLlmError(new LlmTimeoutError(60_000))).toBe(true);
    expect(
      isTransientLlmError(
        Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
      ),
    ).toBe(true);
  });

  it("erro de rede é transitório", () => {
    expect(
      isTransientLlmError(
        Object.assign(new Error("fetch failed"), {
          cause: Object.assign(new Error("read ECONNRESET"), {
            code: "ECONNRESET",
          }),
        }),
      ),
    ).toBe(true);
  });

  it("401 e 403 (chave inválida) NÃO são transitórios", () => {
    expect(isTransientLlmError(apiError(401, "Incorrect API key"))).toBe(false);
    expect(isTransientLlmError(apiError(403))).toBe(false);
  });

  it("erro de validação NÃO é transitório", () => {
    expect(isTransientLlmError(apiError(400, "invalid request"))).toBe(false);
    expect(
      isTransientLlmError(
        Object.assign(new Error("schema inválido"), {
          name: "AI_TypeValidationError",
        }),
      ),
    ).toBe(false);
  });

  it("erro desconhecido NÃO é retentado (default conservador)", () => {
    expect(isTransientLlmError(new Error("deu ruim"))).toBe(false);
    expect(isTransientLlmError(undefined)).toBe(false);
  });
});

describe("callLlmWithRetry", () => {
  it("erro transitório → retenta e devolve o sucesso", async () => {
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(apiError(429))
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce("ok");

    const out = await callLlmWithRetry(fn, {
      maxAttempts: 3,
      sleepFn: noSleep,
    });

    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("401 → NÃO retenta, falha na primeira", async () => {
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValue(apiError(401, "Incorrect API key provided"));

    await expect(
      callLlmWithRetry(fn, { maxAttempts: 3, sleepFn: noSleep }),
    ).rejects.toThrow("Incorrect API key provided");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("erro de validação → NÃO retenta", async () => {
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValue(apiError(400, "invalid tool schema"));

    await expect(
      callLlmWithRetry(fn, { maxAttempts: 3, sleepFn: noSleep }),
    ).rejects.toThrow("invalid tool schema");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("timeout aborta a tentativa e sobe LlmTimeoutError com mensagem clara", async () => {
    // Nunca resolve: só termina quando o AbortSignal dispara.
    const fn = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            ),
          );
        }),
    );

    const err = await callLlmWithRetry(fn, {
      timeoutMs: 20,
      maxAttempts: 2,
      sleepFn: noSleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect((err as Error).message).toContain("foi abortada");
    // Timeout é transitório: gastou as 2 tentativas antes de desistir.
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("esgota as tentativas e sobe o último erro transitório", async () => {
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValue(apiError(500, "upstream caiu"));

    await expect(
      callLlmWithRetry(fn, { maxAttempts: 3, sleepFn: noSleep }),
    ).rejects.toThrow("upstream caiu");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respeita Retry-After em vez do backoff", async () => {
    const waits: number[] = [];
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(apiError(429, "rate limited"), {
          responseHeaders: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce("ok");

    await callLlmWithRetry(fn, {
      maxAttempts: 2,
      sleepFn: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([2000]);
  });

  it("chama fn uma única vez quando dá certo de primeira", async () => {
    const fn = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockResolvedValue("ok");

    expect(await callLlmWithRetry(fn, { sleepFn: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("backoffMs", () => {
  it("cresce exponencialmente e tem jitter dentro da faixa", () => {
    for (const [attempt, min] of [
      [1, 500],
      [2, 1000],
      [3, 2000],
    ] as const) {
      const ms = backoffMs(attempt, 500);
      expect(ms).toBeGreaterThanOrEqual(min);
      expect(ms).toBeLessThanOrEqual(min * 1.5);
    }
  });
});
