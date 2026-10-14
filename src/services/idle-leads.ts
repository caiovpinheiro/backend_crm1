/**
 * "Leads parados": tempo desde a última mensagem de chat do contato.
 * Tag, campo, etapa e responsável não reiniciam o relógio (`Deal.updatedAt`
 * fica de fora — isso é o filtro `stalled`, outra semântica).
 *
 * Sem mensagem: só entra quando a direção é "qualquer um", e o relógio
 * começa em `Deal.createdAt`. Cliente ou consultor/automação exigem
 * `contacts.lastMessageDirection` "in" ou "out".
 *
 * "out" é toda mensagem de chat que saiu do CRM para o cliente: consultor,
 * automação, modelo (template) e campanha. Nota interna não entra.
 */

import { Prisma } from "@prisma/client";

export const IDLE_MINUTE_OPTIONS = [
  30, 60, 120, 180, 300, 420, 600, 720, 900, 1080, 1440,
] as const;

export type IdleDirection = "in" | "out";

const IDLE_SET = new Set<number>(IDLE_MINUTE_OPTIONS);

export function parseIdleMinutes(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || !IDLE_SET.has(n)) return undefined;
  return n;
}

export function idleCutoff(now: Date, idleMinutes: number): Date {
  return new Date(now.getTime() - idleMinutes * 60_000);
}

export function matchesIdleLead(input: {
  now: Date;
  idleMinutes: number;
  direction?: IdleDirection;
  lastMessageAt: Date | null;
  lastMessageDirection: IdleDirection | null;
  createdAt: Date;
}): boolean {
  const cutoff = idleCutoff(input.now, input.idleMinutes);
  if (input.lastMessageAt) {
    if (input.lastMessageAt.getTime() > cutoff.getTime()) return false;
    if (input.direction && input.lastMessageDirection !== input.direction) return false;
    return true;
  }
  if (input.direction) return false;
  return input.createdAt.getTime() <= cutoff.getTime();
}

/** Predicado Prisma. A direção, quando pedida, já entra aqui. */
export function idleDealWhere(
  idleMinutes: number,
  direction: IdleDirection | undefined,
  now: Date = new Date(),
): Prisma.DealWhereInput {
  const cutoff = idleCutoff(now, idleMinutes);
  if (direction) {
    return {
      contact: {
        is: {
          lastMessageDirection: direction,
          lastMessageAt: { lte: cutoff },
        },
      },
    };
  }
  return {
    OR: [
      { contact: { is: { lastMessageAt: { lte: cutoff } } } },
      {
        AND: [
          {
            OR: [{ contactId: null }, { contact: { is: { lastMessageAt: null } } }],
          },
          { createdAt: { lte: cutoff } },
        ],
      },
    ],
  };
}

/**
 * Mesma regra no SQL do funil (`deals d` + `LEFT JOIN contacts c`).
 * Vazio quando não há tempo nem direção.
 */
export function funnelMessageSql(
  idleMinutes: number | undefined,
  direction: IdleDirection | undefined,
  now: Date = new Date(),
): Prisma.Sql {
  if (idleMinutes) {
    const cutoff = idleCutoff(now, idleMinutes);
    if (direction) {
      return Prisma.sql`AND c."lastMessageAt" IS NOT NULL AND c."lastMessageAt" <= ${cutoff} AND c."lastMessageDirection" = ${direction}`;
    }
    return Prisma.sql`AND (
      (c."lastMessageAt" IS NOT NULL AND c."lastMessageAt" <= ${cutoff})
      OR (
        (d."contactId" IS NULL OR c."lastMessageAt" IS NULL)
        AND d."createdAt" <= ${cutoff}
      )
    )`;
  }
  if (direction) {
    return Prisma.sql`AND c."lastMessageAt" IS NOT NULL AND c."lastMessageDirection" = ${direction}`;
  }
  return Prisma.empty;
}

/** Estoque do funil (Prisma). Direção sem tempo usa a coluna do contato. */
export function funnelMessageWhere(
  idleMinutes: number | undefined,
  direction: IdleDirection | undefined,
  now: Date = new Date(),
): Prisma.DealWhereInput | null {
  if (idleMinutes) return idleDealWhere(idleMinutes, direction, now);
  if (direction) {
    return {
      contact: {
        is: {
          lastMessageDirection: direction,
          lastMessageAt: { not: null },
        },
      },
    };
  }
  return null;
}
