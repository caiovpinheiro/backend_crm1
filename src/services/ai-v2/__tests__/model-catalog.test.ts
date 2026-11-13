import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Atualizar modelos": consulta aos provedores e gravação do catálogo.
 * Banco e rede falsos: o teste confere o que seria gravado.
 */

const state = vi.hoisted(() => ({
  lastRefreshAt: null as Date | null,
  agents: [] as Array<{ id: string; openaiApiKeyEnc: string | null; anthropicApiKeyEnc: string | null }>,
  catalog: [] as Array<Record<string, unknown>>,
  executed: [] as Array<{ sql: string; values: unknown[] }>,
  audits: [] as unknown[],
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes(`FROM "ai_v2_model_catalog_refreshes"`) && sql.includes(`"startedAt" FROM`)) {
        return state.lastRefreshAt ? [{ startedAt: state.lastRefreshAt }] : [];
      }
      if (sql.includes(`FROM "ai_v2_model_catalog_refreshes" r`)) return [];
      if (sql.includes(`"openaiApiKeyEnc", "anthropicApiKeyEnc" FROM "ai_agent_configs"`)) return state.agents;
      if (sql.includes(`FROM "ai_v2_model_catalog" WHERE "organizationId" = $1`)) return state.catalog;
      if (sql.includes(`"draftConfig"->>'model'`)) return [];
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      state.executed.push({ sql, values });
      return 1;
    }),
  },
}));
vi.mock("@/lib/secret-crypto", () => ({ decryptSecret: (v: string) => v.replace(/^enc:/, "") }));
vi.mock("@/lib/audit/log", () => ({ logAudit: vi.fn(async (x: unknown) => void state.audits.push(x)) }));

import {
  REFRESH_COOLDOWN_MS,
  RefreshCooldownError,
  __resetModelCatalogCaches,
  fetchProviderModels,
  isModelAvailableForOrg,
  parsePriceInput,
  refreshOrgModelCatalog,
} from "../model-catalog";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(routes: Record<string, Reply | ((url: string) => Reply)>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new TypeError("fetch failed");
    const r = typeof routes[key] === "function" ? (routes[key] as (u: string) => Reply)(url) : (routes[key] as Reply);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      json: async () => r.body,
    };
  });
  return { impl, calls };
}

const OPENAI = "https://api.openai.com/v1/models";
const ANTHROPIC = "https://api.anthropic.com/v1/models";
const openaiList = {
  data: [
    { id: "gpt-6.1-terra", created: 1_793_000_000 },
    { id: "gpt-4o-mini", created: 1_721_000_000 },
    { id: "text-embedding-3-small", created: 1 },
    { id: "whisper-1", created: 1 },
  ],
};

const upserted = () =>
  state.executed.filter((e) => e.sql.includes(`INSERT INTO "ai_v2_model_catalog" ("organizationId","modelId","provider","label"`)).map((e) => e.values[1]);
const markedMissing = () =>
  state.executed.filter((e) => e.sql.includes(`"missingSince","updatedAt")`)).map((e) => e.values[1]);

beforeEach(() => {
  __resetModelCatalogCaches();
  state.lastRefreshAt = null;
  state.agents = [{ id: "ag-1", openaiApiKeyEnc: "enc:sk-openai-secreta", anthropicApiKeyEnc: "enc:sk-ant-secreta" }];
  state.catalog = [];
  state.executed = [];
  state.audits = [];
});

describe("lista de modelos do provedor", () => {
  it("OpenAI: GET /v1/models com a chave do agente no cabeçalho", async () => {
    const { impl, calls } = fakeFetch({ [OPENAI]: { status: 200, body: openaiList } });
    const list = await fetchProviderModels("openai", "sk-x", impl as never);
    expect(list.map((m) => m.id)).toContain("gpt-6.1-terra");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-x");
  });

  it("Anthropic: pagina com after_id até has_more=false", async () => {
    const { impl, calls } = fakeFetch({
      [ANTHROPIC]: (url) =>
        url.includes("after_id=p1")
          ? { status: 200, body: { data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-10-01T00:00:00Z" }], has_more: false } }
          : { status: 200, body: { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }], has_more: true, last_id: "p1" } },
    });
    const list = await fetchProviderModels("anthropic", "sk-ant-x", impl as never);
    expect(list.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-x");
    expect(calls[0].headers["anthropic-version"]).toBeTruthy();
  });

  it.each([
    [401, "unauthorized"],
    [429, "rate_limited"],
    [500, "http"],
  ])("erro %s vira código %s", async (status, code) => {
    const { impl } = fakeFetch({ [OPENAI]: { status, headers: { "retry-after": "30" } } });
    await expect(fetchProviderModels("openai", "sk-x", impl as never)).rejects.toMatchObject({ code });
  });

  it("resposta sem lista é inválida", async () => {
    const { impl } = fakeFetch({ [OPENAI]: { status: 200, body: { nada: true } } });
    await expect(fetchProviderModels("openai", "sk-x", impl as never)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("atualizar o catálogo da organização", () => {
  it("grava só modelos de chat e marca os fixos que o provedor não lista", async () => {
    const { impl } = fakeFetch({ [OPENAI]: { status: 200, body: openaiList }, [ANTHROPIC]: { status: 200, body: { data: [{ id: "claude-sonnet-5-5" }], has_more: false } } });
    const out = await refreshOrgModelCatalog({ organizationId: "org-1", userId: "u-1", agentId: "ag-1", fetchImpl: impl as never });

    expect(upserted()).toEqual(expect.arrayContaining(["gpt-6.1-terra", "gpt-4o-mini", "claude-sonnet-5-5"]));
    expect(upserted()).not.toContain("text-embedding-3-small");
    expect(upserted()).not.toContain("whisper-1");
    expect(out.result.openai).toMatchObject({ ok: true, chatModels: 2, added: ["gpt-6.1-terra"] });
    expect(out.result.openai.missing).toContain("gpt-6-luna");
    expect(markedMissing()).toContain("claude-opus-5");
    // Quem atualizou e quando ficam registrados.
    const insert = state.executed.find((e) => e.sql.includes(`INSERT INTO "ai_v2_model_catalog_refreshes"`))!;
    expect(insert.values.slice(1, 3)).toEqual(["org-1", "u-1"]);
    expect(state.audits).toHaveLength(1);
  });

  it("falha de um provedor não apaga nem marca nada dele; o outro segue", async () => {
    const { impl } = fakeFetch({ [OPENAI]: { status: 429, headers: { "retry-after": "20" } }, [ANTHROPIC]: { status: 200, body: { data: [{ id: "claude-sonnet-5-5" }], has_more: false } } });
    const out = await refreshOrgModelCatalog({ organizationId: "org-1", userId: "u-1", fetchImpl: impl as never });

    expect(out.result.openai).toMatchObject({ ok: false, code: "rate_limited" });
    expect(out.result.openai.error).toContain("20 s");
    expect(out.result.anthropic.ok).toBe(true);
    expect(markedMissing().some((id) => typeof id === "string" && !String(id).startsWith("claude-"))).toBe(false);
    // A lista da tela continua com os fixos.
    expect(out.models.some((m) => m.id === "gpt-4o-mini")).toBe(true);
  });

  it("provedor fora do ar (rede) e sem chave: erro claro, sem exceção", async () => {
    state.agents = [{ id: "ag-1", openaiApiKeyEnc: "enc:sk-openai-secreta", anthropicApiKeyEnc: null }];
    const { impl } = fakeFetch({});
    const out = await refreshOrgModelCatalog({ organizationId: "org-1", userId: "u-1", fetchImpl: impl as never });
    expect(out.result.openai).toMatchObject({ ok: false, code: "network" });
    expect(out.result.anthropic).toMatchObject({ ok: false, code: "no_key" });
    expect(upserted()).toEqual([]);
  });

  it("a chave nunca aparece no resultado", async () => {
    const { impl } = fakeFetch({ [OPENAI]: { status: 401 }, [ANTHROPIC]: { status: 200, body: { data: [], has_more: false } } });
    const out = await refreshOrgModelCatalog({ organizationId: "org-1", userId: "u-1", fetchImpl: impl as never });
    expect(JSON.stringify(out)).not.toMatch(/secreta/);
    expect(JSON.stringify(state.audits)).not.toMatch(/secreta/);
  });

  it("limite de taxa da organização: uma atualização por minuto", async () => {
    const now = new Date("2026-11-13T12:00:30Z");
    state.lastRefreshAt = new Date(now.getTime() - 10_000);
    const { impl } = fakeFetch({});
    const err = await refreshOrgModelCatalog({ organizationId: "org-1", userId: "u-1", fetchImpl: impl as never, now }).catch((e) => e);
    expect(err).toBeInstanceOf(RefreshCooldownError);
    expect(err.retryAfterSec).toBe((REFRESH_COOLDOWN_MS - 10_000) / 1000);
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("validações", () => {
  it("modelo da lista da organização: fixo e descoberto sim; outro id não", async () => {
    state.catalog = [{ modelId: "gpt-6.1-terra", provider: "openai", firstSeenAt: new Date() }];
    await expect(isModelAvailableForOrg("org-1", "gpt-6.1-terra")).resolves.toBe(true);
    await expect(isModelAvailableForOrg("org-1", "gpt-4o-mini")).resolves.toBe(true);
    await expect(isModelAvailableForOrg("org-1", "gpt-9-inventado")).resolves.toBe(false);
    await expect(isModelAvailableForOrg("org-1", 42)).resolves.toBe(false);
  });

  it("preço da tela", () => {
    expect(parsePriceInput("1,25")).toBe(1.25);
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput(-1)).toBeUndefined();
    expect(parsePriceInput("abc")).toBeUndefined();
    expect(parsePriceInput(20_000)).toBeUndefined();
  });
});
