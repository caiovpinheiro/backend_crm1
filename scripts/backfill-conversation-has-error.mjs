/**
 * Backfill de `conversation.hasError` para tickets OPEN presos em Entrada
 * com última bolha real de chat = outbound `failed` (ex.: Meta code 2).
 *
 * Contexto: até `6680ca8`, `markConversationHasError` lia o denormalizado
 * `lastMessageDirection`. Com `countAgentReplyAsAnswered` OFF, outbound de
 * bot/automação/IA não atualiza essa coluna — ela ficava `"in"` e a flag
 * NÃO era ligada. O ticket mostrava ! vermelho no preview mas continuava
 * em Entrada (`hasError: false`).
 *
 * Critério (alinhado a `src/services/conversation-error-flag.ts`):
 *   - status = OPEN
 *   - hasError = false
 *   - última mensagem pública in/out (excl. note/ai_draft/call*) é
 *     direction=out AND lower(sendStatus)='failed'
 *
 * Idempotente. Uso:
 *   DATABASE_URL=... node scripts/backfill-conversation-has-error.mjs
 *   DATABASE_URL=... node scripts/backfill-conversation-has-error.mjs --apply
 *   TARGET_ORG_ID=<org> DATABASE_URL=... node scripts/backfill-conversation-has-error.mjs [--apply]
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
      m."sendStatus",
      m."sendError",
      m."createdAt"
    FROM messages m
    WHERE m."isPrivate" = false
      AND m."messageType" <> ALL($1::text[])
      AND m.direction IN ('in', 'out')
    ORDER BY m."conversationId", m."createdAt" DESC
  )
  SELECT
    c.id,
    c."organizationId",
    c.status,
    c."hasError",
    c."lastMessageDirection",
    lm.direction AS last_dir,
    lm."sendStatus" AS last_send_status,
    LEFT(COALESCE(lm."sendError", ''), 120) AS last_send_error
  FROM conversations c
  INNER JOIN last_msg lm ON lm."conversationId" = c.id
  WHERE c.status = 'OPEN'
    AND c."hasError" = false
    AND lm.direction = 'out'
    AND LOWER(COALESCE(lm."sendStatus", '')) = 'failed'
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
  `Candidatos OPEN + hasError=false + última bolha outbound failed: ${rows.length}`,
);

for (const r of rows.slice(0, 30)) {
  console.log(
    `- ${r.id} org=${r.organizationId} lastDirCol=${r.lastMessageDirection} ` +
      `msg=${r.last_dir}/${r.last_send_status} err="${r.last_send_error}"`,
  );
}
if (rows.length > 30) {
  console.log(`… +${rows.length - 30} omitidos no preview`);
}

if (!APPLY) {
  console.log(
    "\nNada gravado. Rode com --apply para setar hasError=true nestes tickets.",
  );
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
  `UPDATE conversations
      SET "hasError" = true,
          "updatedAt" = NOW()
    WHERE id = ANY($1::text[])
      AND status = 'OPEN'
      AND "hasError" = false`,
  [ids],
);
console.log(`\nAtualizados: ${upd.rowCount}`);

await c.end();
