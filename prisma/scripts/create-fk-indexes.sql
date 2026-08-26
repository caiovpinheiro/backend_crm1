-- Índices nas colunas que originam FOREIGN KEYs.
--
-- Rodar manualmente em produção (fora do prisma migrate):
--   psql "$DATABASE_URL" -f prisma/scripts/create-fk-indexes.sql
--
-- Motivo: o Postgres não cria índice automático no lado *referenciador* de
-- uma FK. Sem ele, todo DELETE/UPDATE da chave na tabela referenciada faz
-- seq scan na tabela filha para validar a constraint. Os índices compostos
-- que já existem (ex.: activity_events (organizationId, contactId, occurredAt))
-- não servem: a checagem de FK só usa índice cuja PRIMEIRA coluna é a da FK.
--
-- Medido no staging da DigitalOcean com activity_events em 1.456 MB / 50
-- partições: DELETE de 1.000 contatos caiu de >3min45s para 5,1s, e DELETE
-- de 1.000 conversas de >3min46s (abortado) para 0,55s. Custo total dos
-- índices: 15 MB e ~13s de build.
--
-- CREATE INDEX CONCURRENTLY não roda dentro de transaction. Cada índice é
-- independente; falha parcial é ok (IF NOT EXISTS).

-- ── Tabelas normais: CONCURRENTLY, sem lock de escrita ────────────────

CREATE INDEX CONCURRENTLY IF NOT EXISTS "meta_webhook_events_channelId_idx"
  ON "meta_webhook_events" ("channelId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "distribution_logs_departmentId_idx"
  ON "distribution_logs" ("departmentId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_departmentId_idx"
  ON "conversations" ("departmentId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_tabulationId_idx"
  ON "conversations" ("tabulationId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "deals_orgUnitId_idx"
  ON "deals" ("orgUnitId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "calls_contact_id_idx"
  ON "calls" ("contact_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "automation_session_expiry_claims_conversationId_idx"
  ON "automation_session_expiry_claims" ("conversationId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_whatsapp_calls_contactId_idx"
  ON "scheduled_whatsapp_calls" ("contactId");

-- ── activity_events (particionada) ────────────────────────────────────
--
-- CONCURRENTLY não é suportado no pai particionado. As três linhas abaixo
-- pegam ACCESS EXCLUSIVE no pai e em todas as partições durante o build —
-- ~5s cada no volume atual, o que é aceitável fora do horário de pico.
--
-- Se precisar de zero bloqueio, use o caminho por partição: rode a query
-- geradora no fim deste arquivo e execute o SQL que ela devolve.

CREATE INDEX IF NOT EXISTS "activity_events_contactId_idx"
  ON "activity_events" ("contactId");

CREATE INDEX IF NOT EXISTS "activity_events_conversationId_idx"
  ON "activity_events" ("conversationId");

CREATE INDEX IF NOT EXISTS "activity_events_actorUserId_idx"
  ON "activity_events" ("actorUserId");

-- ── Verificação: deve voltar vazio ────────────────────────────────────

SELECT c.conrelid::regclass AS tabela,
       a.attname            AS coluna,
       c.confrelid::regclass AS aponta_para,
       pg_size_pretty(pg_relation_size(c.conrelid)) AS tamanho
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) k(attnum) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
 WHERE c.contype = 'f'
   AND pg_relation_size(c.conrelid) > 1048576
   AND NOT EXISTS (
     SELECT 1 FROM pg_index i
      WHERE i.indrelid = c.conrelid AND i.indkey[0] = k.attnum)
 ORDER BY pg_relation_size(c.conrelid) DESC;

-- ── Geradora do caminho sem bloqueio (opcional) ───────────────────────
--
-- SELECT format(
--   'CREATE INDEX CONCURRENTLY IF NOT EXISTS %I ON %I (%I);',
--   c.relname || '_contactid_idx', c.relname, 'contactId')
--   FROM pg_class c
--   JOIN pg_inherits h ON h.inhrelid = c.oid
--  WHERE h.inhparent = 'activity_events'::regclass;
--
-- Depois:
--   CREATE INDEX "activity_events_contactId_idx"
--     ON ONLY "activity_events" ("contactId");
--   ALTER INDEX "activity_events_contactId_idx"
--     ATTACH PARTITION "<partição>_contactid_idx";  -- uma por partição
-- O índice do pai vira válido quando a última partição é anexada.
