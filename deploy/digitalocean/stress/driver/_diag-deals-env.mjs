/**
 * Diagnóstico pré-simulador de import/export de deals.
 * Lista orgs, usuários admin, pipelines/stages, deals existentes,
 * imports ativos (guard M6) e tokens de API.
 */
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.PG_URL, max: 4 });

const orgs = (await pool.query(`
  SELECT o.id, o.name, o.status,
         (SELECT u.id FROM users u WHERE u."organizationId" = o.id AND u.role = 'ADMIN' LIMIT 1) AS admin_id,
         (SELECT u.email FROM users u WHERE u."organizationId" = o.id AND u.role = 'ADMIN' LIMIT 1) AS admin_email,
         (SELECT count(*)::int FROM deals d WHERE d."organizationId" = o.id) AS deals,
         (SELECT count(*)::int FROM contacts c WHERE c."organizationId" = o.id) AS contacts,
         (SELECT count(*)::int FROM api_tokens t WHERE t."organizationId" = o.id) AS tokens
    FROM organizations o
   ORDER BY o.name`)).rows;

console.log("=== ORGS ===");
for (const o of orgs) console.log(JSON.stringify(o));

console.log("\n=== PIPELINES/STAGES por org (primeiras 3 stages) ===");
for (const o of orgs) {
  const stages = (await pool.query(
    `SELECT p.name AS pipeline, s.name AS stage
       FROM stages s JOIN pipelines p ON p.id = s."pipelineId"
      WHERE p."organizationId" = $1
      ORDER BY p."createdAt", s.position LIMIT 3`,
    [o.id],
  )).rows;
  console.log(`${o.name}: ${JSON.stringify(stages)}`);
}

console.log("\n=== IMPORTS ATIVOS (guard M6: PENDING/PROCESSING) ===");
const active = (await pool.query(`
  SELECT b.id, b.type, b.status, b."organizationId", o.name AS org, b.total, b.processed, b."createdAt"
    FROM bulk_operations b JOIN organizations o ON o.id = b."organizationId"
   WHERE b.type IN ('CONTACT_IMPORT','DEAL_IMPORT') AND b.status IN ('PENDING','PROCESSING')
   ORDER BY b."createdAt"`)).rows;
console.log(active.length === 0 ? "(nenhum)" : JSON.stringify(active, null, 2));

console.log("\n=== BULK OPERATIONS recentes (qualquer tipo) ===");
const recent = (await pool.query(`
  SELECT b.type, b.status, count(*)::int AS n
    FROM bulk_operations b
   WHERE b."createdAt" > now() - interval '6 hours'
   GROUP BY 1,2 ORDER BY 1,2`)).rows;
console.log(JSON.stringify(recent));

console.log("\n=== PG: conexões e atividade ===");
const conns = (await pool.query(`
  SELECT state, count(*)::int AS n FROM pg_stat_activity
   WHERE datname = current_database() GROUP BY state ORDER BY 2 DESC`)).rows;
console.log(JSON.stringify(conns));
const dbSize = (await pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`)).rows;
console.log(JSON.stringify(dbSize));

await pool.end();
