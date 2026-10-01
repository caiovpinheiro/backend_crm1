/**
 * Invalidação por versão nas famílias de `keys.ts` (Redis falso em
 * memória, timers falsos).
 *
 * - Board, contadores do inbox, catálogo de templates e lookups de canal
 *   invalidam com INCR: nenhum SCAN.
 * - Uma org não invalida a outra.
 * - A versão é lida uma vez por janela, não a cada leitura do valor.
 * - Redis fora: o fallback em memória segue a mesma regra.
 * - Nenhum arquivo da aplicação chama `cache.delPattern`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.REDIS_URL = "redis://fake-redis.localhost:6379";
  delete process.env.REDIS_CACHE_URL;
  delete process.env.REDIS_CACHE_DB;
  delete process.env.CACHE_VERSION_MEMO_MS;
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

import { cache } from "@/lib/cache";
import {
  BOARD_INVALIDATION_WINDOW_MS,
  boardDataKey,
  inboxTabCountsHistKey,
  inboxTabCountsKey,
  invalidateBoardData,
  invalidateChannelLookups,
  invalidateInboxTabCounts,
  invalidateOrgBoards,
  invalidateWhatsappTemplateCatalog,
  metaWebhookMessagingKey,
  metaWebhookPhoneKey,
  metaWebhookSecretsKey,
  scheduleBoardInvalidation,
  scheduleTabCountsInvalidation,
  webhookContextKey,
  whatsappTemplateCatalogKey,
  wrapChannelLookup,
} from "@/lib/cache/keys";
import { resetCacheVersionsForTests } from "@/lib/cache/versions";
import { fakeRedisCalls } from "@/test-setup/fake-cache-redis";

const START = new Date("2026-01-01T12:00:00.000Z");
const FP = "a".repeat(20);

async function seedBoard(orgId: string, pipelineId: string, variant = "v") {
  await cache.set(
    await boardDataKey(orgId, pipelineId, variant),
    { orgId, pipelineId, variant },
    45,
  );
}

async function board(orgId: string, pipelineId: string, variant = "v") {
  return cache.get(await boardDataKey(orgId, pipelineId, variant));
}

function scans() {
  return fakeRedisCalls(h.redis, "SCAN");
}

/** GETs das chaves de versão (`cache:v:*`). */
function versionReads() {
  return h.redis.calls.filter((c) => c.startsWith("GET cache:v:"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  h.redis.store.clear();
  h.redis.calls.length = 0;
  h.redis.down = false;
  resetCacheVersionsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  delete process.env.REDIS_URL;
});

describe("board", () => {
  it("invalidar um pipeline não chama SCAN e só some aquele pipeline", async () => {
    await seedBoard("org-a", "pipe-1", "todos");
    await seedBoard("org-a", "pipe-1", "meus");
    await seedBoard("org-a", "pipe-2");
    await seedBoard("org-b", "pipe-1");
    h.redis.calls.length = 0;

    await invalidateBoardData("org-a", "pipe-1");

    expect(scans()).toEqual([]);
    expect(h.redis.calls).toEqual(["MULTI 3"]);
    expect(await board("org-a", "pipe-1", "todos")).toBeUndefined();
    expect(await board("org-a", "pipe-1", "meus")).toBeUndefined();
    expect(await board("org-a", "pipe-2")).toBeDefined();
    expect(await board("org-b", "pipe-1")).toBeDefined();
  });

  it("invalidar a org cobre todos os pipelines dela — e só dela", async () => {
    await seedBoard("org-a", "pipe-1");
    await seedBoard("org-a", "pipe-2");
    await seedBoard("org-b", "pipe-1");

    await invalidateOrgBoards("org-a");

    expect(scans()).toEqual([]);
    expect(await board("org-a", "pipe-1")).toBeUndefined();
    expect(await board("org-a", "pipe-2")).toBeUndefined();
    expect(await board("org-b", "pipe-1")).toEqual({
      orgId: "org-b",
      pipelineId: "pipe-1",
      variant: "v",
    });
  });

  it("mensagem (janela de 15 s) invalida sem SCAN", async () => {
    await seedBoard("org-a", "pipe-1");
    await seedBoard("org-a", "pipe-2");

    scheduleBoardInvalidation("org-a", "pipe-1");
    scheduleBoardInvalidation("org-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(await board("org-a", "pipe-1")).toBeUndefined();
    expect(await board("org-a", "pipe-2")).toBeUndefined();

    scheduleBoardInvalidation("org-a", "pipe-1");
    await vi.advanceTimersByTimeAsync(BOARD_INVALIDATION_WINDOW_MS);
    expect(scans()).toEqual([]);
  });

  it("a versão é lida uma vez por janela, não a cada leitura do board", async () => {
    await seedBoard("org-a", "pipe-1");
    h.redis.calls.length = 0;

    for (let i = 0; i < 20; i++) {
      expect(await board("org-a", "pipe-1")).toBeDefined();
    }
    // 20 GETs do valor; nenhuma ida ao Redis pelas versões.
    expect(fakeRedisCalls(h.redis, "GET")).toHaveLength(20);
    expect(versionReads()).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    await board("org-a", "pipe-1");
    expect(versionReads().sort()).toEqual([
      "GET cache:v:board:org-a",
      "GET cache:v:board:org-a:pipe-1",
    ]);
  });

  it("valor gravado depois da invalidação é lido normalmente", async () => {
    await seedBoard("org-a", "pipe-1");
    await invalidateBoardData("org-a", "pipe-1");
    await seedBoard("org-a", "pipe-1");
    expect(await board("org-a", "pipe-1")).toBeDefined();
  });
});

describe("contadores do inbox", () => {
  async function seed(orgId: string) {
    await cache.set(await inboxTabCountsKey(orgId, FP), { entrada: 1 }, 90);
    await cache.set(inboxTabCountsHistKey(orgId, FP), { todos: 9 }, 600);
  }

  it("mudança de aba invalida só as chaves ativas da org, sem SCAN", async () => {
    await seed("org-a");
    await seed("org-b");
    h.redis.calls.length = 0;

    await invalidateInboxTabCounts("org-a");

    expect(scans()).toEqual([]);
    expect(h.redis.calls).toEqual(["MULTI 3"]);
    expect(await cache.get(await inboxTabCountsKey("org-a", FP))).toBeUndefined();
    expect(await cache.get(inboxTabCountsHistKey("org-a", FP))).toEqual({ todos: 9 });
    expect(await cache.get(await inboxTabCountsKey("org-b", FP))).toEqual({ entrada: 1 });
  });

  it("mudança de status (janela de 15 s) invalida sem SCAN", async () => {
    await seed("org-a");
    scheduleTabCountsInvalidation("org-a");
    scheduleTabCountsInvalidation("org-a");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await cache.get(await inboxTabCountsKey("org-a", FP))).toBeUndefined();
    expect(scans()).toEqual([]);
  });
});

describe("catálogo de templates", () => {
  it("sem wabaId troca a versão da org; com wabaId apaga a chave exata", async () => {
    const seed = async (orgId: string, waba: string) =>
      cache.set(await whatsappTemplateCatalogKey(orgId, waba), [waba], 600);
    const read = async (orgId: string, waba: string) =>
      cache.get(await whatsappTemplateCatalogKey(orgId, waba));

    await seed("org-a", "waba-1");
    await seed("org-a", "waba-2");
    await seed("org-b", "waba-1");

    await invalidateWhatsappTemplateCatalog("org-a", "waba-1");
    expect(await read("org-a", "waba-1")).toBeUndefined();
    expect(await read("org-a", "waba-2")).toEqual(["waba-2"]);

    await invalidateWhatsappTemplateCatalog("org-a");
    expect(await read("org-a", "waba-2")).toBeUndefined();
    expect(await read("org-b", "waba-1")).toEqual(["waba-1"]);
    expect(scans()).toEqual([]);
  });
});

describe("lookups de canal dos webhooks", () => {
  type Hit = { organizationId: string; channelId: string };

  function lookup(key: string, result: Hit | null) {
    const loader = vi.fn(async () => result);
    return { loader, run: () => wrapChannelLookup<Hit>(key, 60, loader) };
  }

  it("edição de canal da org A não invalida os lookups da org B e não chama SCAN", async () => {
    const a = lookup(metaWebhookPhoneKey("111"), { organizationId: "org-a", channelId: "ch-a" });
    const b = lookup(webhookContextKey("phoneNumber", "5511"), {
      organizationId: "org-b",
      channelId: "ch-b",
    });
    const msg = lookup(metaWebhookMessagingKey("instagram", "ig-1"), {
      organizationId: "org-b",
      channelId: "ch-b2",
    });

    expect(await a.run()).toEqual({ organizationId: "org-a", channelId: "ch-a" });
    expect(await b.run()).toEqual({ organizationId: "org-b", channelId: "ch-b" });
    await msg.run();
    await a.run();
    await b.run();
    expect(a.loader).toHaveBeenCalledTimes(1);
    expect(b.loader).toHaveBeenCalledTimes(1);

    await invalidateChannelLookups("org-a");

    await a.run();
    await b.run();
    await msg.run();
    expect(a.loader).toHaveBeenCalledTimes(2);
    expect(b.loader).toHaveBeenCalledTimes(1);
    expect(msg.loader).toHaveBeenCalledTimes(1);
    expect(scans()).toEqual([]);
  });

  it("'não mapeado' cai em qualquer escrita de canal (onboarding do canal novo)", async () => {
    const unmapped = lookup(metaWebhookPhoneKey("999"), null);

    expect(await unmapped.run()).toBeNull();
    expect(await unmapped.run()).toBeNull();
    expect(unmapped.loader).toHaveBeenCalledTimes(1);

    await invalidateChannelLookups("org-nova");
    expect(await unmapped.run()).toBeNull();
    expect(unmapped.loader).toHaveBeenCalledTimes(2);
  });

  it("appSecrets: chave da org muda só com a org; a global muda com qualquer uma", async () => {
    const before = {
      a: await metaWebhookSecretsKey("org-a"),
      b: await metaWebhookSecretsKey("org-b"),
      global: await metaWebhookSecretsKey(null),
    };
    expect(before.a).toMatch(/^meta_wh:secrets:org-a:v[0-9a-z]+$/);
    expect(before.global).toMatch(/^meta_wh:secrets:global:v[0-9a-z]+$/);

    await invalidateChannelLookups("org-a");

    expect(await metaWebhookSecretsKey("org-a")).not.toBe(before.a);
    expect(await metaWebhookSecretsKey("org-b")).toBe(before.b);
    expect(await metaWebhookSecretsKey(null)).not.toBe(before.global);
  });

  it("valor fora do formato carimbado conta como miss", async () => {
    await cache.set(metaWebhookPhoneKey("222"), { organizationId: "org-x" }, 60);
    const hit = lookup(metaWebhookPhoneKey("222"), {
      organizationId: "org-a",
      channelId: "ch-a",
    });
    expect(await hit.run()).toEqual({ organizationId: "org-a", channelId: "ch-a" });
    expect(hit.loader).toHaveBeenCalledTimes(1);
  });

  it("services/channels.ts invalida pela org do canal nas três escritas", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "services", "channels.ts"),
      "utf8",
    );
    expect(source).toMatch(/invalidateChannelLookups\(created\.organizationId\)/);
    expect(source).toMatch(/invalidateChannelLookups\(updated\.organizationId\)/);
    expect(source).toMatch(/invalidateChannelLookups\(deleted\.organizationId\)/);
  });
});

describe("Redis fora", () => {
  it("invalidação por versão vale no fallback em memória", async () => {
    vi.resetModules();
    h.redis.down = true;
    const freshCache = (await import("@/lib/cache")).cache;
    const keys = await import("@/lib/cache/keys");

    const key = async (orgId: string) => keys.boardDataKey(orgId, "pipe-1", "v");
    await freshCache.set(await key("org-a"), { org: "a" }, 45);
    await freshCache.set(await key("org-b"), { org: "b" }, 45);
    expect(h.redis.store.size).toBe(0);
    expect(await freshCache.get(await key("org-a"))).toEqual({ org: "a" });

    await keys.invalidateBoardData("org-a", "pipe-1");

    expect(await freshCache.get(await key("org-a"))).toBeUndefined();
    expect(await freshCache.get(await key("org-b"))).toEqual({ org: "b" });
    expect(scans()).toEqual([]);
  });
});

describe("delPattern", () => {
  it("uso administrativo: o MATCH do SCAN fica dentro do prefixo do cache", async () => {
    await cache.set("admin:a", 1, 60);
    await cache.set("admin:b", 2, 60);
    h.redis.store.set("bull:fila:1", { value: "job", expiresAt: null });

    expect(await cache.delPattern("admin:*")).toBe(2);

    expect(scans()).toEqual(["SCAN cache:admin:*"]);
    expect(h.redis.store.has("bull:fila:1")).toBe(true);
    expect(await cache.get("admin:a")).toBeUndefined();
  });

  it("nenhum arquivo da aplicação chama delPattern", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const rel = full.slice(root.length + 1).replace(/\\/g, "/");
        if (rel === "lib/cache/index.ts") continue;
        // Chamada de método (`cache.delPattern(...)`); comentário citando o
        // nome não conta.
        if (/\.delPattern\s*\(/.test(readFileSync(full, "utf8"))) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
