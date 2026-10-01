/**
 * Middleware — achados do pentest externo (Strix):
 *  - vuln-0007: CORS refletindo qualquer `*.bwipo.com` com credenciais;
 *  - vuln-0008: diferencial de resposta por subdomínio (enumeração de slug);
 *  - headers de segurança em toda resposta gerada aqui.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// O middleware lê AUTH_SECRET na carga do módulo.
const getToken = vi.hoisted(() => {
  process.env.AUTH_SECRET = "segredo-de-teste";
  return vi.fn();
});
vi.mock("next-auth/jwt", () => ({ getToken }));

import { resetCorsTenantLookupForTests } from "@/lib/cors-tenant-lookup-edge";
import { baseSecurityHeaders } from "@/lib/security-headers";

import { middleware } from "./middleware";

const fetchMock = vi.fn<typeof fetch>();
const savedEnv = { ...process.env };

/** Orgs que a rota interna diria que são origem confiável. */
const TRUSTED = new Set(["eduit"]);

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; host?: string } = {},
): NextRequest {
  const host = init.host ?? "api.bwipo.com";
  return new NextRequest(`https://${host}${path}`, {
    method: init.method ?? "GET",
    headers: { host, ...(init.headers ?? {}) },
  });
}

beforeEach(() => {
  process.env.TENANT_BASE_DOMAIN = "bwipo.com";
  process.env.AUTH_SECRET = "segredo-de-teste";
  process.env.NEXTAUTH_URL = "https://api.bwipo.com";
  delete process.env.BROWSER_API_CORS_ORIGINS;
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.BROWSER_API_CORS_TRUST_ALL_TENANT_SUBDOMAINS;
  resetCorsTenantLookupForTests();
  getToken.mockReset();
  getToken.mockResolvedValue(null);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const slug = new URL(String(input)).searchParams.get("slug") ?? "";
    return new Response(JSON.stringify({ trusted: TRUSTED.has(slug) }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
});

function expectNoCors(res: Response): void {
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  expect(res.headers.get("Vary") ?? "").toMatch(/\borigin\b/i);
}

describe("CORS (vuln-0007)", () => {
  it.each([
    "https://evil-corp.bwipo.com",
    "https://randomxyzabc123.bwipo.com",
    "https://testcorp-probe.bwipo.com",
    "https://BWIPO.COM",
    "https://bwipo.com:443",
    "https://evil.com",
    "null",
  ])("GET /api/auth/csrf com Origin %s não recebe CORS", async (origin) => {
    const res = await middleware(request("/api/auth/csrf", { headers: { origin } }));
    expectNoCors(res);
  });

  it("/api/auth/session não recebe CORS nem de subdomínio de org válida", async () => {
    const res = await middleware(
      request("/api/auth/session", { headers: { origin: "https://eduit.bwipo.com" } }),
    );
    expectNoCors(res);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("/api/health não recebe CORS (logo, nenhum Allow-Credentials) nem do apex", async () => {
    for (const origin of ["https://bwipo.com", "https://eduit.bwipo.com"]) {
      expectNoCors(await middleware(request("/api/health", { headers: { origin } })));
    }
  });

  it("rota autenticada: subdomínio inexistente não é refletido nem no 401", async () => {
    const res = await middleware(
      request("/api/me", { headers: { origin: "https://evil-corp.bwipo.com" } }),
    );
    expect(res.status).toBe(401);
    expectNoCors(res);
  });

  it("subdomínio de org válida e apex continuam com CORS + credenciais em /api/*", async () => {
    for (const origin of ["https://eduit.bwipo.com", "https://bwipo.com"]) {
      const res = await middleware(request("/api/me", { headers: { origin } }));
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("Vary") ?? "").toMatch(/\borigin\b/i);
    }
  });

  it("preflight: 204 com CORS para org válida; origem negada cai no fluxo normal sem CORS", async () => {
    const ok = await middleware(
      request("/api/contacts", {
        method: "OPTIONS",
        headers: {
          origin: "https://eduit.bwipo.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      }),
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://eduit.bwipo.com");
    expect(ok.headers.get("Access-Control-Allow-Headers")).toBe("content-type");

    const denied = await middleware(
      request("/api/contacts", {
        method: "OPTIONS",
        headers: {
          origin: "https://evil-corp.bwipo.com",
          "access-control-request-method": "POST",
        },
      }),
    );
    expect(denied.status).toBe(401);
    expectNoCors(denied);
  });

  it("caminho quente: muitas chamadas da mesma origem fazem uma consulta só", async () => {
    for (let i = 0; i < 20; i += 1) {
      await middleware(request("/api/me", { headers: { origin: "https://eduit.bwipo.com" } }));
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("request sem Origin não consulta nada e sai com Vary: Origin", async () => {
    const res = await middleware(request("/api/me"));
    expect(fetchMock).not.toHaveBeenCalled();
    expectNoCors(res);
  });

  it("a consulta interna do próprio middleware passa sem sessão (a rota valida a chave)", async () => {
    const res = await middleware(
      request("/api/internal/cors-origin?slug=eduit", { host: "127.0.0.1:3000" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("enumeração de slug (vuln-0008)", () => {
  async function snapshot(res: Response) {
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: await res.text(),
      headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    };
  }

  it("GET /api/me sem sessão: resposta idêntica para subdomínio de org existente e inexistente", async () => {
    const existing = await snapshot(
      await middleware(request("/api/me", { host: "eduit.bwipo.com" })),
    );
    const missing = await snapshot(
      await middleware(request("/api/me", { host: "randomxyz.bwipo.com" })),
    );
    const viaHeader = await snapshot(
      await middleware(
        request("/api/me", { headers: { "x-tenant-slug": "randomxyz" } }),
      ),
    );

    expect(existing.status).toBe(401);
    expect(existing.contentType).toMatch(/^application\/json/);
    expect(JSON.parse(existing.body)).toEqual({
      message: "Unauthorized",
      code: "AUTH_REQUIRED",
    });
    expect(missing).toEqual(existing);
    expect(viaHeader).toEqual(existing);
    // O Host não dispara consulta de existência neste serviço.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("headers de segurança", () => {
  function expectSecurityHeaders(res: Response): void {
    for (const { key, value } of baseSecurityHeaders()) {
      expect(res.headers.get(key), key).toBe(value);
    }
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
  }

  it("401 JSON, 403 de /api/admin, preflight, rota pública e passagem levam todos", async () => {
    expectSecurityHeaders(await middleware(request("/api/me")));
    expectSecurityHeaders(await middleware(request("/api/health")));
    expectSecurityHeaders(await middleware(request("/api/rota-que-nao-existe")));
    expectSecurityHeaders(
      await middleware(
        request("/api/contacts", {
          method: "OPTIONS",
          headers: { origin: "https://eduit.bwipo.com" },
        }),
      ),
    );

    getToken.mockResolvedValue({ id: "user_1", isSuperAdmin: false });
    const forbidden = await middleware(request("/api/admin/organizations"));
    expect(forbidden.status).toBe(403);
    expectSecurityHeaders(forbidden);
    expectSecurityHeaders(await middleware(request("/api/me")));
  });
});
