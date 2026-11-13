/**
 * Catálogo de modelos por organização ("Atualizar modelos").
 *
 * O botão consulta a lista de modelos de cada provedor (OpenAI e Anthropic)
 * com a chave já gravada no agente — ou, sem ela, em outro agente da mesma
 * organização. A chamada sai daqui; a chave nunca vai ao navegador. O
 * resultado fica em `ai_v2_model_catalog`; cada atualização fica em
 * `ai_v2_model_catalog_refreshes` (quem, quando, o que mudou).
 *
 * A API de modelos não devolve preço: modelo descoberto fica com preço
 * desconhecido até o admin preencher. Enquanto isso, a estimativa de gasto
 * e o limite usam o teto do provedor (`unknownModelPriceCeiling`).
 * Nenhum domínio de cliente.
 */

import { randomUUID } from "node:crypto";

import { prismaBase } from "@/lib/prisma-base";
import { decryptSecret } from "@/lib/secret-crypto";
import { logAudit } from "@/lib/audit/log";
import { getLogger } from "@/lib/logger";
import {
  V2_MODELS,
  isAgentChatModelId,
  type V2ModelProvider,
} from "@/lib/ai-v2/models";
import {
  costForUsage,
  mergeModelCatalog,
  resolveModelPrice,
  type CatalogModel,
  type ModelCatalogRow,
  type ModelPriceSource,
} from "@/lib/ai-v2/model-catalog";

const log = getLogger("ai-v2.model-catalog");

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
};

/** Intervalo mínimo entre duas atualizações da mesma organização. */
export const REFRESH_COOLDOWN_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 15_000;
const ANTHROPIC_MAX_PAGES = 5;

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_model_catalog" (
      "organizationId" TEXT NOT NULL,
      "modelId" TEXT NOT NULL,
      "provider" TEXT NOT NULL,
      "label" TEXT,
      "providerCreatedAt" TIMESTAMPTZ,
      "firstSeenAt" TIMESTAMPTZ,
      "lastSeenAt" TIMESTAMPTZ,
      "missingSince" TIMESTAMPTZ,
      "inputPer1M" DOUBLE PRECISION,
      "outputPer1M" DOUBLE PRECISION,
      "priceUpdatedById" TEXT,
      "priceUpdatedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY ("organizationId", "modelId")
    )`);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_model_catalog_refreshes" (
      "id" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "userId" TEXT,
      "startedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "finishedAt" TIMESTAMPTZ,
      "result" JSONB
    )`);
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "ai_v2_model_catalog_refreshes_org_idx" ON "ai_v2_model_catalog_refreshes" ("organizationId", "startedAt")`,
  );
  schemaReady = true;
}

// ── Provedores ──────────────────────────────────────────────────────────

export type ProviderModel = { id: string; label?: string | null; createdAt?: string | null };

export type ProviderErrorCode = "no_key" | "unauthorized" | "rate_limited" | "timeout" | "http" | "network" | "invalid_response";

export class ProviderModelsError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ProviderModelsError";
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const PROVIDER_NAME: Record<V2ModelProvider, string> = { openai: "OpenAI", anthropic: "Anthropic" };

async function getJson(provider: V2ModelProvider, url: string, headers: Record<string, string>, fetchImpl: FetchLike): Promise<unknown> {
  const name = PROVIDER_NAME[provider];
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new ProviderModelsError(isTimeout ? "timeout" : "network", isTimeout ? `${name} não respondeu a tempo.` : `Não foi possível falar com a ${name}.`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderModelsError("unauthorized", `A ${name} recusou a chave gravada (${res.status}). Confira a chave em Contas dos modelos.`);
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    const retryAfterSec = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined;
    throw new ProviderModelsError("rate_limited", `A ${name} pediu para esperar (limite de requisições).${retryAfterSec ? ` Tente em ${retryAfterSec} s.` : ""}`, retryAfterSec);
  }
  if (!res.ok) throw new ProviderModelsError("http", `A ${name} respondeu com erro ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new ProviderModelsError("invalid_response", `Resposta inesperada da ${name}.`);
  }
}

function toIsoFromUnix(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null;
}

function toIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Lista de modelos do provedor (sem filtro). Uma chamada na OpenAI; até 5 páginas na Anthropic. */
export async function fetchProviderModels(provider: V2ModelProvider, apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ProviderModel[]> {
  if (provider === "openai") {
    const body = (await getJson(provider, "https://api.openai.com/v1/models", { Authorization: `Bearer ${apiKey}` }, fetchImpl)) as { data?: unknown };
    if (!Array.isArray(body?.data)) throw new ProviderModelsError("invalid_response", "Resposta inesperada da OpenAI.");
    return (body.data as Array<Record<string, unknown>>)
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ id: m.id as string, createdAt: toIsoFromUnix(m.created) }));
  }

  const out: ProviderModel[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: "1000" });
    if (afterId) qs.set("after_id", afterId);
    const body = (await getJson(
      provider,
      `https://api.anthropic.com/v1/models?${qs.toString()}`,
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      fetchImpl,
    )) as { data?: unknown; has_more?: unknown; last_id?: unknown };
    if (!Array.isArray(body?.data)) throw new ProviderModelsError("invalid_response", "Resposta inesperada da Anthropic.");
    for (const m of body.data as Array<Record<string, unknown>>) {
      if (typeof m?.id !== "string") continue;
      out.push({ id: m.id, label: typeof m.display_name === "string" ? m.display_name : null, createdAt: toIso(m.created_at) });
    }
    if (body.has_more !== true || typeof body.last_id !== "string") break;
    afterId = body.last_id;
  }
  return out;
}

// ── Chaves ──────────────────────────────────────────────────────────────

type KeyRow = { id: string; openaiApiKeyEnc: string | null; anthropicApiKeyEnc: string | null };

function decrypt(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(enc).trim() || null;
  } catch {
    return null;
  }
}

/** Chaves para consultar os provedores: as do agente; faltando, a de outro agente da organização. */
async function resolveProviderKeys(organizationId: string, agentId?: string): Promise<Record<V2ModelProvider, string | null>> {
  const rows = await db.$queryRawUnsafe<KeyRow[]>(
    `SELECT "id", "openaiApiKeyEnc", "anthropicApiKeyEnc" FROM "ai_agent_configs"
      WHERE "organizationId" = $1 AND ("openaiApiKeyEnc" IS NOT NULL OR "anthropicApiKeyEnc" IS NOT NULL)
      ORDER BY ("id" = $2) DESC, "updatedAt" DESC LIMIT 50`,
    organizationId,
    agentId ?? "",
  );
  const pick = (field: "openaiApiKeyEnc" | "anthropicApiKeyEnc") => {
    for (const r of rows) {
      const key = decrypt(r[field]);
      if (key) return key;
    }
    return null;
  };
  return { openai: pick("openaiApiKeyEnc"), anthropic: pick("anthropicApiKeyEnc") };
}

// ── Leitura ─────────────────────────────────────────────────────────────

type DbRow = ModelCatalogRow & { priceUpdatedById?: string | null };

async function readRows(organizationId: string): Promise<DbRow[]> {
  await ensureSchema();
  return db.$queryRawUnsafe<DbRow[]>(
    `SELECT "modelId", "provider", "label", "providerCreatedAt", "firstSeenAt", "lastSeenAt", "missingSince",
            "inputPer1M", "outputPer1M", "priceUpdatedById", "priceUpdatedAt"
       FROM "ai_v2_model_catalog" WHERE "organizationId" = $1`,
    organizationId,
  );
}

/** Modelos em uso pelos agentes da organização (rascunho e publicado). */
async function modelsInUse(organizationId: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ model: string | null }>>(
    `SELECT DISTINCT m AS "model" FROM (
       SELECT "draftConfig"->>'model' AS m FROM "ai_agent_configs" WHERE "organizationId" = $1
       UNION SELECT "simpleConfig"->>'model' FROM "ai_agent_configs" WHERE "organizationId" = $1
     ) t WHERE m IS NOT NULL`,
    organizationId,
  ).catch(() => []);
  return rows.map((r) => r.model).filter((m): m is string => Boolean(m));
}

export type LastRefresh = {
  at: string;
  userId: string | null;
  userName: string | null;
  result: RefreshResult | null;
};

async function lastRefresh(organizationId: string): Promise<LastRefresh | null> {
  await ensureSchema();
  const rows = await db.$queryRawUnsafe<Array<{ startedAt: Date; userId: string | null; userName: string | null; result: RefreshResult | null }>>(
    `SELECT r."startedAt", r."userId", u."name" AS "userName", r."result"
       FROM "ai_v2_model_catalog_refreshes" r LEFT JOIN "users" u ON u."id" = r."userId"
      WHERE r."organizationId" = $1 ORDER BY r."startedAt" DESC LIMIT 1`,
    organizationId,
  ).catch(() => []);
  const r = rows[0];
  if (!r) return null;
  return { at: new Date(r.startedAt).toISOString(), userId: r.userId, userName: r.userName, result: r.result };
}

/** Lista da tela para a organização. Sem banco (ou erro), cai nos fixos. */
export async function listOrgModels(organizationId: string): Promise<CatalogModel[]> {
  try {
    const [rows, inUse] = await Promise.all([readRows(organizationId), modelsInUse(organizationId)]);
    return mergeModelCatalog(rows, { inUse });
  } catch (err) {
    log.warn({ err }, "[model-catalog] leitura falhou; usando a lista fixa");
    return mergeModelCatalog([]);
  }
}

export async function getOrgModelCatalog(organizationId: string): Promise<{ models: CatalogModel[]; lastRefresh: LastRefresh | null }> {
  const [models, last] = await Promise.all([listOrgModels(organizationId), lastRefresh(organizationId).catch(() => null)]);
  return { models, lastRefresh: last };
}

/** O modelo pode ser escolhido nesta organização? */
export async function isModelAvailableForOrg(organizationId: string, modelId: unknown): Promise<boolean> {
  if (typeof modelId !== "string" || !modelId) return false;
  const models = await listOrgModels(organizationId);
  return models.some((m) => m.id === modelId);
}

// ── Preço para a estimativa ─────────────────────────────────────────────

type PriceMap = Map<string, { inputPer1M: number; outputPer1M: number }>;
const PRICE_TTL_MS = 60_000;
const priceCache = new Map<string, { at: number; prices: PriceMap }>();

async function orgPrices(organizationId: string): Promise<PriceMap> {
  const hit = priceCache.get(organizationId);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.prices;
  const prices: PriceMap = new Map();
  try {
    await ensureSchema();
    const rows = await db.$queryRawUnsafe<Array<{ modelId: string; inputPer1M: number; outputPer1M: number }>>(
      `SELECT "modelId", "inputPer1M", "outputPer1M" FROM "ai_v2_model_catalog"
        WHERE "organizationId" = $1 AND "inputPer1M" IS NOT NULL AND "outputPer1M" IS NOT NULL`,
      organizationId,
    );
    for (const r of rows ?? []) prices.set(r.modelId, { inputPer1M: Number(r.inputPer1M), outputPer1M: Number(r.outputPer1M) });
  } catch (err) {
    log.warn({ err }, "[model-catalog] preços da organização indisponíveis");
  }
  priceCache.set(organizationId, { at: Date.now(), prices });
  return prices;
}

/** Preço do modelo para a organização (admin → tabela do código → teto do provedor). Nunca lança. */
export async function getModelPriceForOrg(
  organizationId: string,
  modelId: string,
): Promise<{ inputPer1M: number; outputPer1M: number; source: ModelPriceSource }> {
  const prices = await orgPrices(organizationId);
  return resolveModelPrice(modelId, prices.get(modelId));
}

export async function estimateCostForOrg(organizationId: string, modelId: string, inputTokens: number, outputTokens: number): Promise<number> {
  const price = await getModelPriceForOrg(organizationId, modelId);
  return Number(costForUsage(price, inputTokens, outputTokens).toFixed(6));
}

// ── Atualizar ───────────────────────────────────────────────────────────

export type ProviderRefreshResult = {
  ok: boolean;
  error?: string;
  code?: ProviderErrorCode;
  /** Modelos de chat que servem ao agente, na lista do provedor. */
  chatModels?: number;
  added?: string[];
  missing?: string[];
};

export type RefreshResult = Record<V2ModelProvider, ProviderRefreshResult>;

export class RefreshCooldownError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`Os modelos foram atualizados há pouco. Tente de novo em ${retryAfterSec} s.`);
    this.name = "RefreshCooldownError";
  }
}

const inFlight = new Set<string>();

/**
 * Consulta os dois provedores e grava o catálogo da organização.
 * Provedor que falha (sem chave, chave recusada, limite de taxa, fora do
 * ar) não mexe nas linhas dele: nada some por causa de uma falha.
 */
export async function refreshOrgModelCatalog(args: {
  organizationId: string;
  userId: string;
  agentId?: string;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<{ result: RefreshResult; models: CatalogModel[]; lastRefresh: LastRefresh | null }> {
  const { organizationId } = args;
  await ensureSchema();
  if (inFlight.has(organizationId)) throw new RefreshCooldownError(Math.ceil(REFRESH_COOLDOWN_MS / 1000));
  const now = args.now ?? new Date();
  const last = await db.$queryRawUnsafe<Array<{ startedAt: Date }>>(
    `SELECT "startedAt" FROM "ai_v2_model_catalog_refreshes" WHERE "organizationId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
    organizationId,
  );
  const elapsed = last[0] ? now.getTime() - new Date(last[0].startedAt).getTime() : Infinity;
  if (elapsed < REFRESH_COOLDOWN_MS) throw new RefreshCooldownError(Math.max(1, Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000)));

  inFlight.add(organizationId);
  const refreshId = randomUUID();
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_v2_model_catalog_refreshes" ("id","organizationId","userId","startedAt") VALUES ($1,$2,$3,$4)`,
      refreshId, organizationId, args.userId, now,
    );
    const keys = await resolveProviderKeys(organizationId, args.agentId);
    const existing = await readRows(organizationId);
    const providers: V2ModelProvider[] = ["openai", "anthropic"];
    const entries = await Promise.all(
      providers.map(async (provider): Promise<[V2ModelProvider, ProviderRefreshResult]> => {
        const key = keys[provider];
        if (!key) {
          return [provider, { ok: false, code: "no_key", error: `Nenhum agente da organização tem chave ${PROVIDER_NAME[provider]} gravada.` }];
        }
        try {
          const list = await fetchProviderModels(provider, key, args.fetchImpl);
          return [provider, await applyProviderList({ organizationId, provider, list, existing, now })];
        } catch (err) {
          const e = err instanceof ProviderModelsError ? err : new ProviderModelsError("network", err instanceof Error ? err.message : String(err));
          log.warn({ provider, code: e.code }, "[model-catalog] provedor falhou");
          return [provider, { ok: false, code: e.code, error: e.message }];
        }
      }),
    );
    const result = Object.fromEntries(entries) as RefreshResult;
    await db.$executeRawUnsafe(
      `UPDATE "ai_v2_model_catalog_refreshes" SET "finishedAt" = now(), "result" = $2::jsonb WHERE "id" = $1`,
      refreshId, JSON.stringify(result),
    );
    await logAudit({
      entity: "ai_agent",
      action: "model_catalog_refresh",
      entityId: args.agentId ?? null,
      organizationId,
      actorId: args.userId,
      after: result,
    });
    const catalog = await getOrgModelCatalog(organizationId);
    return { result, ...catalog };
  } finally {
    inFlight.delete(organizationId);
  }
}

async function applyProviderList(args: {
  organizationId: string;
  provider: V2ModelProvider;
  list: ProviderModel[];
  existing: ModelCatalogRow[];
  now: Date;
}): Promise<ProviderRefreshResult> {
  const { organizationId, provider, now } = args;
  const chat = args.list.filter((m) => isAgentChatModelId(provider, m.id));
  const seen = new Set(chat.map((m) => m.id));
  const before = new Map(args.existing.filter((r) => r.provider === provider).map((r) => [r.modelId, r]));
  const added: string[] = [];

  for (const m of chat) {
    if (!before.get(m.id)?.firstSeenAt && !V2_MODELS.some((s) => s.id === m.id)) added.push(m.id);
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_v2_model_catalog" ("organizationId","modelId","provider","label","providerCreatedAt","firstSeenAt","lastSeenAt","missingSince","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$6,NULL,$6)
       ON CONFLICT ("organizationId","modelId") DO UPDATE SET
         "provider" = EXCLUDED."provider",
         "label" = COALESCE(EXCLUDED."label", "ai_v2_model_catalog"."label"),
         "providerCreatedAt" = COALESCE(EXCLUDED."providerCreatedAt", "ai_v2_model_catalog"."providerCreatedAt"),
         "firstSeenAt" = COALESCE("ai_v2_model_catalog"."firstSeenAt", EXCLUDED."firstSeenAt"),
         "lastSeenAt" = EXCLUDED."lastSeenAt",
         "missingSince" = NULL,
         "updatedAt" = EXCLUDED."updatedAt"`,
      organizationId, m.id, provider, m.label ?? null, m.createdAt ? new Date(m.createdAt) : null, now,
    );
  }

  // Sumiu da lista do provedor: marca (descobertos e fixos), não apaga.
  const gone = new Set<string>();
  for (const r of before.values()) if (r.firstSeenAt && !seen.has(r.modelId)) gone.add(r.modelId);
  for (const s of V2_MODELS) if (s.provider === provider && !seen.has(s.id)) gone.add(s.id);
  const missing: string[] = [];
  for (const id of gone) {
    if (!before.get(id)?.missingSince) missing.push(id);
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_v2_model_catalog" ("organizationId","modelId","provider","missingSince","updatedAt")
       VALUES ($1,$2,$3,$4,$4)
       ON CONFLICT ("organizationId","modelId") DO UPDATE SET
         "missingSince" = COALESCE("ai_v2_model_catalog"."missingSince", EXCLUDED."missingSince"),
         "updatedAt" = EXCLUDED."updatedAt"`,
      organizationId, id, provider, now,
    );
  }

  return { ok: true, chatModels: chat.length, added, missing };
}

// ── Preço informado pelo admin ──────────────────────────────────────────

/** Normaliza o preço da tela: número ≥ 0 e ≤ 10.000; vazio = limpar. */
export function parsePriceInput(v: unknown): number | null | undefined {
  if (v === null || v === "" || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return undefined;
  return Math.round(n * 1_000_000) / 1_000_000;
}

export async function setOrgModelPrice(args: {
  organizationId: string;
  userId: string;
  modelId: string;
  inputPer1M: number | null;
  outputPer1M: number | null;
}): Promise<CatalogModel[]> {
  const { organizationId, modelId } = args;
  const models = await listOrgModels(organizationId);
  const current = models.find((m) => m.id === modelId);
  if (!current) throw new Error("Modelo fora da lista desta organização.");
  if ((args.inputPer1M === null) !== (args.outputPer1M === null)) throw new Error("Preencha entrada e saída, ou deixe os dois vazios.");
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_v2_model_catalog" ("organizationId","modelId","provider","inputPer1M","outputPer1M","priceUpdatedById","priceUpdatedAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,now(),now())
     ON CONFLICT ("organizationId","modelId") DO UPDATE SET
       "inputPer1M" = EXCLUDED."inputPer1M",
       "outputPer1M" = EXCLUDED."outputPer1M",
       "priceUpdatedById" = EXCLUDED."priceUpdatedById",
       "priceUpdatedAt" = EXCLUDED."priceUpdatedAt",
       "updatedAt" = EXCLUDED."updatedAt"`,
    organizationId, modelId, current.provider, args.inputPer1M, args.outputPer1M, args.userId,
  );
  priceCache.delete(organizationId);
  await logAudit({
    entity: "ai_agent",
    action: "model_price_update",
    entityId: modelId,
    organizationId,
    actorId: args.userId,
    before: { inputPer1M: current.inputPer1M, outputPer1M: current.outputPer1M, source: current.priceSource },
    after: { inputPer1M: args.inputPer1M, outputPer1M: args.outputPer1M },
  });
  return listOrgModels(organizationId);
}

/** Só para testes. */
export function __resetModelCatalogCaches(): void {
  priceCache.clear();
  inFlight.clear();
  schemaReady = false;
}
