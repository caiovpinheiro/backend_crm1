/** Estado da fila import-etl + progresso do import ativo. */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("import-etl", { connection });
const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 2 });

const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
console.log("counts:", JSON.stringify(counts));

const active = await queue.getJobs(["active", "delayed", "waiting"], 0, 5);
for (const j of active) {
  console.log(`job ${j.id} name=${j.name} state=${await j.getState()} attempts=${j.attemptsMade} org=${j.data?.organizationId} op=${j.data?.operationId} ts=${new Date(j.timestamp).toISOString()} processedOn=${j.processedOn ? new Date(j.processedOn).toISOString() : "-"}`);
}

const ops = (await pool.query(`
  SELECT b.id, b.status, b.total, b.processed, b.succeeded, b.failed,
         b."startedAt", now() AS agora,
         EXTRACT(EPOCH FROM (now() - b."startedAt"))::int AS secs
    FROM bulk_operations b
   WHERE b.type IN ('CONTACT_IMPORT','DEAL_IMPORT') AND b.status IN ('PENDING','PROCESSING')
   ORDER BY b."createdAt"`)).rows;
console.log("ops:", JSON.stringify(ops, null, 2));

await queue.close();
await connection.quit();
await pool.end();
