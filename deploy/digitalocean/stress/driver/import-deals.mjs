/**
 * Simulador de importação de NEGÓCIOS (deals) multi-tenant.
 *
 * Replica fielmente o que POST /api/deals/import faz (a rota exige sessão
 * NextAuth, inviável para 6 orgs):
 *   1. Respeita o guard M6 (import-guard.ts): 1 import ativo por org — orgs
 *      com BulkOperation PENDING/PROCESSING de CONTACT_IMPORT/DEAL_IMPORT
 *      são puladas (a rota retornaria 409).
 *   2. Gera CSV sintético com as colunas que deal-import-core.ts espera
 *      (title + pipeline_name/stage_name + value/status/contato/owner...).
 *   3. Cria o BulkOperation (type=DEAL_IMPORT, PENDING) com o arquivo embutido
 *      em payload.fileContentB64 — igual à rota.
 *   4. Enfileira o job `deal-import` na fila `import-etl` com o MESMO payload
 *      e as MESMAS opções de enqueueImportEtl (attempts=3, backoff exp 10s).
 *
 * O processamento real continua a cargo do etl-worker (concurrency=1).
 *
 *   node import-deals.mjs [--rows=5000] [--only=<nome>] [--dry]
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const PG_URL = process.env.PG_URL;
const REDIS_URL = process.env.REDIS_URL;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const ROWS = Number(args.rows || 5000);
const CONTACT_POOL = 200; // e-mails de contato reutilizados por org (preload IN)
const RUN = `str${Date.now().toString(36)}`;

const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const importQueue = new Queue("import-etl", { connection });

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function makeCsv(org, stagePair, ownerEmail, run) {
  const headers = [
    "title", "value", "status", "pipeline_name", "stage_name",
    "contact_name", "contact_email", "owner_email", "expected_close", "external_id",
  ];
  const lines = [headers.join(",")];
  const orgKey = org.id.replace(/[^a-z0-9]/gi, "").slice(-6);
  for (let i = 1; i <= ROWS; i++) {
    const c = i % CONTACT_POOL;
    const month = 9 + (i % 4); // set..dez 2026
    const day = 1 + (i % 28);
    lines.push([
      csvCell(`Negócio Stress ${run} ${i}`),
      String(100 + ((i * 37) % 50000)), // valor determinístico, decimal com ponto
      "OPEN",
      csvCell(stagePair.pipeline),
      csvCell(stagePair.stage),
      csvCell(`Contato Stress ${orgKey} ${c}`),
      `stress.imp.${run}.${orgKey}.c${c}@example.com`,
      ownerEmail,
      `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      `${run}-${orgKey}-${i}`,
    ].join(","));
  }
  return Buffer.from(lines.join("\r\n"), "utf-8");
}

const orgs = (await pool.query(`
  SELECT o.id, o.name,
         (SELECT u.id FROM users u WHERE u."organizationId" = o.id AND u.role = 'ADMIN' LIMIT 1) AS admin_id,
         (SELECT u.email FROM users u WHERE u."organizationId" = o.id AND u.role = 'ADMIN' LIMIT 1) AS admin_email
    FROM organizations o
   WHERE o.status = 'ACTIVE'
   ORDER BY o.name`)).rows;

const alvo = args.only
  ? orgs.filter((o) => o.name.toLowerCase().includes(String(args.only).toLowerCase()))
  : orgs;

console.log(`[import-deals] run=${RUN} orgs=${alvo.length} linhas/org=${ROWS}`);

const enqueued = [];
for (const org of alvo) {
  if (!org.admin_id) {
    console.warn(`[import-deals] ${org.name}: sem usuário ADMIN — pulando`);
    continue;
  }

  // Guard M6 (import-guard.ts): 1 import ativo por org. A rota retornaria 409.
  const active = (await pool.query(
    `SELECT id, type, status FROM bulk_operations
      WHERE "organizationId" = $1
        AND type IN ('CONTACT_IMPORT','DEAL_IMPORT')
        AND status IN ('PENDING','PROCESSING')
      LIMIT 1`,
    [org.id],
  )).rows[0];
  if (active) {
    console.warn(`[import-deals] ${org.name}: import ativo ${active.id} (${active.type}/${active.status}) — pulando (rota retornaria 409)`);
    continue;
  }

  const stagePair = (await pool.query(
    `SELECT p.name AS pipeline, s.name AS stage
       FROM stages s JOIN pipelines p ON p.id = s."pipelineId"
      WHERE p."organizationId" = $1
      ORDER BY p."createdAt", s.position LIMIT 1`,
    [org.id],
  )).rows[0];
  if (!stagePair) {
    console.warn(`[import-deals] ${org.name}: sem pipeline/stage — pulando`);
    continue;
  }

  const csv = makeCsv(org, stagePair, org.admin_email, RUN);
  const fileName = `deals-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.csv`;
  const originalName = `stress-deals-${RUN}-${org.name.replace(/\s+/g, "_")}.csv`;
  const tagName = `__STRESS_IMPORT__ ${RUN}`;

  if (args.dry) {
    console.log(`[import-deals] (dry) ${org.name}: ${ROWS} linhas, ${(csv.length / 1024).toFixed(0)} KiB CSV, stage=${stagePair.pipeline}/${stagePair.stage}`);
    continue;
  }

  // Espelha a rota: BulkOperation PENDING com o arquivo embutido em base64.
  const opId = `cop${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  await pool.query(
    `INSERT INTO bulk_operations
       (id, "organizationId", type, status, total, processed, succeeded, failed,
        payload, "createdById", "createdAt", "updatedAt")
     VALUES ($1,$2,'DEAL_IMPORT','PENDING',$3,0,0,0,$4::jsonb,$5, now(), now())`,
    [
      opId,
      org.id,
      ROWS,
      JSON.stringify({
        fileName,
        originalName,
        updateExisting: true,
        importMode: "upsert",
        fileContentB64: csv.toString("base64"),
        delimiter: ",",
        tagName,
      }),
      org.admin_id,
    ],
  );

  // Espelha enqueueImportEtl(IMPORT_ETL_JOB_NAMES.dealImport, payload):
  // attempts=3 (IMPORT_ETL_MAX_ATTEMPTS), backoff exponencial 10s.
  await importQueue.add("deal-import", {
    operationId: opId,
    organizationId: org.id,
    initiatedByUserId: org.admin_id,
    fileName,
    originalName,
    delimiter: ",",
    updateExisting: true,
    importMode: "upsert",
    tagName,
  }, {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
    attempts: 3,
    backoff: { type: "exponential", delay: 10000 },
  });

  enqueued.push({ org: org.name, operationId: opId, rows: ROWS, csvKiB: Math.round(csv.length / 1024) });
  console.log(`[import-deals] ${org.name}: BulkOperation ${opId} enfileirado (${ROWS} linhas, stage ${stagePair.pipeline}/${stagePair.stage})`);
}

console.log(`\n[import-deals] ${enqueued.length} imports enfileirados — run=${RUN}`);
console.log(JSON.stringify(enqueued, null, 2));

await importQueue.close();
await connection.quit();
await pool.end();
