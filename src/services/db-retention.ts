/**
 * Retenção de tabelas-log — DELETE em lotes por timestamp.
 *
 * Cross-tenant (o corte é por data, não por org), então usa `prismaBase`.
 * Chamado pelo cron `/api/cron/db-retention` (todas as tabelas, manual) e
 * pelo job diário do worker (`services/db-retention-sweeper.ts`, por padrão
 * só `meta_webhook_events`).
 *
 * Base do problema (pg_stat de prod, set/2026):
 *   - meta_webhook_events  ~3,3 GB / 2 M linhas  — log cru de webhook
 *   - automation_logs      ~850 MB / 1,4 M       — idx_scan ~10k (quase nunca lido)
 *   - ai_agent_messages    ~400 MB               — trace de IA, idx_scan 0
 *   - distribution_logs    ~330 MB / 13 k linhas — bloat severo
 * Nenhuma tinha job de retenção.
 *
 * Janelas default conservadoras, sobrescrevíveis por env:
 *   DB_RETENTION_META_WEBHOOK_DAYS      (30)
 *   DB_RETENTION_AI_RUNS_DAYS           (120)  — AIAgentMessage cai por cascade
 *   DB_RETENTION_AUTOMATION_LOGS_DAYS   (120)
 *   DB_RETENTION_DISTRIBUTION_LOGS_DAYS (120)
 *
 * meta_webhook_events depende de dois índices (migration
 * 20261003120000_meta_webhook_retention_indexes — criar com CONCURRENTLY
 * em produção ANTES de ligar o cron, comandos no cabeçalho dela):
 *   - `meta_webhook_events_receivedAt_idx` — sem ele o count e cada lote
 *     varrem a tabela inteira;
 *   - `automation_logs_metaWebhookEventId_nn_idx` — a FK ON DELETE SET NULL
 *     roda um UPDATE em automation_logs por linha apagada; sem índice é um
 *     seq scan por linha e o 1º lote estoura o statement_timeout.
 * `assertRetentionIndexes` confere os dois no catálogo antes de apagar e
 * recusa a rodada se faltar algum.
 *
 * meta_webhook_events: para que serve e por que pode apagar
 * ─────────────────────────────────────────────────────────
 * A tabela é o "envelope" entre a API e o worker-meta-webhook: a rota do
 * webhook grava o corpo cru (`rawBody`) e enfileira o id; o worker lê POR
 * ID (`processStoredMetaWebhookEvent`), processa e marca `processed`.
 * Depois disso nada no código volta a ler a linha — a idempotência das
 * mensagens é por `messages.externalId`, não por esta tabela. O que sobra é
 * trilha para depuração e o vínculo opcional de `automation_logs`
 * (`metaWebhookEventId`, ON DELETE SET NULL). Por isso só apaga evento JÁ
 * PROCESSADO (`processed = true`): o que ainda não foi processado fica,
 * por mais velho que seja, para reprocesso/diagnóstico.
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
  /**
   * Condição extra do DELETE (e da contagem) — SQL constante deste arquivo.
   * Linha que não a satisfaz nunca é apagada, por mais velha que seja.
   */
  onlyWhere?: string;
  /**
   * Índices sem os quais o DELETE varre tabela inteira: `[tabela, coluna]`
   * que precisa ser a 1ª coluna de um índice válido.
   */
  requiresIndexOn?: ReadonlyArray<readonly [table: string, column: string]>;
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
      days: envDays("DB_RETENTION_META_WEBHOOK_DAYS", 30),
      onlyWhere: `"processed" = true`,
      requiresIndexOn: [
        ["meta_webhook_events", "receivedAt"],
        ["automation_logs", "metaWebhookEventId"],
      ],
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
    /** `null` quando a rodada pulou a contagem (`count: false`). */
    candidates: number | null;
    deleted: number;
    batches: number;
    hitCap: boolean;
    /** Preenchido quando a tabela foi pulada (ex.: índice ausente). */
    skipped?: string;
  }>;
};

export type RetentionOptions = {
  apply: boolean;
  only?: string[];
  /**
   * `false` pula o `count(*)` prévio (o job do worker: em
   * meta_webhook_events a contagem percorre milhões de entradas de índice
   * só para informar um número que o total apagado já dá). Default `true`.
   */
  count?: boolean;
  /** Teto de lotes por tabela nesta rodada (default e máximo: 400). */
  maxBatches?: number;
  /** Pausa entre lotes, em ms — dá fôlego ao autovacuum e à réplica. */
  pauseMs?: number;
};

/**
 * Índices exigidos que NÃO existem (ou estão INVALID). Consulta só o
 * catálogo, independente do nome do índice: basta a coluna ser a 1ª de um
 * índice válido da tabela.
 */
export async function missingRetentionIndexes(
  required: ReadonlyArray<readonly [table: string, column: string]>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const [table, column] of required) {
    const rows = await prismaBase.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
          WHERE t.relname = $1
            AND t.relnamespace = current_schema()::regnamespace
            AND a.attname = $2
            AND i.indisvalid
       ) AS ok`,
      table,
      column,
    );
    if (!rows[0]?.ok) missing.push(`${table}("${column}")`);
  }
  return missing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDbRetention(opts: RetentionOptions): Promise<RetentionRun> {
  const targets = retentionTargets().filter(
    (t) => !opts.only?.length || opts.only.includes(t.key),
  );
  const maxBatches = Math.max(
    1,
    Math.min(Math.floor(opts.maxBatches ?? MAX_BATCHES), MAX_BATCHES),
  );
  const pauseMs = Math.max(0, Math.floor(opts.pauseMs ?? 0));
  const out: RetentionRun["targets"] = [];

  for (const t of targets) {
    const cutoff = new Date(Date.now() - t.days * 86_400_000);
    // Identificadores são constantes deste arquivo — sem superfície de injeção.
    const tbl = `"${t.table}"`;
    const col = `"${t.column}"`;
    const where = `${col} < $1${t.onlyWhere ? ` AND ${t.onlyWhere}` : ""}`;

    let candidates: number | null = null;
    if (opts.count !== false) {
      const rows = await prismaBase.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM ${tbl} WHERE ${where}`,
        cutoff,
      );
      candidates = Number(rows[0]?.count ?? 0);
    }

    let deleted = 0;
    let batches = 0;
    let hitCap = false;
    let skipped: string | undefined;

    if (opts.apply && candidates !== 0) {
      const missing = t.requiresIndexOn?.length
        ? await missingRetentionIndexes(t.requiresIndexOn)
        : [];
      if (missing.length > 0) {
        // Sem o índice cada lote varre a tabela (e a FK varre
        // automation_logs por linha apagada): não apaga nada.
        skipped = `índice ausente: ${missing.join(", ")}`;
      } else {
        for (; batches < maxBatches; batches++) {
          if (batches > 0 && pauseMs > 0) await sleep(pauseMs);
          const n = await prismaBase.$executeRawUnsafe(
            `DELETE FROM ${tbl}
               WHERE ctid IN (
                 SELECT ctid FROM ${tbl} WHERE ${where} LIMIT ${BATCH}
               )`,
            cutoff,
          );
          deleted += n;
          if (n < BATCH) {
            batches++;
            break;
          }
        }
        hitCap = batches >= maxBatches;
      }
    }

    out.push({
      key: t.key,
      cutoff: cutoff.toISOString(),
      candidates,
      deleted,
      batches,
      hitCap,
      ...(skipped ? { skipped } : {}),
    });
  }

  return { apply: opts.apply, targets: out };
}
