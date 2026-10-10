/**
 * Preenche o EMAIL base do contato a partir do campo personalizado `email`
 * do negócio (relatório de matriculados gravou o email no cf do deal, não no
 * `contact.email`). Só toca contatos SEM email base. Escolhe o email válido
 * do negócio mais recente.
 *
 * Uso:
 *   node --env-file=.env scripts/backfill-contact-email-from-deal-cf.mjs           # dry-run
 *   node --env-file=.env scripts/backfill-contact-email-from-deal-cf.mjs --apply
 *   Opcional: CF_NAME=email_academico (default: email)
 */
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

const APPLY = process.argv.includes("--apply");
const CF_NAME = process.env.CF_NAME ?? "email";
const c = new Client(pgConnectionConfig());
await c.connect();

let orgId = process.env.TARGET_ORG_ID ?? null;
if (!orgId) {
  orgId = (await c.query(`SELECT "organizationId" FROM contacts GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`)).rows[0]?.organizationId ?? null;
}

const cf = (await c.query(
  `SELECT id FROM custom_fields WHERE "organizationId"=$1 AND entity='deal' AND name=$2 LIMIT 1`,
  [orgId, CF_NAME])).rows[0];
if (!cf) { console.error(`Campo personalizado de negócio "${CF_NAME}" não encontrado.`); process.exit(1); }

const candidatesSql = `
  SELECT DISTINCT ON (d."contactId") d."contactId" AS contact_id, lower(v.value) AS email
    FROM deals d
    JOIN deal_custom_field_values v ON v."dealId" = d.id AND v."customFieldId" = $2
    JOIN contacts ct ON ct.id = d."contactId"
   WHERE d."organizationId" = $1
     AND v.value ~* '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'
     AND (ct.email IS NULL OR ct.email = '')
   ORDER BY d."contactId", d."createdAt" DESC
`;

const preview = await c.query(candidatesSql, [orgId, cf.id]);
console.log(`Modo: ${APPLY ? "APPLY" : "DRY-RUN"} | org=${orgId} | cf=${CF_NAME}`);
console.log(`Contatos que receberão email: ${preview.rowCount}`);
console.log("\nAmostra:");
for (const r of preview.rows.slice(0, 12)) console.log(`  ${r.contact_id} -> ${r.email}`);

if (APPLY) {
  const res = await c.query(
    `UPDATE contacts ct SET email = sub.email, "updatedAt" = now()
       FROM (${candidatesSql}) sub
      WHERE ct.id = sub.contact_id`,
    [orgId, cf.id],
  );
  console.log(`\n✅ Emails preenchidos: ${res.rowCount} contatos.`);
} else {
  console.log("\nDry-run: nada gravado. Rode com --apply para aplicar.");
}

await c.end();
