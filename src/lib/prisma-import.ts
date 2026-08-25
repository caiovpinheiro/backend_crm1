import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { applyOrgScope } from "@/lib/prisma";

/**
 * Pool/cliente Prisma DEDICADO para cargas em massa (import ETL, backfills).
 *
 * MOTIVAÇÃO (T3/M4): o import de 60k+ linhas rodava no MESMO pool interativo
 * (`prisma-base`, DB_POOL_MAX=20) que serve requests de TODOS os tenants.
 * Uma carga longa drenava conexões e degradava a latência das outras orgs no
 * Postgres compartilhado. Isolando o import num pool próprio e PEQUENO, o
 * impacto fica contido: no pior caso o import fica mais lento, mas os requests
 * interativos continuam com o pool deles intacto.
 *
 * DIMENSIONAMENTO: `IMPORT_DB_POOL_MAX` (default 4). Some ao DB_POOL_MAX ao
 * planejar `max_connections` do Postgres (ex.: 4 replicas x (20 + 4) = 96).
 *
 * SESSÃO (M5): cada conexão nasce com timeouts agressivos para que uma query
 * ou lock travado no import não segure conexão indefinidamente:
 *   - statement_timeout=60s              → mata query individual longa
 *   - lock_timeout=3s                    → não fica esperando lock de escrita
 *   - idle_in_transaction_session_timeout=10s → mata transação ociosa aberta
 *
 * Este cliente é BASE (sem a extension de organizationId). Callers em massa
 * rodam sob `withSystemContext(orgId)` ou passam `organizationId` explícito nas
 * queries — nunca dependa de scoping automático aqui.
 */

const globalForImport = globalThis as unknown as {
  prismaImport?: PrismaClient;
  prismaImportPool?: Pool;
};

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (!v) return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

function createImportPool(): Pool {
  const max = envInt("IMPORT_DB_POOL_MAX", 4);
  const idleTimeoutMillis = envInt("IMPORT_DB_POOL_IDLE_TIMEOUT_MS", 30_000);
  const connectionTimeoutMillis = envInt("IMPORT_DB_POOL_CONN_TIMEOUT_MS", 10_000);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    options:
      "-c statement_timeout=60000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000",
  });

  pool.on("error", (err) => {
    console.warn("[prisma-import] pool error (continuando):", err.message);
  });

  return pool;
}

export const prismaImportPool: Pool =
  globalForImport.prismaImportPool ?? createImportPool();

function createImportClient(): PrismaClient {
  const adapter = new PrismaPg(prismaImportPool);
  return new PrismaClient({
    adapter,
    log: ["error"],
  });
}

export const prismaImport: PrismaClient =
  globalForImport.prismaImport ?? createImportClient();

/**
 * Versão COM a extension de organization-scope aplicada sobre o pool de
 * import. É o client que os cores de ETL (`contact-import-core`,
 * `deal-import-core`) usam: as queries pesadas de importação saem do
 * pool interativo compartilhado e passam a rodar com
 * statement_timeout=60s / lock_timeout=3s / pool max=4.
 *
 * `allocateOrgNumber` dentro da extension continua usando `prismaBase`
 * (query pequena de contador) — apenas o tráfego de linhas do ETL é
 * isolado aqui.
 */
export const prismaImportScoped = applyOrgScope(prismaImport);

if (process.env.NODE_ENV !== "production") {
  globalForImport.prismaImportPool = prismaImportPool;
  globalForImport.prismaImport = prismaImport;
}
