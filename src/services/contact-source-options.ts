/**
 * Origens (`source`) e UTM sources (`ad_utm_source`) distintos dos contatos
 * da org — opções do painel de filtros do Kanban.
 *
 * C2 da auditoria de banco (05/10): `GET /api/kanban/filter-options` fazia
 * `SELECT DISTINCT source FROM contacts WHERE "organizationId" = …` a cada
 * abertura do board — 19.991 execuções × 55 ms em 6 dias, lendo TODOS os
 * contatos da org (525 mil linhas devolvidas no total) para tirar uma dúzia
 * de valores. Não havia índice por (org, source).
 *
 * Agora:
 *  1) "Loose index scan": em vez de ler todas as linhas e deduplicar, a
 *     consulta pula de valor em valor pelo índice
 *     ("organizationId", source) — um acesso ao índice por valor distinto
 *     (o Postgres 17 não tem skip scan nativo; a CTE recursiva faz o mesmo).
 *     Os índices vêm da migration `20261005210000_contacts_org_source_idx`.
 *  2) Cache por org no Redis: fresco por 5 min; entre 5 e 10 min devolve o
 *     que tem e recalcula em segundo plano. Sem invalidação por escrita: o
 *     `source` de contato é gravado em dezenas de pontos (webhooks, import,
 *     API pública, automações) e uma origem NOVA demorar até 10 min para
 *     aparecer no filtro é aceitável; origens já existentes não mudam.
 *
 * `source > ''` cobre `IS NOT NULL AND <> ''` (string vazia é a menor em
 * qualquer collation) e é a forma que a condição de índice entende.
 */
import { Prisma } from "@prisma/client";

import { cache } from "@/lib/cache";
import { contactSourceOptionsKey } from "@/lib/cache/keys";
import { prisma } from "@/lib/prisma";

export const CONTACT_SOURCE_OPTIONS_LIMIT = 200;
const FRESH_SEC = 300;
const STALE_SEC = 300;

export type ContactSourceOptions = {
  sources: string[];
  utmSources: string[];
};

/**
 * Coluna → SQL. Os nomes são constantes deste arquivo (nunca entrada de
 * usuário) e precisam ser a 2ª coluna de um índice que começa por
 * "organizationId" — ver a migration.
 */
function distinctValuesSql(column: "source" | "ad_utm_source", orgId: string): Prisma.Sql {
  const col = Prisma.raw(`"${column}"`);
  return Prisma.sql`
    WITH RECURSIVE t(v) AS (
      (
        SELECT c.${col} FROM contacts c
        WHERE c."organizationId" = ${orgId} AND c.${col} > ''
        ORDER BY c.${col}
        LIMIT 1
      )
      UNION ALL
      SELECT (
        SELECT c.${col} FROM contacts c
        WHERE c."organizationId" = ${orgId} AND c.${col} > t.v
        ORDER BY c.${col}
        LIMIT 1
      )
      FROM t
      WHERE t.v IS NOT NULL
    )
    SELECT v FROM t WHERE v IS NOT NULL LIMIT ${CONTACT_SOURCE_OPTIONS_LIMIT}
  `;
}

function clean(rows: { v: string | null }[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const value = row.v?.trim();
    if (value) out.add(value);
  }
  return [...out].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

async function loadContactSourceOptions(orgId: string): Promise<ContactSourceOptions> {
  const [sources, utmSources] = await Promise.all([
    prisma.$queryRaw<{ v: string | null }[]>(distinctValuesSql("source", orgId)),
    prisma.$queryRaw<{ v: string | null }[]>(distinctValuesSql("ad_utm_source", orgId)),
  ]);
  return { sources: clean(sources), utmSources: clean(utmSources) };
}

/** Origens e UTM sources da org, já limpos e ordenados (pt-BR). */
export async function getContactSourceOptions(orgId: string): Promise<ContactSourceOptions> {
  return cache.wrapSwr(
    contactSourceOptionsKey(orgId),
    { ttlSec: FRESH_SEC, staleSec: STALE_SEC },
    () => loadContactSourceOptions(orgId),
  );
}
