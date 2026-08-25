/**
 * Monitor v2: acompanha TODOS os DEAL_IMPORT de 5000 linhas criados hoje
 * (minha wave cop% + wave saimp%), taxa por org, fila e PG.
 *   node monitor-imports2.mjs [--interval=30] [--minutes=150]
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
const INTERVAL = Number(args.interval || 30) * 1000;
const CAP_MIN = Number(args.minutes || 150);

const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 2 });
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("import-etl", { connection });

const prev = new Map();
const t0 = Date.now();

for (;;) {
  const ops = (await pool.query(
    `SELECT b.id, b.status, b.total, b.processed, b.succeeded, b.failed,
            o.name AS org, b."startedAt", b."finishedAt",
            EXTRACT(EPOCH FROM (b."finishedAt" - b."startedAt"))::int AS dur_s
       FROM bulk_operations b JOIN organizations o ON o.id = b."organizationId"
      WHERE b.type = 'DEAL_IMPORT' AND b.total = 5000
        AND b."createdAt" > now() - interval '4 hours'
      ORDER BY b."createdAt"`,
  )).rows;

  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
  const pgAct = (await pool.query(
    `SELECT coalesce(application_name,'?') AS app, state, count(*)::int AS n
       FROM pg_stat_activity WHERE datname = current_database()
       GROUP BY 1,2 ORDER BY 1,2`,
  )).rows;
  const slow = (await pool.query(
    `SELECT application_name AS app,
            EXTRACT(EPOCH FROM (now() - query_start))::int AS secs,
            left(regexp_replace(query, '\\s+', ' ', 'g'), 100) AS q
       FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active'
        AND now() - query_start > interval '5 seconds'
        AND query NOT ILIKE '%pg_stat_activity%'
      ORDER BY 2 DESC LIMIT 4`,
  )).rows;

  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`\n[${stamp}] fila: ${JSON.stringify(counts)}`);
  for (const op of ops) {
    const p = prev.get(op.id);
    const rate = p && !["COMPLETED", "FAILED", "CANCELLED"].includes(op.status)
      ? ((op.processed - p.processed) / ((Date.now() - p.at) / 1000)).toFixed(1)
      : "-";
    prev.set(op.id, { processed: op.processed, at: Date.now() });
    const wave = op.id.startsWith("cop") ? "minha" : op.id.startsWith("saimp") ? "saimp" : "?";
    console.log(
      `  [${wave}] ${op.org.padEnd(20)} ${op.status.padEnd(10)} ${op.processed}/${op.total}` +
      ` (ok=${op.succeeded} falhas=${op.failed}) taxa=${rate} l/s` +
      (op.dur_s != null ? ` dur=${op.dur_s}s` : ""),
    );
  }
  console.log(`  pg: ${pgAct.map((r) => `${r.app}:${r.state}=${r.n}`).join(" ")}`);
  for (const s of slow) console.log(`  SLOW ${s.secs}s [${s.app}] ${s.q}`);

  const active = ops.filter((o) => ["PENDING", "PROCESSING"].includes(o.status));
  const saimpActive = active.filter((o) => o.id.startsWith("saimp"));
  if (ops.length > 0 && saimpActive.length === 0) {
    console.log("\n[monitor2] wave saimp finalizada (minhas ops já encerradas).");
    break;
  }
  if (Date.now() - t0 > CAP_MIN * 60_000) {
    console.log(`\n[monitor2] cap de ${CAP_MIN}min atingido.`);
    break;
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}

await queue.close();
await connection.quit();
await pool.end();
