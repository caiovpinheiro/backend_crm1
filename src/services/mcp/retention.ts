/**
 * Retenção das tabelas do MCP — limpeza em lotes, oportunista.
 *
 * Disparada pelo próprio processo MCP (`/mcp`) no máximo 1x/hora por
 * processo; idempotente entre réplicas. Sem cron nem worker novo.
 *   - `mcp_tokens`: ACCESS/REFRESH expirados há mais de 1 dia. CODE fica
 *     (um por consentimento; guarda o teto de escopos da conexão).
 *   - `mcp_audit_logs`: mais velho que `MCP_AUDIT_RETENTION_DAYS` (180).
 * Identificadores são constantes deste arquivo; o corte vai como parâmetro.
 */
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import { runtimeEnv } from "@/lib/runtime-env";

const log = getLogger("mcp.retention");

const BATCH = 5_000;
const MAX_BATCHES = 20;
const INTERVAL_MS = 60 * 60 * 1000;

let lastRunAt = 0;
let running = false;

export function auditRetentionDays(): number {
  const n = Number(runtimeEnv("MCP_AUDIT_RETENTION_DAYS"));
  return Number.isFinite(n) && n >= 7 ? Math.floor(n) : 180;
}

async function deleteInBatches(sql: string, cutoff: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await prismaBase.$executeRawUnsafe(sql, cutoff);
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

export async function purgeMcpData(now = Date.now()): Promise<{ tokens: number; audit: number }> {
  const tokens = await deleteInBatches(
    `DELETE FROM "mcp_tokens" WHERE ctid IN (
       SELECT ctid FROM "mcp_tokens"
        WHERE "expiresAt" < $1 AND "kind" <> 'CODE'
        LIMIT ${BATCH})`,
    new Date(now - 24 * 3600 * 1000),
  );
  const audit = await deleteInBatches(
    `DELETE FROM "mcp_audit_logs" WHERE ctid IN (
       SELECT ctid FROM "mcp_audit_logs" WHERE "createdAt" < $1 LIMIT ${BATCH})`,
    new Date(now - auditRetentionDays() * 24 * 3600 * 1000),
  );
  return { tokens, audit };
}

/** Fire-and-forget; nunca derruba a requisição. */
export function maybePurgeMcpData(): void {
  const now = Date.now();
  if (running || now - lastRunAt < INTERVAL_MS) return;
  lastRunAt = now;
  running = true;
  void purgeMcpData(now)
    .then((r) => {
      if (r.tokens || r.audit) log.info(r, "[mcp.retention] limpeza");
    })
    .catch((err) => log.warn({ err: (err as Error).message }, "[mcp.retention] falhou"))
    .finally(() => {
      running = false;
    });
}

export function resetMcpRetentionForTests(): void {
  lastRunAt = 0;
  running = false;
}
