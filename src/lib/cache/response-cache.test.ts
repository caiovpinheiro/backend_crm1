/**
 * Respostas de inicialização em cache (`response-cache.ts`): chave por org
 * + versão + variante, ETag guardado com o corpo, 304 sem carregar nada e
 * invalidação por bump da família.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  // Sem memória da versão: o bump de um "processo" vale na hora para o teste.
  process.env.CACHE_VERSION_MEMO_MS = "0";
  return {
    redis: {
      store: new Map<string, { value: string; expiresAt: number | null }>(),
      calls: [] as string[],
      down: false,
    },
  };
});

vi.mock("ioredis", async () =>
  (await import("@/test-setup/fake-cache-redis")).fakeIoredisModule(h.redis),
);
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { resetCacheVersionsForTests } from "@/lib/cache/versions";
import {
  RESPONSE_FAMILIES,
  bumpResponseFamilies,
  computeResponseEtag,
  etagMatches,
  loadCachedResponse,
  peekResponseEtag,
  resetResponseCacheMemoForTests,
  respondWithCachedJson,
  responseCacheKey,
  type CachedResponseSpec,
} from "@/lib/cache/response-cache";
import { ServerTiming } from "@/lib/server-timing";

beforeEach(() => {
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  resetCacheVersionsForTests();
  resetResponseCacheMemoForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function spec(
  orgId: string,
  data: unknown,
  extra: Partial<CachedResponseSpec> = {},
): CachedResponseSpec & { load: ReturnType<typeof vi.fn> } {
  const load = vi.fn(async () => data);
  return {
    name: "channels",
    orgId,
    families: [RESPONSE_FAMILIES.channels],
    ...extra,
    load,
  } as CachedResponseSpec & { load: ReturnType<typeof vi.fn> };
}

function req(ifNoneMatch?: string): Request {
  return new Request("http://localhost/api/channels", {
    headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {},
  });
}

describe("response-cache — corpo e ETag", () => {
  it("miss roda o loader uma vez; hit devolve o mesmo corpo e ETag", async () => {
    const s = spec("org_a", { channels: [{ id: "c1" }] });
    const first = await loadCachedResponse(s);
    expect(first.source).toBe("miss");
    expect(first.body).toBe('{"channels":[{"id":"c1"}]}');
    expect(first.etag).toBe(computeResponseEtag("org_a", first.body));
    expect(first.etag.startsWith('W/"')).toBe(true);

    resetResponseCacheMemoForTests();
    const second = await loadCachedResponse(s);
    expect(second).toMatchObject({ source: "hit", body: first.body, etag: first.etag });
    expect(s.load).toHaveBeenCalledTimes(1);
  });

  it("200 com ETag e Cache-Control private, no-cache; 304 quando If-None-Match bate", async () => {
    const s = spec("org_a", { channels: [] });
    const timing = new ServerTiming();
    const ok = await respondWithCachedJson(req(), s, timing);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-cache");
    expect(ok.headers.get("content-type")).toContain("application/json");
    expect(ok.headers.get("server-timing")).toMatch(/cache;dur=[\d.]+;desc="miss"/);
    const etag = ok.headers.get("etag")!;
    expect(await ok.text()).toBe('{"channels":[]}');

    const t304 = new ServerTiming();
    const notModified = await respondWithCachedJson(req(etag), s, t304);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    expect(notModified.headers.get("cache-control")).toBe("private, no-cache");
    expect(notModified.headers.get("server-timing")).toMatch(/cache;dur=[\d.]+;desc="304"/);
    expect(await notModified.text()).toBe("");
    expect(s.load).toHaveBeenCalledTimes(1);
  });

  it("304 não lê o corpo do Redis nem roda o loader (só versão + ETag)", async () => {
    const s = spec("org_a", { channels: [{ id: "c1" }] });
    const etag = (await loadCachedResponse(s)).etag;
    const key = await responseCacheKey(s);

    // Outro processo: sem memória do ETag — vai ao Redis, mas só na chave pequena.
    resetResponseCacheMemoForTests();
    h.redis.calls.length = 0;
    const res = await respondWithCachedJson(req(etag), s);
    expect(res.status).toBe(304);
    const gets = h.redis.calls.filter((c) => c.startsWith("GET "));
    expect(gets).toContain(`GET cache:${key}:etag`);
    expect(gets).not.toContain(`GET cache:${key}`);
    expect(s.load).toHaveBeenCalledTimes(1);

    // Mesmo processo: ETag na memória — nenhuma ida ao Redis além da versão.
    h.redis.calls.length = 0;
    const again = await respondWithCachedJson(req(etag), s);
    expect(again.status).toBe(304);
    expect(h.redis.calls.filter((c) => c.includes(":etag") || c === `GET cache:${key}`)).toEqual([]);
  });

  it("If-None-Match diferente → 200 com corpo", async () => {
    const s = spec("org_a", { channels: [] });
    const res = await respondWithCachedJson(req('W/"outro"'), s);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"channels":[]}');
  });

  it("etagMatches: lista, prefixo W/ e *", () => {
    expect(etagMatches('"a", W/"b"', 'W/"b"')).toBe(true);
    expect(etagMatches('"b"', 'W/"b"')).toBe(true);
    expect(etagMatches("*", 'W/"b"')).toBe(true);
    expect(etagMatches('"c"', 'W/"b"')).toBe(false);
    expect(etagMatches(null, 'W/"b"')).toBe(false);
  });
});

describe("response-cache — invalidação", () => {
  it("bump da família: próxima leitura traz o dado novo e o ETag muda", async () => {
    let data: unknown = { channels: [{ id: "c1", name: "Antigo" }] };
    const s: CachedResponseSpec = {
      name: "channels",
      orgId: "org_a",
      families: [RESPONSE_FAMILIES.channels],
      load: vi.fn(async () => data),
    };
    const first = await respondWithCachedJson(req(), s);
    const etag1 = first.headers.get("etag")!;

    data = { channels: [{ id: "c1", name: "Novo" }] };
    await bumpResponseFamilies("org_a", RESPONSE_FAMILIES.channels);

    const second = await respondWithCachedJson(req(etag1), s);
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag1);
    expect(await second.json()).toEqual(data);
  });

  it("bump de outra família ou de outra org não invalida", async () => {
    const s = spec("org_a", { channels: [] });
    const k1 = await responseCacheKey(s);
    await bumpResponseFamilies("org_a", RESPONSE_FAMILIES.pipelines);
    await bumpResponseFamilies("org_b", RESPONSE_FAMILIES.channels);
    expect(await responseCacheKey(s)).toBe(k1);
    await bumpResponseFamilies("org_a", RESPONSE_FAMILIES.channels);
    expect(await responseCacheKey(s)).not.toBe(k1);
  });

  it("bump sem org é no-op e nunca lança (Redis fora)", async () => {
    await expect(bumpResponseFamilies(null, RESPONSE_FAMILIES.users)).resolves.toBeUndefined();
    h.redis.down = true;
    await expect(
      bumpResponseFamilies("org_a", RESPONSE_FAMILIES.users),
    ).resolves.toBeUndefined();
  });
});

describe("response-cache — isolamento", () => {
  it("org A nunca lê a chave, o corpo ou o ETag da org B (mesma variante, mesmos ids)", async () => {
    const same = { pipelines: [{ id: "p1", name: "Funil" }] };
    const a = spec("org_a", same, { name: "pipelines", families: [RESPONSE_FAMILIES.pipelines], variant: "perfil-x" });
    const b = spec("org_b", same, { name: "pipelines", families: [RESPONSE_FAMILIES.pipelines], variant: "perfil-x" });

    const resB = await loadCachedResponse(b);
    expect(await responseCacheKey(a)).not.toBe(resB.key);
    expect(await peekResponseEtag(await responseCacheKey(a))).toBeUndefined();

    // ETag da org B não vale como 304 para a org A, mesmo com corpo idêntico.
    const resA = await respondWithCachedJson(req(resB.etag), a);
    expect(resA.status).toBe(200);
    expect(resA.headers.get("etag")).not.toBe(resB.etag);
    expect(a.load).toHaveBeenCalledTimes(1);
    expect(b.load).toHaveBeenCalledTimes(1);
  });

  it("variantes (perfis) diferentes na mesma org não compartilham entrada", async () => {
    const admin = spec("org_a", { pipelines: ["p1", "p2"] }, { variant: "admin" });
    const member = spec("org_a", { pipelines: ["p1"] }, { variant: "member" });
    const adminRes = await loadCachedResponse(admin);
    const memberRes = await loadCachedResponse(member);
    expect(adminRes.key).not.toBe(memberRes.key);
    expect(memberRes.body).toBe('{"pipelines":["p1"]}');
    expect(member.load).toHaveBeenCalledTimes(1);

    const cross = await respondWithCachedJson(req(adminRes.etag), member);
    expect(cross.status).toBe(200);
    expect(await cross.text()).toBe('{"pipelines":["p1"]}');
  });

  it("mesma variante na mesma org compartilha (um loader só)", async () => {
    const u1 = spec("org_a", { x: 1 }, { variant: "perfil" });
    const u2 = spec("org_a", { x: 1 }, { variant: "perfil" });
    await loadCachedResponse(u1);
    const second = await loadCachedResponse(u2);
    expect(second.source).toBe("hit");
    expect(u2.load).not.toHaveBeenCalled();
  });
});
