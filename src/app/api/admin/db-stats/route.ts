/**
 * GET /api/admin/db-stats — auditoria de banco em runtime (PR 5.3).
 *
 * Super-admin only. Retorna JSON com:
 *   - indices nao usados
 *   - indices duplicados
 *   - foreign keys sem indice
 *   - top slow queries
 *   - tabelas com muitos seq scans
 *
 * Pensado para monitoring continuo via dashboard admin. Para
 * relatorios offline, prefira o script `npm run audit:db`.
 */
import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/auth-helpers";
import { prismaBase } from "@/lib/prisma-base";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/admin/db-stats");

const MAX_QUERY_LENGTH = 250;

type IndexUsage = {
  tablename: string;
  indexname: string;
  idx_scan: number;
  size_bytes: number;
};

type DupIndex = {
  table_name: string;
  indexes: string;
  cols: string;
};

type MissingFkIndex = {
  conrelid: string;
  conname: string;
  conkey: string;
};

type SlowQuery = {
  query: string;
  calls: number;
  total_exec_time_ms: number;
  mean_exec_time_ms: number;
  rows: number;
};

type SeqScanTable = {
  relname: string;
  seq_scan: number;
  idx_scan: number;
  n_live_tup: number;
};

export async function GET() {
  const r = await requireSuperAdmin();
  if (!r.ok) return r.response;

  try {
    const [unusedIndexes, duplicateIndexes, missingFkIndexes, slowQueries, seqScans] =
      await Promise.all([
        prismaBase.$queryRawUnsafe<IndexUsage[]>(`
          SELECT
            s.relname AS tablename,
            s.indexrelname AS indexname,
            s.idx_scan::bigint AS idx_scan,
            pg_relation_size(s.indexrelid)::bigint AS size_bytes
          FROM pg_stat_user_indexes s
          JOIN pg_index i ON i.indexrelid = s.indexrelid
          WHERE NOT i.indisunique
            AND NOT i.indisprimary
            AND s.schemaname NOT IN ('pg_catalog', 'pg_toast', 'information_schema')
            AND s.idx_scan = 0
          ORDER BY pg_relation_size(s.indexrelid) DESC
          LIMIT 50;
        `),
        prismaBase.$queryRawUnsafe<DupIndex[]>(`
          SELECT
            n.nspname || '.' || c.relname AS table_name,
            string_agg(i.relname, ', ') AS indexes,
            pg_get_indexdef(idx.indexrelid) AS cols
          FROM pg_index idx
          JOIN pg_class i ON i.oid = idx.indexrelid
          JOIN pg_class c ON c.oid = idx.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'pg_toast')
          GROUP BY n.nspname, c.relname, pg_get_indexdef(idx.indexrelid)
          HAVING COUNT(*) > 1;
        `),
        prismaBase.$queryRawUnsafe<MissingFkIndex[]>(`
          SELECT
            conrelid::regclass::text AS conrelid,
            conname,
            array_to_string(conkey, ',') AS conkey
          FROM pg_constraint c
          WHERE contype = 'f'
            AND NOT EXISTS (
              SELECT 1
              FROM pg_index i
              WHERE i.indrelid = c.conrelid
                AND (i.indkey::int[])[0:array_length(c.conkey, 1) - 1] = c.conkey
            )
            AND connamespace::regnamespace::text NOT IN ('pg_catalog', 'pg_toast');
        `),
        // pg_stat_statements pode nao estar habilitado — degradar
        // gracefully em vez de explodir o endpoint inteiro.
        prismaBase
          .$queryRawUnsafe<SlowQuery[]>(`
            SELECT
              regexp_replace(query, '\\s+', ' ', 'g') AS query,
              calls::bigint AS calls,
              ROUND(total_exec_time::numeric, 1)::float AS total_exec_time_ms,
              ROUND(mean_exec_time::numeric, 2)::float AS mean_exec_time_ms,
              rows::bigint AS rows
            FROM pg_stat_statements
            WHERE query NOT LIKE '%pg_stat_%'
              AND query NOT LIKE 'COMMIT%'
              AND query NOT LIKE 'BEGIN%'
              AND calls > 5
            ORDER BY total_exec_time DESC
            LIMIT 15;
          `)
          .catch(() => [] as SlowQuery[]),
        prismaBase.$queryRawUnsafe<SeqScanTable[]>(`
          SELECT
            relname,
            seq_scan::bigint AS seq_scan,
            idx_scan::bigint AS idx_scan,
            n_live_tup::bigint AS n_live_tup
          FROM pg_stat_user_tables
          WHERE seq_scan > 100 AND n_live_tup > 1000
          ORDER BY seq_scan DESC
          LIMIT 20;
        `),
      ]);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      unusedIndexes: unusedIndexes.map((row) => ({
        ...row,
        idx_scan: Number(row.idx_scan),
        size_bytes: Number(row.size_bytes),
      })),
      duplicateIndexes,
      missingFkIndexes,
      slowQueries: slowQueries.map((row) => ({
        ...row,
        calls: Number(row.calls),
        rows: Number(row.rows),
        query: row.query.length > MAX_QUERY_LENGTH
          ? row.query.slice(0, MAX_QUERY_LENGTH) + "…"
          : row.query,
      })),
      seqScans: seqScans.map((row) => ({
        ...row,
        seq_scan: Number(row.seq_scan),
        idx_scan: Number(row.idx_scan),
        n_live_tup: Number(row.n_live_tup),
      })),
      pgStatStatementsAvailable: slowQueries.length > 0,
    });
  } catch (err) {
    log.error({ err }, "[admin/db-stats GET] falhou");
    const msg = err instanceof Error ? err.message : "Erro ao auditar banco.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
