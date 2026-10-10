/**
 * Corrige conversas OPEN em "Respondidas" cujo denormalizado
 * `lastMessageDirection = 'out'` está desatualizado: a última bolha
 * pública real de chat é `direction = 'in'` (cliente falou por último).
 *
 * Efeito na inbox (com assignee + hasHumanReply):
 *   Respondidas → Aguardando (`esperando`)
 *
 * (A aba "Entrada" é outro critério — sem 1ª reply contável / sem dono.
 *  Operacionalmente "fila esperando resposta do consultor" = Aguardando.)
 *
 * Idempotente. Uso:
 *   node --env-file=.env scripts/backfill-respondidas-stale-direction.mjs
 *   node --env-file=.env scripts/backfill-respondidas-stale-direction.mjs --apply
 *   TARGET_ORG_ID=<org> node --env-file=.env scripts/backfill-respondidas-stale-direction.mjs [--apply]
 */
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

const APPLY = process.argv.includes("--apply");
const TARGET_ORG = process.env.TARGET_ORG_ID ?? null;

const EXCLUDED_TYPES = [
  "note",
  "ai_draft",
  "whatsapp_call",
  "whatsapp_call_recording",
];

const c = new Client(pgConnectionConfig());
await c.connect();

const selectSql = `
  WITH last_msg AS (
    SELECT DISTINCT ON (m."conversationId")
      m."conversationId",
      m.direction,
      m."createdAt",
      m."authorType",
      m."messageType"
    FROM messages m
    WHERE m."isPrivate" = false
      AND m."messageType" <> ALL($1::text[])
      AND m.direction IN ('in', 'out')
    ORDER BY m."conversationId", m."createdAt" DESC
  )
  SELECT
    c.id,
    c."organizationId",
    c."assignedToId",
    c."hasHumanReply",
    c."hasAgentReply",
    c."lastMessageDirection",
    lm.direction AS last_dir,
    lm."authorType" AS last_author,
    lm."messageType" AS last_type,
    lm."createdAt" AS last_at
  FROM conversations c
  INNER JOIN last_msg lm ON lm."conversationId" = c.id
  WHERE c.status = 'OPEN'
    AND c."lastMessageDirection" = 'out'
    AND lm.direction = 'in'
    ${TARGET_ORG ? `AND c."organizationId" = $2` : ""}
  ORDER BY c."updatedAt" DESC
`;

const selectParams = TARGET_ORG
  ? [EXCLUDED_TYPES, TARGET_ORG]
  : [EXCLUDED_TYPES];

const { rows } = await c.query(selectSql, selectParams);

console.log(
  `Modo: ${APPLY ? "APPLY (grava)" : "DRY-RUN (não grava)"}${TARGET_ORG ? ` | org=${TARGET_ORG}` : ""}`,
);
console.log(
  `Candidatos OPEN + lastMessageDirection=out + última bolha real = in: ${rows.length}`,
);
console.log(
  "(Esses saem de Respondidas → Aguardando após lastMessageDirection='in'.)",
);

for (const r of rows.slice(0, 30)) {
  console.log(
    `  ${r.id} org=${r.organizationId} assigned=${r.assignedToId ? "yes" : "no"} humanReply=${r.hasHumanReply} last_author=${r.last_author} last_type=${r.last_type} last_at=${r.last_at?.toISOString?.() ?? r.last_at}`,
  );
}
if (rows.length > 30) console.log(`  … +${rows.length - 30} mais`);

// Diagnóstico extra: Respondidas com última bolha outbound de bot/system
// (não é "user"/human). Não auto-corrige — só reporta.
const botLastSql = `
  WITH last_msg AS (
    SELECT DISTINCT ON (m."conversationId")
      m."conversationId",
      m.direction,
      m."authorType",
      m."createdAt"
    FROM messages m
    WHERE m."isPrivate" = false
      AND m."messageType" <> ALL($1::text[])
      AND m.direction IN ('in', 'out')
    ORDER BY m."conversationId", m."createdAt" DESC
  )
  SELECT count(*)::int AS n
  FROM conversations c
  INNER JOIN last_msg lm ON lm."conversationId" = c.id
  WHERE c.status = 'OPEN'
    AND c."lastMessageDirection" = 'out'
    AND c."assignedToId" IS NOT NULL
    AND c."hasHumanReply" = true
    AND lm.direction = 'out'
    AND lm."authorType" <> 'human'
    ${TARGET_ORG ? `AND c."organizationId" = $2` : ""}
`;
const botLast = await c.query(botLastSql, selectParams);
console.log(
  `Diagnóstico: Respondidas-like com última out de bot/system (não human): ${botLast.rows[0]?.n ?? 0}`,
);

if (!APPLY) {
  console.log("Dry-run ok. Rode com --apply para gravar lastMessageDirection='in'.");
  await c.end();
  process.exit(0);
}

if (rows.length === 0) {
  console.log("Nada a atualizar.");
  await c.end();
  process.exit(0);
}

const ids = rows.map((r) => r.id);
const upd = await c.query(
  `
  UPDATE conversations
  SET "lastMessageDirection" = 'in',
      "updatedAt" = NOW()
  WHERE id = ANY($1::text[])
    AND status = 'OPEN'
    AND "lastMessageDirection" = 'out'
  RETURNING id
  `,
  [ids],
);

console.log(`Atualizados: ${upd.rowCount}`);
await c.end();
