-- Índice da busca de idempotência da projeção da outbox (item 0.1 do plano
-- de performance de produção).
--
-- Quem usa: `projectTabulationOutboxBatch` e `pollAndProjectActivityOutbox`
-- (src/services/activity-outbox.ts) fazem, antes de cada INSERT em
-- activity_events:
--
--   SELECT id FROM activity_events
--    WHERE "organizationId" = $1 AND "idempotencyKey" = $2 LIMIT 1
--
-- Sem índice isso é seq scan nas partições mensais a cada evento projetado.
-- A igualdade em "idempotencyKey" implica IS NOT NULL (operador estrito),
-- então o planner aceita o índice parcial; como a consulta não filtra
-- "occurredAt", não há poda de partição — é uma sonda de índice por partição.
--
-- Parcial porque só eventos vindos da outbox têm chave: os fire-and-forget
-- (a grande maioria das linhas) ficam fora e o índice fica pequeno.
-- Não é UNIQUE: a tabela é particionada por RANGE("occurredAt") e o Postgres
-- exige a coluna de partição em índice único (ver 20260917190000_activity_outbox).
--
-- PRODUÇÃO: o índice JÁ EXISTE, criado à mão sem bloqueio —
--   CREATE INDEX "activity_events_org_idem_idx" ON ONLY "activity_events" (...) WHERE ...;
--   CREATE INDEX CONCURRENTLY ... em cada partição + ALTER INDEX ... ATTACH PARTITION.
-- Lá esta migration não faz NADA: o bloco abaixo só consulta o catálogo e
-- sai, sem tocar na tabela (um `CREATE INDEX IF NOT EXISTS` direto também
-- seria no-op, mas antes de checar o nome ele pega ShareLock no pai e em
-- todas as partições — escrita em activity_events esperaria a migration).
--
-- BANCO SEM O ÍNDICE (DEV, bancos novos): `CREATE INDEX` no pai, que cria
-- em cascata nas partições existentes e passa a valer para as futuras.
-- Trava escrita em activity_events enquanto constrói — aceitável em banco
-- pequeno. Em banco grande, criar antes à mão como em produção (o nome tem
-- de ser exatamente "activity_events_org_idem_idx").
-- (CONCURRENTLY não roda dentro da transação do `migrate deploy` e não é
-- aceito em tabela particionada; por isso não está no arquivo.)
--
-- Índice com o nome certo mas INVÁLIDO (pai ON ONLY com partição sem índice
-- anexado): só avisa (WARNING) e segue — completar exige CONCURRENTLY por
-- partição, fora de migration. As partições já anexadas continuam usando o
-- índice delas.
--
-- Rollback: DROP INDEX IF EXISTS "activity_events_org_idem_idx";
-- (a projeção continua correta sem ele, só volta ao seq scan.)

DO $$
DECLARE
  idx       regclass := to_regclass('"activity_events_org_idem_idx"');
  tbl       regclass := to_regclass('"activity_events"');
  idx_table regclass;
  idx_valid boolean;
BEGIN
  IF idx IS NOT NULL THEN
    SELECT i.indrelid::regclass, i.indisvalid
      INTO idx_table, idx_valid
      FROM pg_index i
     WHERE i.indexrelid = idx;

    IF idx_table IS DISTINCT FROM tbl THEN
      RAISE WARNING 'activity_events_org_idem_idx existe mas não é um índice de activity_events — nada foi criado; verifique à mão.';
    ELSIF NOT idx_valid THEN
      RAISE WARNING 'activity_events_org_idem_idx existe mas está INVÁLIDO (alguma partição sem índice anexado) — complete com CREATE INDEX CONCURRENTLY na partição + ALTER INDEX ... ATTACH PARTITION.';
    ELSE
      RAISE NOTICE 'activity_events_org_idem_idx já existe e está válido — nada a fazer.';
    END IF;
    RETURN;
  END IF;

  CREATE INDEX "activity_events_org_idem_idx"
    ON "activity_events" ("organizationId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;
END$$;
