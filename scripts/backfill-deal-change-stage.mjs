/**
 * Backfill de `deal:change_stage` nas roles preset MEMBER (Operador)
 * e MANAGER (Gestor).
 *
 * O preset já inclui a chave, mas roles criadas antes não herdam
 * mudanças. Sem ela, Kanban/Flow/Inbox mostram mover etapa e a API
 * responde 403.
 *
 * Idempotente. Uso: DATABASE_URL=... node scripts/backfill-deal-change-stage.mjs
 */
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

const KEY = "deal:change_stage";

const c = new Client(pgConnectionConfig());
await c.connect();

const rows = await c.query(
  `SELECT id, "organizationId", name, "systemPreset", permissions
     FROM roles
    WHERE "systemPreset" IN ('MEMBER', 'MANAGER')
      AND NOT ($1 = ANY(permissions))`,
  [KEY],
);

let updated = 0;
for (const r of rows.rows) {
  await c.query(
    `UPDATE roles SET permissions = array_append(permissions, $1) WHERE id = $2`,
    [KEY, r.id],
  );
  updated++;
  console.log(`+ ${r.name} [${r.systemPreset}] (org ${r.organizationId}) — ${KEY}`);
}

console.log(`\n${updated} role(s) atualizada(s).`);
console.log("A cache de authz por usuário expira em ~60s.");

await c.end();
