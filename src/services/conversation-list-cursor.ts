/**
 * Keyset da lista do inbox (`GET /api/conversations`).
 *
 * Ordenação da lista: `<sortBy> <dir>, id <dir>` — `sortBy` é `updatedAt`
 * (padrão: sobe a cada mensagem/alteração da conversa), `createdAt` ou
 * `unreadCount`; `id` desempata na MESMA direção. O cursor guarda a chave
 * do último item da página e a próxima página é
 * `WHERE (<sortBy>, id) < (cursor)` (ou `>` em ordem crescente) — sem OFFSET.
 *
 * Formato: base64url de `{ v: 1, k: <sortBy>, s: <ms | n>, i: <id> }`.
 * O formato antigo `${ms}_${id}` (texto puro) continua aceito na leitura:
 * um cliente que recebeu o cursor de um backend anterior não quebra.
 *
 * Semântica com itens que mudam de posição entre páginas (a chave padrão
 * `updatedAt` muda a cada mensagem):
 *   - conversa que SOBE (nova mensagem) depois da página 1: passa a ter
 *     chave maior que o cursor → não aparece nas páginas seguintes, nunca
 *     duplica. Se já estava carregada, o cliente a reposiciona pelo evento
 *     SSE; se ainda não estava, entra pelo SSE (`new_message` hidrata o
 *     card por `?ids=`) ou no próximo recarregamento da 1ª página.
 *   - conversa que DESCE não existe com `updatedAt` (só cresce). Com
 *     `unreadCount` (zera ao ler) uma conversa já listada pode reaparecer
 *     numa página seguinte — o cliente deduplica por `id`.
 *   - nenhum item que continua parado é pulado ou repetido, mesmo com
 *     empate na chave: o `id` fecha a ordem total.
 */
import { Prisma } from "@prisma/client";

import { decodeOpaqueCursor, encodeOpaqueCursor } from "@/lib/pagination/opaque-cursor";

export type ListSortBy = "updatedAt" | "createdAt" | "unreadCount";
export type ListSortOrder = "asc" | "desc";
export type ListCursor = { sortVal: Date | number; id: string };

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

/** Formato anterior: `${sortValMs|n}_${id}`. */
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

/** `null` = sem cursor utilizável (ausente, ilegível ou de outro `sortBy`). */
export function parseListCursor(
  raw: string | undefined | null,
  sortBy: ListSortBy,
): ListCursor | null {
  if (!raw) return null;
  const payload = decodeOpaqueCursor(raw);
  if (payload) {
    if (payload.v !== 1 || payload.k !== sortBy) return null;
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
  return encodeOpaqueCursor({ v: 1, k: sortBy, s, i: id });
}

export function listSortColumnSql(sortBy: ListSortBy): Prisma.Sql {
  if (sortBy === "createdAt") return Prisma.sql`c."createdAt"`;
  if (sortBy === "unreadCount") return Prisma.sql`c."unreadCount"`;
  return Prisma.sql`c."updatedAt"`;
}

/**
 * Predicado keyset em SQL (alias `c`): comparação de linha, que o Postgres
 * usa como limite de índice (`(organizationId, updatedAt, id)` e, pelo
 * prefixo, `(organizationId, status, updatedAt)`). A forma
 * `a < x OR (a = x AND id < y)` é equivalente, mas vira filtro pós-leitura.
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

/**
 * O mesmo predicado como `where` Prisma (caminho de fallback em lotes).
 * O primeiro termo é redundante de propósito: dá ao planner um limite
 * simples na coluna de ordenação.
 */
export function listKeysetWhere(
  sortBy: ListSortBy,
  cursor: ListCursor,
  sortOrder: ListSortOrder,
): Prisma.ConversationWhereInput {
  const val = cursor.sortVal;
  const [bound, strict] = sortOrder === "desc" ? (["lte", "lt"] as const) : (["gte", "gt"] as const);
  return {
    AND: [
      { [sortBy]: { [bound]: val } },
      {
        OR: [
          { [sortBy]: { [strict]: val } },
          { [sortBy]: val, id: { [strict]: cursor.id } },
        ],
      },
    ],
  } as Prisma.ConversationWhereInput;
}
