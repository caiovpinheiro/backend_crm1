/**
 * Helper para queries de analytics (PR 5.2).
 *
 * Encapsula a escolha entre primary e read-replica para queries
 * READ-ONLY pesadas. Use sempre que estiver fazendo:
 *   - dashboards (counts, aggregates por periodo)
 *   - relatorios (drill-down, group by)
 *   - listagens analiticas que toleram <2s de lag
 *
 * NAO use para:
 *   - leituras transacionais (deve ver write recente do mesmo
 *     request) — use `prisma`.
 *   - writes de qualquer tipo — replica e read-only.
 *   - leituras hot que precisam ser cache (ver `lib/cache`).
 *
 * @example
 *   import { analyticsClient } from "@/lib/analytics";
 *
 *   const totals = await analyticsClient().conversation.count({
 *     where: { createdAt: { gte: from } },
 *   });
 *
 * @see docs/read-replica.md
 */
import { prisma } from "@/lib/prisma";
import {
  isReplicaActive,
  isReplicaTripped,
  prismaReplica,
  tripReplica,
} from "@/lib/prisma-replica";

type AnalyticsDb = typeof prisma;

const analyticsProxy = new Proxy({} as AnalyticsDb, {
  get(_target, prop) {
    const client: AnalyticsDb =
      !isReplicaActive() || isReplicaTripped() ? prisma : prismaReplica;
    const value = Reflect.get(client as object, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export function analyticsClient(): AnalyticsDb {
  return analyticsProxy;
}

export { tripReplica };

export function isReplicaConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connect|can't reach|P1001|P1017/i.test(
    msg,
  );
}
