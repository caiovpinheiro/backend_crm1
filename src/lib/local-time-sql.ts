import { Prisma } from "@prisma/client";

/** Fuso civil do painel (mesmo valor de `PAINEL_TZ` em painel-period). */
const LOCAL_TZ = "America/Sao_Paulo";

/**
 * Hora local (America/Sao_Paulo) de uma coluna `timestamp without time zone`
 * gravada em UTC (`conversations.createdAt/closedAt`, `activity_events.occurredAt`).
 *
 * `col AT TIME ZONE 'America/Sao_Paulo'` sozinho está ERRADO nessas colunas:
 * o Postgres lê o valor como hora de São Paulo e devolve um `timestamptz`, que
 * é exibido no fuso da sessão (UTC 13:00 vira 16h com a sessão em GMT, em vez
 * de 10h). O primeiro `AT TIME ZONE 'UTC'` marca o valor como UTC; o segundo
 * converte para a hora civil de SP. Funciona igual com qualquer fuso de sessão.
 *
 * Devolve `timestamp` sem fuso, em hora de São Paulo: serve para
 * `EXTRACT(HOUR|DOW ...)` e para `::date`.
 *
 * `column` é identificador fixo escrito no código (nunca entrada do usuário).
 */
export function localTs(column: string): Prisma.Sql {
  return Prisma.sql`((${Prisma.raw(column)} AT TIME ZONE 'UTC') AT TIME ZONE '${Prisma.raw(LOCAL_TZ)}')`;
}
