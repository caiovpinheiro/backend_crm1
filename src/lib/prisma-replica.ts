/**
 * Cliente Prisma para READ REPLICA (PR 5.2).
 *
 * ## Por que existe
 *
 * Em prod multi-tenant, queries de analytics (dashboards, relatorios,
 * agregacoes) competiam com writes hot (mensagens, deals, conversas)
 * pelo mesmo banco. Resultados:
 *   - p99 de mensagens batia >300ms quando alguem abria o dashboard.
 *   - Picos de I/O do primary geravam connection-pool exhaustion.
 *
 * Solucao: Postgres streaming replication (1 primary + N replicas
 * read-only). Queries READ-ONLY heavy vao pra replica; writes e
 * leituras transacionais ficam no primary. Lag tipico <1s — analytics
 * tolera segundos de defasagem (ninguem espera count exato em
 * tempo real).
 *
 * ## Configuracao
 *
 * `DATABASE_URL_REPLICA` (env, opcional):
 *   - Definido: cliente conecta a replica + queries de analytics
 *     usam essa pool.
 *   - Ausente: `prismaReplica` aponta pro mesmo cliente do primary
 *     (`prisma`). Zero esforco em dev/single-node — analytics
 *     simplesmente cai no primary.
 *
 * Em EasyPanel/Docker Swarm com hot-standby:
 *   ```
 *   DATABASE_URL=postgresql://user:pwd@pg-primary:5432/crm?sslmode=require
 *   DATABASE_URL_REPLICA=postgresql://user:pwd@pg-replica:5432/crm?sslmode=require
 *   ```
 * DigitalOcean: use `private-*.db.ondigitalocean.com:25060` + `sslmode=require`.
 *
 * Em SaaS (Neon, Supabase): geralmente expoe um endpoint dedicado
 * pra leitura.
 *
 * ## Uso
 *
 * NUNCA importar diretamente em rotas. Use o helper:
 *
 * ```ts
 * import { analyticsClient } from "@/lib/analytics";
 * const counts = await analyticsClient().conversation.count({...});
 * ```
 *
 * `analyticsClient()` retorna `prismaReplica` quando configurado.
 * Em testes/dev sem replica, devolve `prisma` — mesma API, sem
 * codigo duplicado nas rotas.
 *
 * ## Limites conscientes
 *
 * - **Sem write**: replica recusa com SQLSTATE 25006. Se um caller
 *   chamar `prismaReplica.x.create()`, o Postgres responde com erro.
 *   Por isso o helper `analyticsClient()` documenta que e read-only.
 * - **Lag**: typically <1s mas pode subir em deploys/manutencao da
 *   replica. Analytics tolera; outras leituras (perfil, settings,
 *   conversation list) DEVEM ficar no primary.
 * - **Mesma extension RLS**: aplicamos a mesma extension de
 *   organization-scope. RLS policies (PR 1.4) tambem funcionam na
 *   replica — sao replicadas via WAL.
 *
 * @see docs/read-replica.md
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { applyOrgScope, prisma } from "@/lib/prisma";

const REPLICA_URL = process.env.DATABASE_URL_REPLICA?.trim() || "";

const globalForReplica = globalThis as unknown as {
  prismaReplicaBase: PrismaClient | undefined;
  prismaReplicaScoped: ReturnType<typeof applyOrgScope> | undefined;
};

function createReplicaBase(): PrismaClient | null {
  if (!REPLICA_URL) return null;
  try {
    const pool = new Pool({
      connectionString: REPLICA_URL,
      // Pool menor que o primary — analytics nao precisa muita
      // concorrencia. Ajustar se aparecer "too many clients".
      max: 5,
      idleTimeoutMillis: 30_000,
      // DEV/EasyPanel often inherits DATABASE_URL_REPLICA from prod
      // (private hostname). Without a connect timeout the first query
      // hangs until the proxy returns 502 HTML.
      connectionTimeoutMillis: 2_000,
    });
    const adapter = new PrismaPg(pool);
    return new PrismaClient({
      adapter,
      log:
        process.env.NODE_ENV === "development"
          ? [{ emit: "stdout", level: "warn" }, { emit: "stdout", level: "error" }]
          : ["error"],
    });
  } catch (err) {
    // Sem replica = degrada graciosamente pro primary.
    console.warn("[prisma-replica] falha ao criar pool:", err);
    return null;
  }
}

function getReplicaBase(): PrismaClient | null {
  if (!REPLICA_URL) return null;
  if (globalForReplica.prismaReplicaBase) return globalForReplica.prismaReplicaBase;
  const created = createReplicaBase();
  if (!created) return null;
  globalForReplica.prismaReplicaBase = created;
  return created;
}

function getReplicaScoped(): ReturnType<typeof applyOrgScope> {
  if (globalForReplica.prismaReplicaScoped) {
    return globalForReplica.prismaReplicaScoped;
  }
  const base = getReplicaBase();
  if (!base) {
    // Sem replica — aponta pro primary scoped. Mesma API, callers
    // nao precisam saber a diferenca.
    return prisma;
  }
  const extended = applyOrgScope(base);
  if (process.env.NODE_ENV !== "production") {
    globalForReplica.prismaReplicaScoped = extended;
  }
  return extended;
}

/**
 * Cliente Prisma scoped apontado pra READ REPLICA. Veja header do
 * arquivo pra detalhes de uso e configuracao.
 */
export const prismaReplica = getReplicaScoped();

/**
 * `true` quando `DATABASE_URL_REPLICA` esta configurado e o pool foi
 * criado com sucesso. Util pra UI mostrar badge "data lagged" ou
 * monitoring.
 */
export function isReplicaActive(): boolean {
  return REPLICA_URL.length > 0 && Boolean(globalForReplica.prismaReplicaBase);
}
