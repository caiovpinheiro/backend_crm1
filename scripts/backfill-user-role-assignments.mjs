/**
 * Backfill de `user_role_assignments` para users criados antes do fix
 * do POST/PUT /api/users (2026-05-20).
 *
 * Procura users HUMAN (nao IA, nao erased) cuja org tem os 3 presets
 * cadastrados e que ainda nao tem nenhum assignment. Cria o
 * UserRoleAssignment compatibilizando `User.role` -> `Role.systemPreset`.
 *
 * Idempotente: skipa users que ja tem assignment do preset correto.
 */
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

const c = new Client(pgConnectionConfig());
await c.connect();

const VALID_ROLES = new Set(["ADMIN", "MANAGER", "MEMBER"]);

const targetOrg = process.env.TARGET_ORG_ID ?? null;

const orgFilter = targetOrg ? `WHERE u."organizationId" = '${targetOrg}'` : "";

const users = await c.query(
  `SELECT u.id, u.email, u.role, u."organizationId"
     FROM users u
     ${orgFilter}
       ${targetOrg ? "AND" : "WHERE"} u.type = 'HUMAN'
       AND u."isErased" = false
       AND u."organizationId" IS NOT NULL
     ORDER BY u."organizationId", u.email`,
);

console.log(`Vistoriando ${users.rowCount} users HUMAN ativos${targetOrg ? ` (org=${targetOrg})` : ""}.`);

let created = 0;
let skipped = 0;
let missingPreset = 0;

for (const u of users.rows) {
  if (!VALID_ROLES.has(u.role)) {
    console.warn(`! ${u.email}: role legacy '${u.role}' invalida — skip`);
    skipped++;
    continue;
  }

  const preset = await c.query(
    `SELECT id FROM roles
      WHERE "organizationId" = $1 AND "systemPreset" = $2
      LIMIT 1`,
    [u.organizationId, u.role],
  );
  if (preset.rowCount === 0) {
    console.warn(`! ${u.email}: org ${u.organizationId} sem preset Role '${u.role}' — skip`);
    missingPreset++;
    continue;
  }
  const roleId = preset.rows[0].id;

  const exists = await c.query(
    `SELECT id FROM user_role_assignments
      WHERE "userId" = $1 AND "roleId" = $2 LIMIT 1`,
    [u.id, roleId],
  );
  if (exists.rowCount > 0) {
    skipped++;
    continue;
  }

  const id = `ura_${u.id}_${roleId}`.slice(0, 30);
  await c.query(
    `INSERT INTO user_role_assignments (id, "userId", "roleId", "organizationId", "assignedById", "createdAt")
     VALUES ($1, $2, $3, $4, NULL, NOW())
     ON CONFLICT ("userId", "roleId") DO NOTHING`,
    [id, u.id, roleId, u.organizationId],
  );
  console.log(`+ ${u.email} -> ${u.role} (role=${roleId})`);
  created++;
}

console.log(`\nResumo: ${created} criados, ${skipped} ja existentes, ${missingPreset} sem preset.`);

await c.end();
