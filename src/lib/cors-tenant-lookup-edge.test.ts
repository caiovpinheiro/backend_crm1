import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CORS_LOOKUP_KEY_HEADER,
  CORS_LOOKUP_PATH,
  deriveCorsLookupKey,
  lookupTenantOriginFromEdge,
  resetCorsTenantLookupForTests,
} from "./cors-tenant-lookup-edge";

const fetchMock = vi.fn<typeof fetch>();
const savedEnv = { ...process.env };

function answer(trusted: boolean): Response {
  return new Response(JSON.stringify({ trusted }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchMock.mockReset();
  resetCorsTenantLookupForTests();
  process.env.AUTH_SECRET = "segredo-de-teste";
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.CORS_LOOKUP_BASE_URL;
  process.env.PORT = "3000";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

describe("lookupTenantOriginFromEdge", () => {
  it("consulta a rota interna em loopback com a chave derivada do AUTH_SECRET", async () => {
    fetchMock.mockResolvedValueOnce(answer(true));
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:3000${CORS_LOOKUP_PATH}?slug=eduit`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers[CORS_LOOKUP_KEY_HEADER]).toBe(await deriveCorsLookupKey());
    expect(headers[CORS_LOOKUP_KEY_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers[CORS_LOOKUP_KEY_HEADER]).not.toContain("segredo-de-teste");
  });

  it("caminho quente: resposta positiva fica 60 s em memória, sem nova consulta", async () => {
    fetchMock.mockImplementation(async () => answer(true));
    for (let i = 0; i < 50; i += 1) {
      expect(await lookupTenantOriginFromEdge("eduit")).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_000);
    await lookupTenantOriginFromEdge("eduit");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await lookupTenantOriginFromEdge("eduit");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cache negativo curto (10 s): org nova vira confiável logo após verificar o e-mail", async () => {
    fetchMock.mockResolvedValueOnce(answer(false));
    expect(await lookupTenantOriginFromEdge("nova")).toBe(false);
    expect(await lookupTenantOriginFromEdge("nova")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);
    fetchMock.mockResolvedValueOnce(answer(true));
    expect(await lookupTenantOriginFromEdge("nova")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("chamadas simultâneas do mesmo slug compartilham uma consulta", async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const all = Promise.all([
      lookupTenantOriginFromEdge("eduit"),
      lookupTenantOriginFromEdge("eduit"),
      lookupTenantOriginFromEdge("eduit"),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    release(answer(true));
    expect(await all).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("erro de rede ou 5xx nega a origem e tenta de novo em 3 s", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(false);
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(3_001);
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 503 }));
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(false);

    vi.advanceTimersByTime(3_001);
    fetchMock.mockResolvedValueOnce(answer(true));
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("origem confirmada há pouco segue confiável se a consulta falhar; um não explícito derruba na hora", async () => {
    fetchMock.mockResolvedValueOnce(answer(true));
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(true);

    vi.advanceTimersByTime(61_000);
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(true);

    vi.advanceTimersByTime(3_001);
    fetchMock.mockResolvedValueOnce(answer(false));
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(false);

    // Passada a tolerância (10 min sem confirmação), falha volta a negar.
    resetCorsTenantLookupForTests();
    fetchMock.mockResolvedValueOnce(answer(true));
    expect(await lookupTenantOriginFromEdge("acme")).toBe(true);
    vi.advanceTimersByTime(10 * 60_000 + 1);
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await lookupTenantOriginFromEdge("acme")).toBe(false);
  });

  it("flood de subdomínios aleatórios: teto de consultas por segundo e positivos preservados", async () => {
    fetchMock.mockImplementation(async (input) =>
      answer(new URL(String(input)).searchParams.get("slug") === "eduit"),
    );
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(true);

    for (let i = 0; i < 5_000; i += 1) {
      expect(await lookupTenantOriginFromEdge(`flood-${i}`)).toBe(false);
    }
    // 1 (eduit) + no máximo o teto de 40 consultas no mesmo segundo.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(41);
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(true);

    // Janela seguinte: volta a consultar.
    vi.advanceTimersByTime(1_001);
    const before = fetchMock.mock.calls.length;
    await lookupTenantOriginFromEdge("flood-novo");
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });

  it("resposta sem `trusted: true` literal é negativa", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ trusted: "true" }), { status: 200 }),
    );
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(false);
  });

  it("sem AUTH_SECRET não consulta e nega", async () => {
    delete process.env.AUTH_SECRET;
    expect(await deriveCorsLookupKey()).toBeNull();
    expect(await lookupTenantOriginFromEdge("eduit")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("CORS_LOOKUP_BASE_URL troca a base do loopback", async () => {
    process.env.CORS_LOOKUP_BASE_URL = "http://backend.internal:8080/";
    fetchMock.mockResolvedValueOnce(answer(true));
    await lookupTenantOriginFromEdge("eduit");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://backend.internal:8080${CORS_LOOKUP_PATH}?slug=eduit`,
    );
  });
});
