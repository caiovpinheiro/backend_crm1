import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import { MediaTooLargeError } from "./media-byte-limits";
import { SafeFetchError, hostMatchesAllowlist, safeFetch, safeFetchBytes } from "./safe-fetch";

const PUBLIC_IP = { address: "93.184.216.34", family: 4 };
const fetchMock = vi.fn();

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockImplementation(async (host: string) => {
    if (host.startsWith("internal.")) return [{ address: "10.0.0.8", family: 4 }];
    return [PUBLIC_IP];
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("safeFetch — bloqueios antes de qualquer requisição", () => {
  it("recusa URL interna (IP literal e hostname) sem chamar fetch", async () => {
    await expect(safeFetch("http://127.0.0.1/admin")).rejects.toMatchObject({
      name: "SafeFetchError",
      code: "blocked_url",
    });
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SafeFetchError,
    );
    await expect(safeFetch("http://localhost:80/")).rejects.toBeInstanceOf(SafeFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa hostname público que resolve para IP privado", async () => {
    await expect(safeFetch("https://internal.example.com/hook")).rejects.toMatchObject({
      code: "blocked_url",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa porta fora da allowlist", async () => {
    await expect(safeFetch("https://example.com:8443/hook")).rejects.toMatchObject({
      code: "blocked_url",
      message: expect.stringMatching(/porta 8443/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa host fora da allowlist de hosts", async () => {
    await expect(
      safeFetch("https://evil.example.com/a.jpg", {}, { allowedHosts: ["pps.whatsapp.net", "*.fbcdn.net"] }),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("safeFetch — sucesso em URL pública", () => {
  it("chama fetch com redirect manual, método/corpo/headers e sinal de abort", async () => {
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await safeFetch(
      "https://hooks.example.com/n8n",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
      { timeoutMs: 5_000 },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/n8n");
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("respeita allowlist de hosts com curinga de subdomínio", async () => {
    fetchMock.mockResolvedValue(new Response("img", { status: 200 }));
    const res = await safeFetch(
      "https://scontent.fbcdn.net/x.jpg",
      {},
      { allowedHosts: ["*.fbcdn.net"] },
    );
    expect(res.status).toBe(200);
  });

  it("aborta por timeout", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(safeFetch("https://slow.example.com/", {}, { timeoutMs: 30 })).rejects.toThrow(
      /timeout/i,
    );
  });
});

describe("safeFetch — redirects", () => {
  it("por padrão recusa qualquer 3xx sem seguir", async () => {
    fetchMock.mockResolvedValue(redirect(302, "https://other.example.com/"));
    await expect(safeFetch("https://example.com/")).rejects.toMatchObject({
      code: "redirect_refused",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recusa redirect para IP interno mesmo com maxRedirects > 0", async () => {
    fetchMock.mockResolvedValueOnce(redirect(302, "http://127.0.0.1:80/internal"));
    await expect(safeFetch("https://example.com/", {}, { maxRedirects: 3 })).rejects.toMatchObject({
      code: "redirect_refused",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recusa redirect para hostname que resolve em IP privado", async () => {
    fetchMock.mockResolvedValueOnce(redirect(301, "https://internal.example.com/"));
    await expect(safeFetch("https://example.com/", {}, { maxRedirects: 3 })).rejects.toMatchObject({
      code: "redirect_refused",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recusa redirect para porta bloqueada e para host fora da allowlist", async () => {
    fetchMock.mockResolvedValueOnce(redirect(307, "https://example.com:8080/"));
    await expect(safeFetch("https://example.com/", {}, { maxRedirects: 3 })).rejects.toMatchObject({
      code: "redirect_refused",
    });

    fetchMock.mockResolvedValueOnce(redirect(302, "https://evil.example.com/"));
    await expect(
      safeFetch("https://pps.whatsapp.net/x", {}, { maxRedirects: 2, allowedHosts: ["*.whatsapp.net"] }),
    ).rejects.toMatchObject({ code: "redirect_refused" });
  });

  it("segue redirect público revalidado, até o limite", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(301, "/v2/hook"))
      .mockResolvedValueOnce(redirect(308, "https://cdn.example.com/final"))
      .mockResolvedValueOnce(new Response("done", { status: 200 }));
    const res = await safeFetch(
      "https://example.com/hook",
      { method: "POST", body: "x", headers: { Authorization: "Bearer t", "Content-Type": "text/plain" } },
      { maxRedirects: 3 },
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      "https://example.com/hook",
      "https://example.com/v2/hook",
      "https://cdn.example.com/final",
    ]);
    // 301 com POST vira GET sem corpo; salto para outra origem perde Authorization.
    const second = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(second.method).toBe("GET");
    expect(second.body).toBeUndefined();
    expect(new Headers(second.headers).get("authorization")).toBe("Bearer t");
    const third = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(new Headers(third.headers).get("authorization")).toBeNull();
    // Cada salto foi validado via DNS.
    expect(lookupMock.mock.calls.map((c) => c[0])).toEqual([
      "example.com",
      "example.com",
      "cdn.example.com",
    ]);
  });

  it("307/308 preservam método e corpo", async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(307, "https://example.com/b"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await safeFetch("https://example.com/a", { method: "POST", body: "payload" }, { maxRedirects: 1 });
    const second = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(second.method).toBe("POST");
    expect(second.body).toBe("payload");
  });

  it("estoura o limite de saltos", async () => {
    fetchMock.mockResolvedValue(redirect(302, "https://example.com/loop"));
    await expect(safeFetch("https://example.com/", {}, { maxRedirects: 2 })).rejects.toMatchObject({
      code: "too_many_redirects",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("3xx sem Location é erro", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302 }));
    await expect(safeFetch("https://example.com/", {}, { maxRedirects: 1 })).rejects.toMatchObject({
      code: "bad_redirect",
    });
  });
});

describe("safeFetchBytes", () => {
  it("devolve o corpo dentro do limite", async () => {
    fetchMock.mockResolvedValue(new Response("abc", { status: 200 }));
    const { response, buffer } = await safeFetchBytes("https://example.com/f", {}, { maxBytes: 10 });
    expect(response.ok).toBe(true);
    expect(buffer.toString()).toBe("abc");
  });

  it("lança MediaTooLargeError acima do limite", async () => {
    fetchMock.mockResolvedValue(new Response("x".repeat(64), { status: 200 }));
    await expect(safeFetchBytes("https://example.com/f", {}, { maxBytes: 16 })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
  });

  it("resposta não-ok volta com buffer vazio, sem lançar", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const { response, buffer } = await safeFetchBytes("https://example.com/f", {}, { maxBytes: 16 });
    expect(response.status).toBe(404);
    expect(buffer.length).toBe(0);
  });
});

describe("hostMatchesAllowlist", () => {
  it("casa exato e curinga de subdomínio (não o domínio raiz)", () => {
    expect(hostMatchesAllowlist("pps.whatsapp.net", ["pps.whatsapp.net"])).toBe(true);
    expect(hostMatchesAllowlist("PPS.whatsapp.net.", ["pps.whatsapp.net"])).toBe(true);
    expect(hostMatchesAllowlist("a.b.fbcdn.net", ["*.fbcdn.net"])).toBe(true);
    expect(hostMatchesAllowlist("fbcdn.net", ["*.fbcdn.net"])).toBe(false);
    expect(hostMatchesAllowlist("notfbcdn.net", ["*.fbcdn.net"])).toBe(false);
    expect(hostMatchesAllowlist("evil.com", ["*.fbcdn.net", "graph.facebook.com"])).toBe(false);
  });
});
