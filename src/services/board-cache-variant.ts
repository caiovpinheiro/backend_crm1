/**
 * Variante canônica do cache do board (B3 / R3-ROT-1).
 *
 * A chave do board era `JSON.stringify({ v, s, f, l })` dos objetos crus.
 * Duas cargas que devolvem EXATAMENTE o mesmo board caíam em chaves
 * diferentes por detalhes que não mudam o resultado:
 *
 *   - ordem das chaves e dos ids que o cliente manda (`tagIds: [b, a]`);
 *   - filtro vazio × ausente (`filters: {}` do POST × `undefined` do GET;
 *     `tagIds: []`, `search: "  "`, `withoutOwner: false`);
 *   - padrões explícitos × implícitos (`status` ausente = OPEN,
 *     `perStage` ausente = 100, `sort` ausente = position, `direction` sem
 *     efeito em position, `tagMode: "any"`);
 *   - `filters.pipelineId` igual ao funil do próprio board;
 *   - `offsetByStage` com zeros.
 *
 * Aqui tudo isso é normalizado. O que muda o resultado continua na chave:
 * visibilidade (por usuário quando é "só os meus"), escopo de etapas do
 * papel, status, filtros e paginação.
 */
import type { Prisma } from "@prisma/client";

import type { AdvancedDealFilters } from "@/services/kanban-filters";

export type BoardVariantLimit = {
  perStage?: number;
  offsetByStage?: Record<string, number>;
  sortField?: "position" | "createdAt" | "lastInteraction";
  sortDirection?: "asc" | "desc";
};

/** Mesmos limites de `computeBoardData` (`deals.ts`). */
export const BOARD_DEFAULT_PER_STAGE = 100;
export const BOARD_MAX_PER_STAGE = 500;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function comparePrimitive(a: Json, b: Json): number {
  // null primeiro; depois por tipo e valor.
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (a as string | number | boolean) < (b as string | number | boolean) ? -1 : 1;
}

/**
 * Forma canônica de um valor JSON: chaves em ordem, `undefined` fora,
 * datas em ISO, listas de primitivos ordenadas e sem repetição (no `where`
 * do Prisma são conjuntos: `in`, `notIn`). Listas de objetos (`AND`/`OR`)
 * mantêm a ordem — cada item é canonicalizado.
 */
export function canonicalValue(value: unknown): Json | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value
      .map((v) => canonicalValue(v))
      .filter((v): v is Json => v !== undefined);
    const allPrimitive = items.every((v) => v === null || typeof v !== "object");
    if (!allPrimitive) return items;
    return [...new Set(items)].sort(comparePrimitive);
  }
  if (isPlainObject(value)) {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const v = canonicalValue(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function isEmpty(v: Json | undefined): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

/**
 * Filtros avançados canônicos (`null` = nenhum filtro). Espelha o que
 * `buildDealWhereFromFilters` (`kanban-filters.ts`) de fato lê.
 */
export function canonicalBoardFilters(
  filters: AdvancedDealFilters | null | undefined,
  pipelineId: string,
): { [k: string]: Json } | null {
  if (!filters || !isPlainObject(filters)) return null;
  const f: Record<string, unknown> = { ...filters };

  // `logic` não é lido por buildDealWhereFromFilters.
  delete f.logic;
  for (const key of ["search", "contactSearch"]) {
    if (typeof f[key] === "string") f[key] = (f[key] as string).trim();
  }
  // Funil do próprio board: restrição sem efeito.
  if (f.pipelineId === pipelineId) delete f.pipelineId;
  // `without*` só vale quando true (lido como truthy / `=== true`).
  // `contactHasPhone`/`contactHasEmail` NÃO entram aqui: `false` filtra.
  for (const key of Object.keys(f)) {
    if (key.startsWith("without") && f[key] !== true) delete f[key];
  }
  const hasTagIds = Array.isArray(f.tagIds) && f.tagIds.length > 0;
  if (!hasTagIds || f.withoutTags === true || f.tagMode === "any") delete f.tagMode;
  if (f.exception !== "stalled") delete f.stalledDays;
  for (const key of ["dealCustomFields", "contactCustomFields"]) {
    const list = f[key];
    if (Array.isArray(list)) {
      // Condições em AND: a ordem não muda o resultado.
      f[key] = list
        .map((item) => JSON.stringify(canonicalValue(item)))
        .sort()
        .map((s) => JSON.parse(s) as Json);
    }
  }

  const out: { [k: string]: Json } = {};
  const canon = canonicalValue(f) as { [k: string]: Json };
  for (const [key, v] of Object.entries(canon)) {
    if (isEmpty(v)) continue;
    if (isPlainObject(v)) {
      // Intervalo de datas `{ from, to }` vazio = sem filtro.
      const inner = Object.fromEntries(
        Object.entries(v).filter(([, x]) => !isEmpty(x as Json)),
      ) as { [k: string]: Json };
      if (Object.keys(inner).length === 0) continue;
      out[key] = inner;
      continue;
    }
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Paginação/ordenação com os padrões de `computeBoardData` explícitos. */
export function canonicalBoardLimit(limit: BoardVariantLimit | null | undefined): {
  [k: string]: Json;
} {
  const perStage = Math.min(
    BOARD_MAX_PER_STAGE,
    Math.max(1, limit?.perStage ?? BOARD_DEFAULT_PER_STAGE),
  );
  const sortField = limit?.sortField ?? "position";
  const out: { [k: string]: Json } = { perStage, sortField };
  // `position` ignora a direção (`boardRankOrderBySql`).
  if (sortField !== "position") {
    out.sortDirection = limit?.sortDirection === "desc" ? "desc" : "asc";
  }
  const offsets: { [k: string]: Json } = {};
  for (const stageId of Object.keys(limit?.offsetByStage ?? {}).sort()) {
    const n = limit!.offsetByStage![stageId];
    if (typeof n === "number" && Number.isFinite(n) && n !== 0) offsets[stageId] = n;
  }
  if (Object.keys(offsets).length > 0) out.offsetByStage = offsets;
  return out;
}

/**
 * Texto da variante (vai para o hash da chave em `boardDataKey`).
 * `stageScope`: recorte de etapas do papel aplicado à resposta (`canViewStage`).
 */
export function canonicalBoardVariant(args: {
  pipelineId: string;
  visibilityWhere: Prisma.DealWhereInput | null | undefined;
  statusFilter: string | null | undefined;
  advancedFilters: AdvancedDealFilters | null | undefined;
  limitOptions: BoardVariantLimit | null | undefined;
  stageScope?: string | null;
}): string {
  const v = canonicalValue(args.visibilityWhere ?? null);
  return JSON.stringify({
    v: isEmpty(v) ? null : v,
    s: args.statusFilter ?? "OPEN",
    f: canonicalBoardFilters(args.advancedFilters, args.pipelineId),
    l: canonicalBoardLimit(args.limitOptions),
    sv: args.stageScope ?? null,
  });
}

/**
 * Recorte de etapas do papel (o mesmo que `canViewStage` aplica), em texto
 * estável: `*` para quem vê tudo.
 */
export function boardStageScope(ctx: {
  isSuperAdmin?: boolean;
  isAdmin?: boolean;
  stageDeny?: ReadonlySet<string> | null;
  stageView?: ReadonlySet<string> | null;
}): string {
  if (ctx.isSuperAdmin || ctx.isAdmin) return "*";
  const deny = [...(ctx.stageDeny ?? [])].sort();
  const view = ctx.stageView ? [...ctx.stageView].sort() : null;
  if (deny.length === 0 && view === null) return "*";
  return JSON.stringify({ deny, view });
}
