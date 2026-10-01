import type { SecretKey, SecretsProvider } from "./types";

/**
 * Provider Infisical (self-host ou cloud).
 *
 * STATUS: stub funcional. Carrega secrets via API REST do Infisical
 * uma vez no `prefetch` e cacheia na memoria. Sem SDK pesado pra
 * manter o bundle pequeno — usa `fetch` nativo.
 *
 * Quando ativar:
 *   SECRETS_PROVIDER=infisical
 *   INFISICAL_HOST=https://infisical.eduit.internal
 *   INFISICAL_PROJECT_ID=<uuid>
 *   INFISICAL_ENV=prod
 *   INFISICAL_TOKEN=<service-token>
 *
 * Cache: 5 min de TTL. Em prod com Infisical self-host e fetch local
 * (rede interna do compose), a latencia e desprezivel mesmo se
 * cair pra 1 min.
 *
 * @see docs/secrets-management.md
 */
type CacheEntry = { value: string; fetchedAt: number };
const CACHE_TTL_MS = 5 * 60 * 1000;

interface InfisicalConfig {
  host: string;
  projectId: string;
  environment: string;
  token: string;
}

function readConfig(): InfisicalConfig {
  const host = process.env.INFISICAL_HOST?.trim();
  const projectId = process.env.INFISICAL_PROJECT_ID?.trim();
  const environment = process.env.INFISICAL_ENV?.trim() ?? "prod";
  const token = process.env.INFISICAL_TOKEN?.trim();

  if (!host || !projectId || !token) {
    throw new Error(
      "Infisical provider requer INFISICAL_HOST, INFISICAL_PROJECT_ID e INFISICAL_TOKEN.",
    );
  }
  return { host, projectId, environment, token };
}

interface InfisicalSecretAPI {
  secretKey: string;
  secretValue: string;
}

async function fetchAllSecrets(
  config: InfisicalConfig,
): Promise<Map<string, string>> {
  const url = new URL("/api/v3/secrets/raw", config.host);
  url.searchParams.set("workspaceId", config.projectId);
  url.searchParams.set("environment", config.environment);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Infisical fetch failed: HTTP ${res.status} ${body.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as { secrets?: InfisicalSecretAPI[] };
  const out = new Map<string, string>();
  for (const s of json.secrets ?? []) {
    if (s.secretKey && typeof s.secretValue === "string") {
      out.set(s.secretKey, s.secretValue);
    }
  }
  return out;
}

export function createInfisicalProvider(): SecretsProvider {
  const cache = new Map<string, CacheEntry>();
  let prefetchPromise: Promise<void> | null = null;
  let lastPrefetchAt = 0;

  async function doPrefetch(): Promise<void> {
    const config = readConfig();
    const fetched = await fetchAllSecrets(config);
    const now = Date.now();
    cache.clear();
    for (const [k, v] of fetched.entries()) {
      cache.set(k, { value: v, fetchedAt: now });
    }
    lastPrefetchAt = now;
  }

  function get(key: SecretKey | string): string | undefined {
    const entry = cache.get(key);
    if (!entry) {
      // Fallback para process.env: secrets de boot que rodam ANTES do
      // prefetch (ex: DATABASE_URL durante migracao manual). Logamos
      // pra detectar dependencias acidentais.
      const fallback = process.env[key]?.trim();
      if (fallback) {
        // eslint-disable-next-line no-console -- carregado pelo instrumentation (bundle Edge), antes de o logger existir
        console.warn(
          `[secrets/infisical] fallback to process.env for ${key} (cache miss; provider not prefetched yet?)`,
        );
        return fallback.length === 0 ? undefined : fallback;
      }
      return undefined;
    }

    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
      // Stale-while-revalidate: serve o stale e dispara refresh em background.
      void prefetch().catch((err) => {
        // eslint-disable-next-line no-console -- carregado pelo instrumentation (bundle Edge), antes de o logger existir
        console.error("[secrets/infisical] refresh failed", err);
      });
    }
    return entry.value;
  }

  async function prefetch(): Promise<void> {
    if (prefetchPromise) return prefetchPromise;
    prefetchPromise = doPrefetch().finally(() => {
      prefetchPromise = null;
    });
    return prefetchPromise;
  }

  return {
    name: "infisical",
    get,
    prefetch,
    async health() {
      try {
        const config = readConfig();
        // HEAD/ping endpoint do Infisical e simples /api/status.
        const url = new URL("/api/status", config.host);
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) {
          return { ok: false, detail: `HTTP ${res.status}` };
        }
        return {
          ok: true,
          detail: `cached=${cache.size} lastPrefetch=${
            lastPrefetchAt ? new Date(lastPrefetchAt).toISOString() : "never"
          }`,
        };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
