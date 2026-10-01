import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isTrusted = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cors-tenant-origin", () => ({
  isTrustedTenantOriginSlug: isTrusted,
}));

import {
  CORS_LOOKUP_KEY_HEADER,
  deriveCorsLookupKey,
  resetCorsTenantLookupForTests,
} from "@/lib/cors-tenant-lookup-edge";

import { GET } from "./route";

const savedSecret = process.env.AUTH_SECRET;

function req(slug: string, key?: string): Request {
  return new Request(`http://127.0.0.1:3000/api/internal/cors-origin?slug=${slug}`, {
    headers: key ? { [CORS_LOOKUP_KEY_HEADER]: key } : {},
  });
}

beforeEach(() => {
  process.env.AUTH_SECRET = "segredo-de-teste";
  resetCorsTenantLookupForTests();
  isTrusted.mockReset();
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

describe("GET /api/internal/cors-origin", () => {
  it("sem a chave interna (ou com chave errada) responde 404 e não consulta", async () => {
    expect((await GET(req("eduit"))).status).toBe(404);
    expect((await GET(req("eduit", "0".repeat(64)))).status).toBe(404);
    expect(isTrusted).not.toHaveBeenCalled();
  });

  it("sem AUTH_SECRET configurado, 404 mesmo com header", async () => {
    const key = (await deriveCorsLookupKey())!;
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    resetCorsTenantLookupForTests();
    expect((await GET(req("eduit", key))).status).toBe(404);
  });

  it("com a chave devolve { trusted }", async () => {
    const key = (await deriveCorsLookupKey())!;
    isTrusted.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const yes = await GET(req("eduit", key));
    expect(yes.status).toBe(200);
    expect(await yes.json()).toEqual({ trusted: true });
    expect(isTrusted).toHaveBeenCalledWith("eduit");

    const no = await GET(req("evil-corp", key));
    expect(await no.json()).toEqual({ trusted: false });
  });

  it("falha do banco vira 503 (o middleware nega a origem e tenta de novo)", async () => {
    const key = (await deriveCorsLookupKey())!;
    isTrusted.mockRejectedValueOnce(new Error("banco fora"));
    expect((await GET(req("eduit", key))).status).toBe(503);
  });
});
