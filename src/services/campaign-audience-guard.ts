/**
 * Trava de público de campanha para a API de integrações.
 *
 * O dispatch (`campaigns-worker`) resolve o público com `buildContactWhere`
 * e acrescenta só `phone != null`. Filtro vazio, ou só com chaves que
 * `buildContactWhere` ignora, vira `{}`: todos os contatos com telefone da
 * organização. Aqui a mesma função decide se o filtro restringe alguma
 * coisa — a regra não é reescrita, só consultada.
 *
 * Não é usada pelas rotas de sessão (`/api/campaigns/*`).
 */
import { DealStatus, LifecycleStage } from "@prisma/client";

import { buildContactWhere, type SegmentFilters } from "@/services/segments";

export type AudienceGuardCode =
  | "AUDIENCE_FILTERS_REQUIRED"
  | "AUDIENCE_FILTERS_INVALID";

export type AudienceGuardResult =
  | { ok: true; filters: SegmentFilters }
  | { ok: false; code: AudienceGuardCode; message: string };

const STRING_KEYS = [
  "search",
  "companyId",
  "assignedToId",
  "dealOwnerId",
  "pipelineId",
  "createdAfter",
] as const;
const STRING_ARRAY_KEYS = ["tagIds", "stageIds"] as const;

/** Chaves que `buildContactWhere` lê (espelha `SegmentFilters`). */
export const AUDIENCE_FILTER_KEYS: readonly string[] = [
  ...STRING_KEYS,
  ...STRING_ARRAY_KEYS,
  "lifecycleStage",
  "dealStatus",
  "hasPhone",
];

const REQUIRED_MESSAGE =
  "Informe um segmento ou filtros que restrinjam o público. Filtro vazio ou só com chaves desconhecidas enviaria para todos os contatos com telefone.";

function invalid(message: string): AudienceGuardResult {
  return { ok: false, code: "AUDIENCE_FILTERS_INVALID", message };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEnumValue(enumObj: Record<string, string>, v: unknown): boolean {
  return typeof v === "string" && Object.values(enumObj).includes(v);
}

/**
 * `rejectUnknownKeys`: na criação o corpo é da integração, e uma chave
 * digitada errada alargaria o público em silêncio — recusa. No lançamento o
 * filtro já está gravado (pode ter vindo de outra tela): só os tipos e a
 * restrição efetiva são conferidos.
 */
export function checkAudienceFilters(
  raw: unknown,
  opts: { rejectUnknownKeys?: boolean } = {},
): AudienceGuardResult {
  if (raw === undefined || raw === null) {
    return { ok: false, code: "AUDIENCE_FILTERS_REQUIRED", message: REQUIRED_MESSAGE };
  }
  if (!isPlainObject(raw)) {
    return invalid("filters deve ser um objeto.");
  }

  if (opts.rejectUnknownKeys) {
    const unknown = Object.keys(raw).filter((k) => !AUDIENCE_FILTER_KEYS.includes(k));
    if (unknown.length > 0) {
      return invalid(
        `Filtro desconhecido: ${unknown.join(", ")}. Aceitos: ${AUDIENCE_FILTER_KEYS.join(", ")}.`,
      );
    }
  }

  for (const key of STRING_KEYS) {
    const v = raw[key];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return invalid(`filters.${key} deve ser texto.`);
    }
  }
  for (const key of STRING_ARRAY_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.some((item) => typeof item !== "string" || !item)) {
      return invalid(`filters.${key} deve ser uma lista de ids.`);
    }
  }
  const stage = raw.lifecycleStage;
  if (stage !== undefined && stage !== null && !isEnumValue(LifecycleStage, stage)) {
    return invalid("filters.lifecycleStage inválido.");
  }
  const dealStatus = raw.dealStatus;
  if (dealStatus !== undefined && dealStatus !== null && !isEnumValue(DealStatus, dealStatus)) {
    return invalid("filters.dealStatus inválido.");
  }
  if (raw.hasPhone !== undefined && raw.hasPhone !== null && typeof raw.hasPhone !== "boolean") {
    return invalid("filters.hasPhone deve ser booleano.");
  }
  // `buildContactWhere` descarta data inválida em silêncio (público maior).
  if (typeof raw.createdAfter === "string" && raw.createdAfter.trim()) {
    if (Number.isNaN(new Date(raw.createdAfter).getTime())) {
      return invalid("filters.createdAfter inválido. Use ISO-8601.");
    }
  }

  const filters = raw as SegmentFilters;
  // `hasPhone` não restringe: o dispatch já exige telefone.
  const where = buildContactWhere({ ...filters, hasPhone: undefined });
  if (Object.keys(where).length === 0) {
    return { ok: false, code: "AUDIENCE_FILTERS_REQUIRED", message: REQUIRED_MESSAGE };
  }
  return { ok: true, filters };
}
