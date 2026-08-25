/**
 * Monitor do simulador de import de deals: a cada --interval s imprime
 *   - progresso de cada BulkOperation DEAL_IMPORT do run (processed/total, taxa/s)
 *   - estado da fila import-etl (waiting/active)
 *   - PG: conexões por application_name e queries ativas > 5s
 * Termina quando todas as ops finalizarem ou após --minutes.
 *
 *   node monitor-imports.mjs --run=<RUN> [--interval=15] [--minutes=120]
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const RUN = args.run;
const INTERVAL = Number(args.interval || 15) * 1000;
const CAP_MIN = Number(args.minutes || 120);
if (!RUN) {
  console.error("uso: node monitor-imports.mjs --run=<RUN>");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 2 });
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("import-etl", { connection });

const prev = new Map(); // opId -> { processed, at }
const t0 = Date.now();

for (;;) {
  const ops = (await pool.query(
    `SELECT b.id, b.status, b.total, b.processed, b.succeeded, b.failed,
            o.name AS org, b."startedAt", b."finishedAt",
            jsonb_array_length(COALESCE(b.errors,'[]'::jsonb)) AS err_entries
       FROM bulk_operations b JOIN organizations o ON o.id = b."organizationId"
      WHERE b.type = 'DEAL_IMPORT' AND b.payload->>'originalName' LIKE $1
      ORDER BY o.name`,
    [`%${RUN}%`],
  )).rows;

  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
  const pgAct = (await pool.query(
    `SELECT application_name AS app, state, count(*)::int AS n
       FROM pg_stat_activity WHERE datname = current_database()
       GROUP BY 1,2 ORDER BY 1,2`,
  )).rows;
  const slow = (await pool.query(
    `SELECT application_name AS app,
            EXTRACT(EPOCH FROM (now() - query_start))::int AS secs,
            left(regexp_replace(query, '\\s+', ' ', 'g'), 110) AS q
       FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active'
        AND now() - query_start > interval '5 seconds'
        AND query NOT ILIKE '%pg_stat_activity%'
      ORDER BY 2 DESC LIMIT 5`,
  )).rows;

  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`\n[${stamp}] fila: ${JSON.stringify(counts)}`);
  for (const op of ops) {
    const p = prev.get(op.id);
    const rate = p ? ((op.processed - p.processed) / ((Date.now() - p.at) / 1000)).toFixed(1) : "-";
    prev.set(op.id, { processed: op.processed, at: Date.now() });
    console.log(
      `  ${op.org.padEnd(20)} ${op.status.padEnd(10)} ${op.processed}/${op.total}` +
      ` (ok=${op.succeeded} falhas=${op.failed} errEntries=${op.err_entries}) taxa=${rate} l/s`,
    );
  }
  const pgSummary = pgAct.map((r) => `${r.app || "?"}:${r.state}=${r.n}`).join(" ");
  console.log(`  pg: ${pgSummary}`);
  for (const s of slow) console.log(`  SLOW ${s.secs}s [${s.app}] ${s.q}`);

  const allDone = ops.length > 0 && ops.every((o) => !["PENDING", "PROCESSING"].includes(o.status));
  if (allDone) {
    console.log("\n[monitor] todas as operações finalizaram.");
    break;
  }
  if (Date.now() - t0 > CAP_MIN * 60_000) {
    console.log(`\n[monitor] cap de ${CAP_MIN}min atingido.`);
    break;
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}

await queue.close();
await connection.quit();
await pool.end();
