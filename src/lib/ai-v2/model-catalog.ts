/**
 * Catálogo de modelos da organização: a lista fixa do código mais os
 * modelos descobertos nos provedores pelo botão "Atualizar modelos".
 * Funções puras (sem banco): o serviço em `services/ai-v2/model-catalog`
 * lê as linhas e chama `mergeModelCatalog`. Nenhum domínio de cliente.
 */

import {
  V2_MODELS,
  inferV2ModelCaps,
  isAgentChatModelId,
  modelFamilyVersion,
  prettyModelLabel,
  stripModelDateSuffix,
  unknownModelPriceCeiling,
  v2ModelInfo,
  type V2ModelProvider,
} from "./models";

type DateLike = Date | string | null | undefined;

/** Linha gravada por organização (`ai_v2_model_catalog`). */
export type ModelCatalogRow = {
  modelId: string;
  provider: V2ModelProvider;
  label?: string | null;
  /** Data de lançamento informada pelo provedor. */
  providerCreatedAt?: DateLike;
  /** Primeira e última vez em que apareceu na lista do provedor. */
  firstSeenAt?: DateLike;
  lastSeenAt?: DateLike;
  /** Deixou de aparecer na lista do provedor (numa atualização que funcionou). */
  missingSince?: DateLike;
  /** Preço informado pelo admin, US$ por 1M tokens. */
  inputPer1M?: number | null;
  outputPer1M?: number | null;
  priceUpdatedAt?: DateLike;
  /** Preço da página oficial do provedor, lido no "Atualizar modelos". */
  officialInputPer1M?: number | null;
  officialOutputPer1M?: number | null;
  officialPriceAt?: DateLike;
};

/** org: informado pelo admin; official: página de preços do provedor; builtin: tabela do código. */
export type ModelPriceSource = "org" | "official" | "builtin" | "unknown";

export type CatalogModel = {
  id: string;
  name: string;
  provider: V2ModelProvider;
  hint: string;
  /** builtin: lista fixa do código; discovered: veio do provedor. */
  source: "builtin" | "discovered";
  legacy: boolean;
  reasoning: boolean;
  /** Preço conhecido (tabela do código ou informado pelo admin); null = desconhecido. */
  inputPer1M: number | null;
  outputPer1M: number | null;
  priceSource: ModelPriceSource;
  /** Preço que a estimativa de gasto e o limite usam (o teto do provedor quando desconhecido). */
  estimateInputPer1M: number;
  estimateOutputPer1M: number;
  /** O provedor parou de listar este modelo. */
  missing: boolean;
  missingSince: string | null;
  discoveredAt: string | null;
  /** Quando o preço oficial foi lido (null = sem preço oficial). */
  officialPriceAt: string | null;
};

function iso(v: DateLike): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function validPrice(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

type PriceRow = Pick<ModelCatalogRow, "inputPer1M" | "outputPer1M" | "officialInputPer1M" | "officialOutputPer1M">;

/**
 * Preço de um modelo, nesta ordem:
 *  1. o informado pelo admin da organização;
 *  2. o da página oficial do provedor (lido no "Atualizar modelos"; versão
 *     com data usa o do nome sem data, `aliasRow`);
 *  3. a tabela do código;
 *  4. desconhecido — a estimativa usa o teto do provedor.
 */
export function resolveModelPrice(
  modelId: string,
  row?: PriceRow | null,
  aliasRow?: PriceRow | null,
): { inputPer1M: number; outputPer1M: number; source: ModelPriceSource } {
  if (row && validPrice(row.inputPer1M) && validPrice(row.outputPer1M)) {
    return { inputPer1M: row.inputPer1M, outputPer1M: row.outputPer1M, source: "org" };
  }
  for (const r of [row, aliasRow]) {
    if (r && validPrice(r.officialInputPer1M) && validPrice(r.officialOutputPer1M)) {
      return { inputPer1M: r.officialInputPer1M, outputPer1M: r.officialOutputPer1M, source: "official" };
    }
  }
  const info = v2ModelInfo(modelId) ?? v2ModelInfo(stripModelDateSuffix(modelId));
  if (info) return { inputPer1M: info.inputPer1M, outputPer1M: info.outputPer1M, source: "builtin" };
  const ceiling = unknownModelPriceCeiling(modelId.startsWith("claude-") ? "anthropic" : "openai");
  return { ...ceiling, source: "unknown" };
}

/** US$ de um uso de tokens pelo preço resolvido. */
export function costForUsage(price: { inputPer1M: number; outputPer1M: number }, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * price.inputPer1M + (outputTokens / 1_000_000) * price.outputPer1M;
}

const PROVIDER_ORDER: Record<V2ModelProvider, number> = { openai: 0, anthropic: 1 };

/** Provedor, depois atuais antes dos antigos, família mais nova primeiro, lançamento mais recente, nome. */
export function compareCatalogModels(
  a: Pick<CatalogModel, "id" | "name" | "provider" | "legacy"> & { createdAt?: string | null },
  b: Pick<CatalogModel, "id" | "name" | "provider" | "legacy"> & { createdAt?: string | null },
): number {
  return (
    PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider] ||
    Number(a.legacy) - Number(b.legacy) ||
    modelFamilyVersion(b.id) - modelFamilyVersion(a.id) ||
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
    a.name.localeCompare(b.name, "pt-BR")
  );
}

/**
 * Lista da tela: os fixos de hoje (sempre) mais os descobertos que servem
 * para o agente. Versão com data (`…-20250929`) some quando o nome sem data
 * também está na lista. Descoberto que o provedor parou de listar fica
 * marcado e só continua na lista se algum agente da organização usa.
 */
export function mergeModelCatalog(
  rows: ModelCatalogRow[],
  opts: { inUse?: Iterable<string> } = {},
): CatalogModel[] {
  const inUse = new Set(opts.inUse ?? []);
  const byId = new Map<string, ModelCatalogRow>();
  for (const r of rows) if (r?.modelId) byId.set(r.modelId, r);

  const out: Array<CatalogModel & { createdAt: string | null }> = [];

  for (const m of V2_MODELS) {
    const row = byId.get(m.id);
    const price = resolveModelPrice(m.id, row);
    const officialAt = price.source === "official" ? iso(row?.officialPriceAt) : null;
    out.push({
      id: m.id,
      name: m.label,
      provider: m.provider,
      hint: m.hint,
      source: "builtin",
      legacy: Boolean(m.legacy),
      reasoning: m.reasoning,
      inputPer1M: price.inputPer1M,
      outputPer1M: price.outputPer1M,
      priceSource: price.source,
      estimateInputPer1M: price.inputPer1M,
      estimateOutputPer1M: price.outputPer1M,
      missing: Boolean(row?.missingSince),
      missingSince: iso(row?.missingSince),
      discoveredAt: iso(row?.firstSeenAt),
      officialPriceAt: officialAt,
      createdAt: iso(row?.providerCreatedAt),
    });
  }

  const discovered = rows.filter(
    (r) => r?.modelId && !v2ModelInfo(r.modelId) && r.firstSeenAt && isAgentChatModelId(r.provider, r.modelId),
  );
  const allIds = new Set<string>([...V2_MODELS.map((m) => m.id), ...discovered.filter((r) => !r.missingSince).map((r) => r.modelId)]);

  for (const r of discovered) {
    const missing = Boolean(r.missingSince);
    if (missing && !inUse.has(r.modelId)) continue;
    const alias = stripModelDateSuffix(r.modelId);
    if (alias !== r.modelId && allIds.has(alias) && !inUse.has(r.modelId)) continue;
    const caps = inferV2ModelCaps(r.modelId);
    if (!caps) continue;
    const aliasRow = alias !== r.modelId ? byId.get(alias) : undefined;
    const price = resolveModelPrice(r.modelId, r, aliasRow);
    const known = price.source !== "unknown";
    out.push({
      id: r.modelId,
      name: r.label?.trim() || prettyModelLabel(r.modelId),
      provider: r.provider,
      hint: missing ? "O provedor não lista mais este modelo." : "Novo no provedor: teste antes de trocar.",
      source: "discovered",
      legacy: false,
      reasoning: caps.reasoning,
      inputPer1M: known ? price.inputPer1M : null,
      outputPer1M: known ? price.outputPer1M : null,
      priceSource: price.source,
      estimateInputPer1M: price.inputPer1M,
      estimateOutputPer1M: price.outputPer1M,
      missing,
      missingSince: iso(r.missingSince),
      discoveredAt: iso(r.firstSeenAt),
      officialPriceAt: price.source === "official" ? iso(r.officialPriceAt ?? aliasRow?.officialPriceAt) : null,
      createdAt: iso(r.providerCreatedAt),
    });
  }

  return out.sort(compareCatalogModels).map(({ createdAt: _createdAt, ...m }) => m);
}

/** Modelo que pode ser escolhido nesta organização (fixo, ou descoberto e na lista). */
export function isModelInCatalog(models: Pick<CatalogModel, "id">[], modelId: unknown): modelId is string {
  return typeof modelId === "string" && models.some((m) => m.id === modelId);
}
