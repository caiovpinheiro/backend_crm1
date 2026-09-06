/**
 * Retenção de tabelas-log — DELETE em lotes por timestamp.
 *
 * Cross-tenant (o corte é por data, não por org), então usa `prismaBase`.
 * Chamado só pelo cron `/api/cron/db-retention`.
 *
 * Base do problema (pg_stat de prod, set/2026):
 *   - meta_webhook_events  ~3,3 GB / 2 M linhas  — log cru de webhook
 *   - automation_logs      ~850 MB / 1,4 M       — idx_scan ~10k (quase nunca lido)
 *   - ai_agent_messages    ~400 MB               — trace de IA, idx_scan 0
 *   - distribution_logs    ~330 MB / 13 k linhas — bloat severo
 * Nenhuma tinha job de retenção.
 *
 * Janelas default conservadoras, sobrescrevíveis por env:
 *   DB_RETENTION_META_WEBHOOK_DAYS      (21)
 *   DB_RETENTION_AI_RUNS_DAYS           (120)  — AIAgentMessage cai por cascade
 *   DB_RETENTION_AUTOMATION_LOGS_DAYS   (120)
 *   DB_RETENTION_DISTRIBUTION_LOGS_DAYS (120)
 *
 * `VACUUM FULL` (recuperar disco de bloat pré-existente, ex.: distribution_logs)
 * NÃO é feito aqui — trava a tabela. Rodar manual numa janela de manutenção.
 */

import { prismaBase } from "@/lib/prisma-base";

type RetentionTarget = {
  key: string;
  /** Nome físico da tabela — constante, nunca entrada de usuário. */
  table: string;
  /** Coluna de timestamp — constante. */
  column: string;
  days: number;
};

const BATCH = 5_000;
/** Teto por tabela por execução: 400 * 5k = 2 M linhas. Evita rodada infinita. */
const MAX_BATCHES = 400;

function envDays(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function retentionTargets(): RetentionTarget[] {
  return [
    {
      key: "meta_webhook_events",
      table: "meta_webhook_events",
      column: "receivedAt",
      days: envDays("DB_RETENTION_META_WEBHOOK_DAYS", 21),
    },
    {
      key: "ai_agent_runs",
      table: "ai_agent_runs",
      column: "createdAt",
      days: envDays("DB_RETENTION_AI_RUNS_DAYS", 120),
    },
    {
      key: "automation_logs",
      table: "automation_logs",
      column: "executedAt",
      days: envDays("DB_RETENTION_AUTOMATION_LOGS_DAYS", 120),
    },
    {
      key: "distribution_logs",
      table: "distribution_logs",
      column: "createdAt",
      days: envDays("DB_RETENTION_DISTRIBUTION_LOGS_DAYS", 120),
    },
  ];
}

export type RetentionRun = {
  apply: boolean;
  targets: Array<{
    key: string;
    cutoff: string;
    candidates: number;
    deleted: number;
    batches: number;
    hitCap: boolean;
  }>;
};

export async function runDbRetention(opts: {
  apply: boolean;
  only?: string[];
}): Promise<RetentionRun> {
  const targets = retentionTargets().filter(
    (t) => !opts.only?.length || opts.only.includes(t.key),
  );
  const out: RetentionRun["targets"] = [];

  for (const t of targets) {
    const cutoff = new Date(Date.now() - t.days * 86_400_000);
    // Identificadores são constantes deste arquivo — sem superfície de injeção.
    const tbl = `"${t.table}"`;
    const col = `"${t.column}"`;

    const rows = await prismaBase.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM ${tbl} WHERE ${col} < $1`,
      cutoff,
    );
    const candidates = Number(rows[0]?.count ?? 0);

    let deleted = 0;
    let batches = 0;
    let hitCap = false;

    if (opts.apply && candidates > 0) {
      for (; batches < MAX_BATCHES; batches++) {
        const n = await prismaBase.$executeRawUnsafe(
          `DELETE FROM ${tbl}
             WHERE ctid IN (
               SELECT ctid FROM ${tbl} WHERE ${col} < $1 LIMIT ${BATCH}
             )`,
          cutoff,
        );
        deleted += n;
        if (n < BATCH) {
          batches++;
          break;
        }
      }
      hitCap = batches >= MAX_BATCHES;
    }

    out.push({
      key: t.key,
      cutoff: cutoff.toISOString(),
      candidates,
      deleted,
      batches,
      hitCap,
    });
  }

  return { apply: opts.apply, targets: out };
}
