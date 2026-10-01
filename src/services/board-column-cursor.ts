/**
 * Keyset do "Carregar mais" de uma coluna do board (Kanban).
 *
 * Cada etapa do board já sai com `nextCursor` (cursor depois do último card
 * carregado). `POST /api/pipelines/:id/board/columns` devolve só os próximos
 * N cards daquela etapa e o `nextCursor` seguinte — sem recarregar a coluna
 * nem o board, e sem variante de cache por página.
 *
 * A ordem dentro da coluna é a mesma do board (`boardRankOrderBySql`):
 *   - `position` (padrão): `position ASC, id ASC`;
 *   - `createdAt`:         `createdAt <dir>, position ASC, id ASC`;
 *   - `lastInteraction`:   `last_at <dir> NULLS LAST, position ASC, id ASC`,
 *     onde `last_at` é o `MAX(conversations.updatedAt)` do contato.
 * O cursor carrega a chave completa do último card; `id` fecha a ordem
 * total, então empate em `position`/`createdAt` não repete nem pula card.
 *
 * Formato: base64url de `{ v: 1, k, d, p, i, c?, l? }` — opaco para o
 * cliente. Um cursor emitido para outra ordenação/direção é recusado.
 *
 * Cards que mudam de posição entre páginas:
 *   - card que vai para ANTES do cursor (arrastado para cima, ou — em
 *     `lastInteraction` — recebeu mensagem): não vem nas páginas seguintes;
 *     aparece quando o board é recarregado (SSE/refetch).
 *   - card já carregado que vai para DEPOIS do cursor: pode vir de novo na
 *     página seguinte; o cliente deduplica por `id`.
 *   - card que entra/sai da etapa: vale o estado do momento da consulta.
 */
import type { Prisma } from "@prisma/client";

import { decodeOpaqueCursor, encodeOpaqueCursor } from "@/lib/pagination/opaque-cursor";

export type BoardCursorSort = "position" | "createdAt" | "lastInteraction";
export type BoardCursorDirection = "asc" | "desc";

export type BoardColumnCursor = {
  sort: BoardCursorSort;
  /** `position` é sempre crescente; a direção só vale para os outros dois. */
  direction: BoardCursorDirection;
  position: number;
  id: string;
  /** Só em `sort = "createdAt"`. */
  createdAt?: Date;
  /** Só em `sort = "lastInteraction"`; `null` = contato sem conversa. */
  lastAt?: Date | null;
};

/** `position` ignora a direção pedida (ordem manual, sempre crescente). */
export function normalizeBoardCursorSort(
  sort: BoardCursorSort | undefined,
  direction: BoardCursorDirection | undefined,
): { sort: BoardCursorSort; direction: BoardCursorDirection } {
  const s = sort ?? "position";
  return { sort: s, direction: s === "position" ? "asc" : direction === "desc" ? "desc" : "asc" };
}

export function encodeBoardColumnCursor(cursor: BoardColumnCursor): string {
  const payload: Record<string, unknown> = {
    v: 1,
    k: cursor.sort,
    d: cursor.direction,
    p: cursor.position,
    i: cursor.id,
  };
  if (cursor.sort === "createdAt") payload.c = cursor.createdAt?.getTime();
  if (cursor.sort === "lastInteraction") payload.l = cursor.lastAt ? cursor.lastAt.getTime() : null;
  return encodeOpaqueCursor(payload);
}

function dateFromMs(raw: unknown): Date | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `null` = ilegível ou emitido para outra ordenação/direção. */
export function parseBoardColumnCursor(
  raw: unknown,
  sort: BoardCursorSort | undefined,
  direction: BoardCursorDirection | undefined,
): BoardColumnCursor | null {
  if (typeof raw !== "string") return null;
  const payload = decodeOpaqueCursor(raw);
  if (!payload || payload.v !== 1) return null;
  const expected = normalizeBoardCursorSort(sort, direction);
  if (payload.k !== expected.sort || payload.d !== expected.direction) return null;
  if (typeof payload.p !== "number" || !Number.isFinite(payload.p)) return null;
  if (typeof payload.i !== "string" || payload.i.length === 0) return null;
  const base = {
    sort: expected.sort,
    direction: expected.direction,
    position: payload.p,
    id: payload.i,
  };
  if (expected.sort === "createdAt") {
    const createdAt = dateFromMs(payload.c);
    return createdAt ? { ...base, createdAt } : null;
  }
  if (expected.sort === "lastInteraction") {
    if (payload.l === null) return { ...base, lastAt: null };
    const lastAt = dateFromMs(payload.l);
    return lastAt ? { ...base, lastAt } : null;
  }
  return base;
}

/** `orderBy` Prisma da coluna (`position`/`createdAt`), com `id` no fim. */
export function boardColumnOrderBy(
  sort: BoardCursorSort,
  direction: BoardCursorDirection,
): Prisma.DealOrderByWithRelationInput[] {
  if (sort === "createdAt") {
    return [{ createdAt: direction }, { position: "asc" }, { id: "asc" }];
  }
  return [{ position: "asc" }, { id: "asc" }];
}

/**
 * "Depois do cursor" como `where` Prisma (`position`/`createdAt`).
 *
 * O primeiro termo (`>=`/`<=` na coluna líder) é redundante de propósito:
 * vira limite do índice `(organizationId, stageId, position)` — a leitura
 * começa no cursor em vez de reler os cards já carregados (que é o que um
 * OFFSET faz).
 */
export function boardColumnKeysetWhere(cursor: BoardColumnCursor): Prisma.DealWhereInput {
  const afterPosition: Prisma.DealWhereInput[] = [
    { position: { gt: cursor.position } },
    { position: cursor.position, id: { gt: cursor.id } },
  ];
  if (cursor.sort === "createdAt" && cursor.createdAt) {
    const c = cursor.createdAt;
    const [bound, strict] =
      cursor.direction === "desc" ? (["lte", "lt"] as const) : (["gte", "gt"] as const);
    return {
      AND: [
        { createdAt: { [bound]: c } },
        {
          OR: [
            { createdAt: { [strict]: c } },
            ...afterPosition.map((w) => ({ createdAt: c, ...w })),
          ],
        },
      ],
    };
  }
  return {
    AND: [{ position: { gte: cursor.position } }, { OR: afterPosition }],
  };
}
