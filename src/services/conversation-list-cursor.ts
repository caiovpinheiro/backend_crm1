/**
 * Keyset da lista do inbox (`GET /api/conversations`).
 *
 * Ordenação da lista: `<chave> <dir>, id <dir>`. A chave padrão é
 * `lastMessageAt` = `COALESCE("lastMessageAt", "updatedAt")`: a última
 * mensagem de chat da conversa (ver `lib/conversation-last-message.ts`) e,
 * enquanto a coluna está NULL (antes do backfill, ou conversa sem mensagem
 * de chat), o `updatedAt` — a ordem de antes. Ler, atribuir ou encerrar não
 * mexe na chave. `updatedAt`, `createdAt` e `unreadCount` continuam aceitos
 * em `sortBy`. `id` desempata na MESMA direção. O cursor guarda a chave do
 * último item da página e a próxima página é
 * `WHERE (<chave>, id) < (cursor)` (ou `>` em ordem crescente) — sem OFFSET.
 *
 * Formato: base64url de `{ v: 2, k: <sortBy>, s: <ms | n>, i: <id> }`.
 * Aceitos na leitura POR UMA VERSÃO (remover no próximo ciclo):
 *   - v1 (`{ v: 1, k, s, i }`) do mesmo `sortBy`;
 *   - v1 com `k: "updatedAt"` quando a lista está na chave padrão — é o
 *     cursor que o frontend tinha em mãos no deploy (a lista padrão era por
 *     `updatedAt`). O valor vira limite na chave nova; como
 *     `COALESCE(lastMessageAt, updatedAt) <= updatedAt` na prática, a
 *     página seguinte continua do mesmo ponto no tempo, no máximo com algum
 *     item repetido que o cliente já deduplica por `id`;
 *   - o texto puro `${ms}_${id}` (formato anterior ao v1).
 *
 * Semântica com itens que mudam de posição entre páginas:
 *   - conversa que SOBE (nova mensagem) depois da página 1: passa a ter
 *     chave maior que o cursor → não aparece nas páginas seguintes, nunca
 *     duplica. Se já estava carregada, o cliente a reposiciona pelo evento
 *     SSE; se ainda não estava, entra pelo SSE (`new_message` hidrata o
 *     card por `?ids=`) ou no próximo recarregamento da 1ª página.
 *   - conversa que DESCE não existe com `lastMessageAt`/`updatedAt` (só
 *     crescem). Com `unreadCount` (zera ao ler) uma conversa já listada pode
 *     reaparecer numa página seguinte — o cliente deduplica por `id`.
 *   - nenhum item que continua parado é pulado ou repetido, mesmo com
 *     empate na chave: o `id` fecha a ordem total.
 */
import { Prisma } from "@prisma/client";

import { decodeOpaqueCursor, encodeOpaqueCursor } from "@/lib/pagination/opaque-cursor";

export type ListSortBy = "lastMessageAt" | "updatedAt" | "createdAt" | "unreadCount";
export type ListSortOrder = "asc" | "desc";
export type ListCursor = { sortVal: Date | number; id: string };

export const DEFAULT_LIST_SORT_BY: ListSortBy = "lastMessageAt";
export const LIST_SORT_BY_VALUES: readonly ListSortBy[] = [
  "lastMessageAt",
  "updatedAt",
  "createdAt",
  "unreadCount",
];

/** Versão gravada pelo `encodeListCursor`. */
export const LIST_CURSOR_VERSION = 2;

/** Cursor presente mas ilegível (ou de outra ordenação) → a rota responde 400. */
export class InvalidListCursorError extends Error {
  constructor() {
    super("Cursor inválido.");
    this.name = "InvalidListCursorError";
  }
}

function sortValFromRaw(sortBy: ListSortBy, raw: unknown): Date | number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (sortBy === "unreadCount") return raw;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Formato anterior ao v1: `${sortValMs|n}_${id}`. */
function parseLegacyListCursor(raw: string, sortBy: ListSortBy): ListCursor | null {
  const sep = raw.lastIndexOf("_");
  if (sep <= 0) return null;
  const valPart = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!id) return null;
  if (sortBy === "unreadCount") {
    const n = Number(valPart);
    return Number.isFinite(n) ? { sortVal: n, id } : null;
  }
  const asNum = Number(valPart);
  if (Number.isFinite(asNum) && asNum > 1e11) return { sortVal: new Date(asNum), id };
  const d = new Date(valPart);
  return Number.isNaN(d.getTime()) ? null : { sortVal: d, id };
}

/** O cursor `k` serve para a lista em `sortBy`? */
function cursorKeyAccepted(version: number, k: unknown, sortBy: ListSortBy): boolean {
  if (k === sortBy) return version === LIST_CURSOR_VERSION || version === 1;
  // Transição (uma versão): cursor v1 da lista padrão antiga (`updatedAt`).
  return version === 1 && sortBy === "lastMessageAt" && k === "updatedAt";
}

/** `null` = sem cursor utilizável (ausente, ilegível ou de outro `sortBy`). */
export function parseListCursor(
  raw: string | undefined | null,
  sortBy: ListSortBy,
): ListCursor | null {
  if (!raw) return null;
  const payload = decodeOpaqueCursor(raw);
  if (payload) {
    if (typeof payload.v !== "number" || !cursorKeyAccepted(payload.v, payload.k, sortBy)) {
      return null;
    }
    if (typeof payload.i !== "string" || payload.i.length === 0) return null;
    const sortVal = sortValFromRaw(sortBy, payload.s);
    return sortVal === null ? null : { sortVal, id: payload.i };
  }
  return parseLegacyListCursor(raw, sortBy);
}

export function encodeListCursor(
  sortBy: ListSortBy,
  sortVal: Date | number | string | null | undefined,
  id: string,
): string | null {
  if (sortVal == null || !id) return null;
  const s =
    typeof sortVal === "number"
      ? sortVal
      : (sortVal instanceof Date ? sortVal : new Date(sortVal)).getTime();
  if (!Number.isFinite(s)) return null;
  return encodeOpaqueCursor({ v: LIST_CURSOR_VERSION, k: sortBy, s, i: id });
}

/**
 * Valor da chave de uma linha (para o `nextCursor`). Precisa das colunas
 * cruas da conversa — `lastMessageAt` aqui é a COLUNA, não o campo da
 * resposta (que vem da prévia).
 */
export function listSortValueOf(
  sortBy: ListSortBy,
  row: {
    lastMessageAt?: Date | null;
    updatedAt: Date;
    createdAt: Date;
    unreadCount: number;
  },
): Date | number {
  if (sortBy === "createdAt") return row.createdAt;
  if (sortBy === "unreadCount") return row.unreadCount;
  if (sortBy === "lastMessageAt") return row.lastMessageAt ?? row.updatedAt;
  return row.updatedAt;
}

/**
 * Expressão SQL da chave (alias `c`). A de `lastMessageAt` é exatamente a
 * dos índices `conversations_org_last_message_at_id_idx` e
 * `conversations_open_org_last_message_at_id_idx` — mudar o texto aqui
 * desliga o índice.
 */
export function listSortColumnSql(sortBy: ListSortBy): Prisma.Sql {
  if (sortBy === "lastMessageAt") return Prisma.sql`COALESCE(c."lastMessageAt", c."updatedAt")`;
  if (sortBy === "createdAt") return Prisma.sql`c."createdAt"`;
  if (sortBy === "unreadCount") return Prisma.sql`c."unreadCount"`;
  return Prisma.sql`c."updatedAt"`;
}

/**
 * Predicado keyset em SQL (alias `c`): comparação de linha, que o Postgres
 * usa como limite de índice (para a chave padrão, os índices de expressão
 * acima). A forma `a < x OR (a = x AND id < y)` é equivalente, mas vira
 * filtro pós-leitura.
 */
export function listKeysetSql(
  sortBy: ListSortBy,
  cursor: ListCursor,
  sortOrder: ListSortOrder,
): Prisma.Sql {
  const col = listSortColumnSql(sortBy);
  return sortOrder === "desc"
    ? Prisma.sql`(${col}, c.id) < (${cursor.sortVal}, ${cursor.id})`
    : Prisma.sql`(${col}, c.id) > (${cursor.sortVal}, ${cursor.id})`;
}

/** Keyset numa coluna simples, como `where` Prisma. */
function columnKeysetWhere(
  field: "lastMessageAt" | "updatedAt" | "createdAt" | "unreadCount",
  cursor: ListCursor,
  sortOrder: ListSortOrder,
): Prisma.ConversationWhereInput {
  const val = cursor.sortVal;
  const [bound, strict] = sortOrder === "desc" ? (["lte", "lt"] as const) : (["gte", "gt"] as const);
  return {
    AND: [
      { [field]: { [bound]: val } },
      {
        OR: [
          { [field]: { [strict]: val } },
          { [field]: val, id: { [strict]: cursor.id } },
        ],
      },
    ],
  } as Prisma.ConversationWhereInput;
}

/**
 * O mesmo predicado como `where` Prisma (caminho de fallback em lotes).
 * O primeiro termo de cada keyset é redundante de propósito: dá ao planner
 * um limite simples na coluna de ordenação.
 *
 * Chave padrão: o Prisma não tem COALESCE, então o predicado se abre em dois
 * ramos que nunca dão NULL — por isso `NOT` dele também é exato:
 *   (lastMessageAt NOT NULL E keyset(lastMessageAt)) OU
 *   (lastMessageAt NULL     E keyset(updatedAt))
 */
export function listKeysetWhere(
  sortBy: ListSortBy,
  cursor: ListCursor,
  sortOrder: ListSortOrder,
): Prisma.ConversationWhereInput {
  if (sortBy !== "lastMessageAt") return columnKeysetWhere(sortBy, cursor, sortOrder);
  return {
    OR: [
      {
        AND: [
          { lastMessageAt: { not: null } },
          columnKeysetWhere("lastMessageAt", cursor, sortOrder),
        ],
      },
      {
        AND: [{ lastMessageAt: null }, columnKeysetWhere("updatedAt", cursor, sortOrder)],
      },
    ],
  };
}
