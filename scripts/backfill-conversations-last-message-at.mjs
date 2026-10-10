/**
 * Backfill de `conversations."lastMessageAt"` (D1 = N-BE-1 da auditoria).
 *
 * A coluna nasce NULL na migration `20261003150000_conversations_last_message_at`
 * e o código passa a gravá-la em toda mensagem de chat nova. Este script
 * preenche o histórico: MAX("createdAt") das mensagens de chat da conversa,
 * com o MESMO recorte da prévia do card (`src/lib/conversation-last-message.ts`):
 *   - "isPrivate" = false
 *   - "messageType" fora de note / ai_draft / whatsapp_call / whatsapp_call_recording
 *   - "messageType" NOT LIKE 'event%'
 *   - direction IN ('in', 'out')
 *
 * Enquanto a coluna está NULL a lista usa `COALESCE("lastMessageAt", "updatedAt")`
 * — nada quebra durante o backfill; cada lote só deixa a ordem mais exata.
 *
 * Seguro de rodar com o sistema no ar e quantas vezes quiser:
 *   - só AUMENTA o valor (`IS NULL OR < MAX`) — rodar de novo não muda nada e
 *     nunca briga com o valor que o código acabou de gravar;
 *   - não toca em "updatedAt" (SQL cru);
 *   - um lote = uma transação curta (UPDATE de até --batch linhas pela PK),
 *     com pausa entre lotes e statement_timeout por instrução.
 *
 * Uso (rodar DEPOIS do deploy). No container da API o DATABASE_URL já está
 * no ambiente; o `sslmode=require` do Postgres da DigitalOcean é tratado
 * por `scripts/lib/pg-ssl.mjs` (TLS sem verificar o CA, como o `require` da
 * libpq) — não precisa acrescentar `uselibpqcompat` à URL:
 *   node scripts/backfill-conversations-last-message-at.mjs            # dry-run
 *   node scripts/backfill-conversations-last-message-at.mjs --apply
 * Fora do container: `DATABASE_URL=... node scripts/backfill-conversations-last-message-at.mjs [--apply]`.
 * Para verificar o certificado: PG_SSL_VERIFY=1 PGSSLROOTCERT=/caminho/ca.crt.
 *
 * Opções:
 *   --apply            grava (sem isso só conta o que mudaria)
 *   --batch=500        conversas por lote
 *   --sleep-ms=200     pausa entre lotes
 *   --after=<id>       retoma depois deste id (o script imprime o ponto a cada lote)
 *   --all              revisita também as conversas que já têm valor (padrão: só NULL)
 *   --max-batches=N    para depois de N lotes (teste controlado)
 *   TARGET_ORG_ID=<org> limita a uma organização
 *
 * Ctrl+C termina o lote em andamento e imprime o comando para retomar.
 */
import { Client } from "pg";

import { pgConnectionConfig } from "./lib/pg-ssl.mjs";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
}

const APPLY = arg("apply", false) === true;
const ALL = arg("all", false) === true;
const BATCH = Math.max(1, Math.min(5_000, Number(arg("batch", "500")) || 500));
const SLEEP_MS = Math.max(0, Number(arg("sleep-ms", "200")) || 0);
const MAX_BATCHES = Number(arg("max-batches", "0")) || 0;
const TARGET_ORG = process.env.TARGET_ORG_ID?.trim() || null;
let after = typeof arg("after", "") === "string" ? String(arg("after", "")) : "";

const NON_CHAT_TYPES = ["note", "ai_draft", "whatsapp_call", "whatsapp_call_recording"];

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não definido.");
  process.exit(1);
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nInterrompendo depois do lote atual… (Ctrl+C de novo aborta já)");
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = new Client({
  ...pgConnectionConfig(),
  application_name: "backfill-last-message-at",
});
await c.connect();
await c.query("SET statement_timeout = '60s'");
await c.query("SET lock_timeout = '5s'");

console.log(
  `Modo: ${APPLY ? "APPLY (grava)" : "DRY-RUN (não grava)"} | lote=${BATCH} | pausa=${SLEEP_MS}ms` +
    `${ALL ? " | revisitando todas" : " | só NULL"}` +
    `${TARGET_ORG ? ` | org=${TARGET_ORG}` : ""}${after ? ` | retomando após ${after}` : ""}`,
);

// Ids do lote: keyset pela PK. `$1` = último id visto.
const pickSql = `
  SELECT id FROM conversations
  WHERE id > $1
    ${ALL ? "" : `AND "lastMessageAt" IS NULL`}
    ${TARGET_ORG ? `AND "organizationId" = $3` : ""}
  ORDER BY id
  LIMIT $2
`;

// MAX das mensagens de chat por conversa do lote (índice (conversationId, createdAt)).
const maxCte = `
  WITH m AS (
    SELECT msg."conversationId" AS id, MAX(msg."createdAt") AS last_at
    FROM messages msg
    WHERE msg."conversationId" = ANY($1::text[])
      AND msg."isPrivate" = false
      AND msg."messageType" <> ALL($2::text[])
      AND msg."messageType" NOT LIKE 'event%'
      AND msg.direction IN ('in', 'out')
    GROUP BY msg."conversationId"
  )
`;

const updateSql = `${maxCte}
  UPDATE conversations c
  SET "lastMessageAt" = m.last_at
  FROM m
  WHERE c.id = m.id
    AND (c."lastMessageAt" IS NULL OR c."lastMessageAt" < m.last_at)
`;

const dryRunSql = `${maxCte}
  SELECT COUNT(*)::int AS n
  FROM conversations c JOIN m ON m.id = c.id
  WHERE c."lastMessageAt" IS NULL OR c."lastMessageAt" < m.last_at
`;

let batches = 0;
let scanned = 0;
let changed = 0;
const started = Date.now();

while (!stopping) {
  const params = TARGET_ORG ? [after, BATCH, TARGET_ORG] : [after, BATCH];
  const { rows } = await c.query(pickSql, params);
  if (rows.length === 0) break;
  const ids = rows.map((r) => r.id);

  let n;
  if (APPLY) {
    const res = await c.query(updateSql, [ids, NON_CHAT_TYPES]);
    n = res.rowCount ?? 0;
  } else {
    const res = await c.query(dryRunSql, [ids, NON_CHAT_TYPES]);
    n = res.rows[0]?.n ?? 0;
  }

  batches += 1;
  scanned += ids.length;
  changed += n;
  after = ids[ids.length - 1];
  console.log(
    `lote ${batches}: ${ids.length} conversas, ${n} ${APPLY ? "atualizadas" : "mudariam"}` +
      ` | total ${scanned}/${changed} | retomar: --after=${after}`,
  );

  if (rows.length < BATCH) break;
  if (MAX_BATCHES && batches >= MAX_BATCHES) break;
  if (SLEEP_MS) await sleep(SLEEP_MS);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\nFim${stopping ? " (interrompido)" : ""}: ${batches} lotes, ${scanned} conversas lidas, ` +
    `${changed} ${APPLY ? "atualizadas" : "mudariam"} em ${secs}s.`,
);
if (stopping || (MAX_BATCHES && batches >= MAX_BATCHES)) {
  console.log(
    `Para continuar: node scripts/backfill-conversations-last-message-at.mjs` +
      `${APPLY ? " --apply" : ""}${ALL ? " --all" : ""} --after=${after}`,
  );
}
if (!APPLY) console.log("Nada gravado. Rode com --apply para gravar.");
await c.end();
