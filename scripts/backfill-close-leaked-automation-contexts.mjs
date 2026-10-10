// Backfill: completa contextos RUNNING vazados (ponteiro stale em step
// que não espera resposta e sem timer armado). Esses contextos bloqueiam
// a trava de reentrada (getActiveContext no fireTrigger) — a automação
// nunca mais dispara pro contato enquanto o contexto existir.
//
// Mantém intactos os que esperam resposta de verdade (wait_for_reply,
// question, interactive, list, template) mesmo sem timeout — espera
// legítima por reply/botão.
//
// Uso (DATABASE_URL obrigatório — não há banco padrão):
//   DATABASE_URL=... node scripts/backfill-close-leaked-automation-contexts.mjs           → dry-run (só conta)
//   DATABASE_URL=... node scripts/backfill-close-leaked-automation-contexts.mjs --apply   → aplica
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

const APPLY = process.argv.includes("--apply");

const REPLY_WAITING = [
  "wait_for_reply",
  "question",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "send_whatsapp_template",
];

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error(
    "DATABASE_URL ausente. Defina a connection string do banco alvo no ambiente " +
      "(o script não tem banco padrão).",
  );
  process.exit(2);
}

const c = new Client(pgConnectionConfig(connectionString));
await c.connect();

const where = `
  ac.status = 'RUNNING'
  AND ac."timeoutAt" IS NULL
  AND ac."updatedAt" < now() - interval '1 hour'
  AND (
    ac."currentStepId" IS NULL
    OR s.type IS NULL
    OR s.type <> ALL($1)
  )
`;

const preview = await c.query(
  `SELECT a."organizationId", a.name AS automation, count(*)::int AS n
   FROM automation_contexts ac
   JOIN automations a ON a.id = ac."automationId"
   LEFT JOIN automation_steps s ON s.id = ac."currentStepId"
   WHERE ${where}
   GROUP BY 1, 2 ORDER BY n DESC`,
  [REPLY_WAITING],
);
console.log(`== ${APPLY ? "APLICANDO" : "DRY-RUN"} — contextos vazados por automação ==`);
let total = 0;
for (const r of preview.rows) {
  total += r.n;
  console.log(`  org=${r.organizationId} "${r.automation}": ${r.n}`);
}
console.log(`total: ${total}`);

if (APPLY && total > 0) {
  const res = await c.query(
    `UPDATE automation_contexts ac
     SET status = 'COMPLETED', "currentStepId" = NULL, "timeoutAt" = NULL, "updatedAt" = now()
     FROM automation_steps s
     WHERE s.id = ac."currentStepId"
       AND ac.status = 'RUNNING'
       AND ac."timeoutAt" IS NULL
       AND ac."updatedAt" < now() - interval '1 hour'
       AND s.type <> ALL($1)`,
    [REPLY_WAITING],
  );
  const nullStep = await c.query(
    `UPDATE automation_contexts ac
     SET status = 'COMPLETED', "currentStepId" = NULL, "timeoutAt" = NULL, "updatedAt" = now()
     WHERE ac.status = 'RUNNING'
       AND ac."timeoutAt" IS NULL
       AND ac."updatedAt" < now() - interval '1 hour'
       AND (ac."currentStepId" IS NULL OR NOT EXISTS (
         SELECT 1 FROM automation_steps s WHERE s.id = ac."currentStepId"
       ))`,
  );
  console.log(`atualizados: ${res.rowCount + nullStep.rowCount}`);
}

await c.end();
