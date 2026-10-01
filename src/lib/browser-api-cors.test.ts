/**
 * Pentest (vuln-0007): o CORS refletia qualquer `Origin` `*.bwipo.com` com
 * `Access-Control-Allow-Credentials: true`. Cada origem do relatório tem um
 * caso aqui.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyBrowserApiOrigin,
  corsPathPolicy,
  resolveBrowserApiCorsOrigin,
  writeBrowserApiCorsHeaders,
  type TenantOriginLookup,
} from "./browser-api-cors";

const ENV_KEYS = [
  "TENANT_BASE_DOMAIN",
  "BROWSER_API_CORS_ORIGINS",
  "ALLOWED_ORIGINS",
  "BROWSER_API_CORS_TRUST_ALL_TENANT_SUBDOMAINS",
] as const;
const saved: Record<string, string | undefined> = {};

/** Orgs que existem, estão ativas e têm admin verificado. */
const TRUSTED = new Set(["eduit", "acme"]);
const lookup = vi.fn<TenantOriginLookup>(async (slug) => TRUSTED.has(slug));

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TENANT_BASE_DOMAIN = "bwipo.com";
  lookup.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const resolve = (origin: string | null, path = "/api/me") =>
  resolveBrowserApiCorsOrigin(origin, path, lookup);

describe("origens do relatório do pentest", () => {
  it.each([
    ["subdomínio inexistente", "https://evil-corp.bwipo.com"],
    ["subdomínio aleatório", "https://randomxyzabc123.bwipo.com"],
    ["org recém-criada sem e-mail verificado", "https://testcorp-probe.bwipo.com"],
    ["controlado pelo atacante", "https://attacker-controlled.bwipo.com"],
  ])("%s não é refletido", async (_label, origin) => {
    expect(await resolve(origin)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["apex em maiúsculas", "https://BWIPO.COM"],
    ["apex com porta explícita", "https://bwipo.com:443"],
    ["tenant válido em maiúsculas", "https://EDUIT.bwipo.com"],
    ["tenant válido com porta explícita", "https://eduit.bwipo.com:443"],
    ["tenant válido em porta fora do padrão", "https://eduit.bwipo.com:8443"],
    ["http em produção", "http://eduit.bwipo.com"],
    ["barra final", "https://bwipo.com/"],
    ["com path", "https://bwipo.com/login"],
    ["com credenciais", "https://user:pass@bwipo.com"],
    ["subdomínio de vários níveis", "https://a.eduit.bwipo.com"],
    ["sufixo parecido", "https://evilbwipo.com"],
    ["base como prefixo", "https://bwipo.com.evil.com"],
    ["outro domínio", "https://evil.com"],
    ["null", "null"],
    ["lixo", "not-an-origin"],
  ])("%s é recusado sem consultar nada", async (_label, origin) => {
    expect(classifyBrowserApiOrigin(origin)).toBeNull();
    expect(await resolve(origin)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("sem header Origin não há CORS", async () => {
    expect(await resolve(null)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("origens permitidas", () => {
  it("apex e www exatos, sem consulta", async () => {
    expect(await resolve("https://bwipo.com")).toBe("https://bwipo.com");
    expect(await resolve("https://www.bwipo.com")).toBe("https://www.bwipo.com");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("subdomínio de org existente, ativa e verificada", async () => {
    expect(await resolve("https://eduit.bwipo.com")).toBe("https://eduit.bwipo.com");
    expect(lookup).toHaveBeenCalledWith("eduit");
  });

  it("falha na consulta nega a origem", async () => {
    const failing: TenantOriginLookup = async () => {
      throw new Error("banco fora");
    };
    expect(
      await resolveBrowserApiCorsOrigin("https://eduit.bwipo.com", "/api/me", failing),
    ).toBeNull();
  });

  it("extras de env: origem exata; host puro só em https na porta padrão", async () => {
    process.env.BROWSER_API_CORS_ORIGINS = "https://Front.Example.com/, http://localhost:3001";
    process.env.ALLOWED_ORIGINS = "painel.example.org,*";
    expect(await resolve("https://front.example.com")).toBe("https://front.example.com");
    expect(await resolve("http://localhost:3001")).toBe("http://localhost:3001");
    expect(await resolve("https://painel.example.org")).toBe("https://painel.example.org");
    expect(await resolve("http://painel.example.org")).toBeNull();
    expect(await resolve("https://painel.example.org:8443")).toBeNull();
    expect(await resolve("http://front.example.com")).toBeNull();
    expect(await resolve("https://outro.example.com")).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("dev local (base localhost): http e qualquer porta, sem consulta", async () => {
    process.env.TENANT_BASE_DOMAIN = "localhost";
    expect(await resolve("http://localhost:3000")).toBe("http://localhost:3000");
    expect(await resolve("http://acme.localhost:3000")).toBe("http://acme.localhost:3000");
    expect(await resolve("https://evil.com")).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("localhost não vale quando a base é o domínio de produção", async () => {
    expect(await resolve("http://localhost:3000")).toBeNull();
  });

  it("volta de emergência libera subdomínio sem consulta, mas mantém a normalização", async () => {
    process.env.BROWSER_API_CORS_TRUST_ALL_TENANT_SUBDOMAINS = "1";
    expect(await resolve("https://qualquer.bwipo.com")).toBe("https://qualquer.bwipo.com");
    expect(await resolve("https://BWIPO.COM")).toBeNull();
    expect(await resolve("https://qualquer.bwipo.com:443")).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("política por caminho", () => {
  it.each([
    "/api/health",
    "/api/cron/sweep",
    "/api/webhooks/meta",
    "/api/metrics",
    "/api/internal/cors-origin",
    "/api/csp-report",
  ])("%s não recebe CORS nem do apex", async (path) => {
    expect(corsPathPolicy(path)).toBe("none");
    expect(await resolve("https://bwipo.com", path)).toBeNull();
    expect(await resolve("https://eduit.bwipo.com", path)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "/api/auth/csrf",
    "/api/auth/session",
    "/api/auth/providers",
    "/api/auth/callback/credentials",
  ])(
    "%s: subdomínio de tenant (mesmo válido) não recebe CORS; apex e extras sim",
    async (path) => {
      process.env.BROWSER_API_CORS_ORIGINS = "https://front.example.com";
      expect(corsPathPolicy(path)).toBe("first-party");
      expect(await resolve("https://eduit.bwipo.com", path)).toBeNull();
      expect(await resolve("https://evil-corp.bwipo.com", path)).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
      expect(await resolve("https://bwipo.com", path)).toBe("https://bwipo.com");
      expect(await resolve("https://front.example.com", path)).toBe(
        "https://front.example.com",
      );
    },
  );

  it("prefixo parecido não herda a política", () => {
    expect(corsPathPolicy("/api/healthz")).toBe("tenant");
    expect(corsPathPolicy("/api/authz")).toBe("tenant");
    expect(corsPathPolicy("/api/me")).toBe("tenant");
  });
});

describe("writeBrowserApiCorsHeaders", () => {
  const request = { headers: new Headers({ origin: "https://eduit.bwipo.com" }) };

  it("origem negada: só Vary: Origin, sem Allow-Credentials", () => {
    const res = { headers: new Headers() };
    writeBrowserApiCorsHeaders(request, res, null);
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("origem permitida: reflete a origem decidida e preserva o Vary existente", () => {
    const res = { headers: new Headers({ Vary: "Accept-Encoding" }) };
    writeBrowserApiCorsHeaders(request, res, "https://eduit.bwipo.com");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://eduit.bwipo.com");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding, Origin");
  });

  it("não duplica Origin no Vary", () => {
    const res = { headers: new Headers({ Vary: "origin" }) };
    writeBrowserApiCorsHeaders(request, res, null);
    expect(res.headers.get("Vary")).toBe("origin");
  });
});
