-- activity_events: DROP de 5 índices compostos quase inúteis.
--
-- Base: pg_stat_user_indexes de produção (12d, ~1 M eventos/mês). Somados
-- nas 12 partições de 2026:
--
--   (organizationId, entityType, entityId, occurredAt)  47 scans   453 MB
--   (organizationId, contactId, occurredAt)            795 scans   384 MB
--   (organizationId, dealId, occurredAt)               405 scans   352 MB
--   (organizationId, actorUserId, occurredAt)           53 scans   335 MB
--   (organizationId, actorType, occurredAt)            164 scans   275 MB
--                                                              ── ~1,8 GB
--
-- Os lookups de timeline por entidade usam os índices SIMPLES de FK
-- (activity_events_contactId_idx / _dealId_idx / _conversationId_idx /
-- _actorUserId_idx — milhões de scans, ~140 MB no total); a ordenação por
-- occurredAt cai no sort. Mantidos: (org, occurredAt) 430k scans,
-- (org, type, occurredAt) 362k, (org, conversationId, occurredAt) 177k.
--
-- `activity_events` é PARTITION BY RANGE. DROP do índice no PAI cascateia
-- para as 62 partições (metadata-only) e impede que voltem em partições
-- novas (a função logs_ensure_activity_events_partition só faz
-- `CREATE TABLE ... PARTITION OF`, o Postgres propaga os índices do pai).
--
-- Casa pelo conjunto de colunas (não pelo nome) porque o nome truncado do
-- Prisma varia entre ambientes.

DO $$
DECLARE
  r record;
  want text[] := ARRAY[
    'organizationId,entityType,entityId,occurredAt',
    'organizationId,contactId,occurredAt',
    'organizationId,dealId,occurredAt',
    'organizationId,actorUserId,occurredAt',
    'organizationId,actorType,occurredAt'
  ];
BEGIN
  FOR r IN
    SELECT i.indexrelid::regclass::text AS idx_name,
           string_agg(a.attname, ',' ORDER BY k.ord) AS cols
    FROM pg_index i
    JOIN pg_class c   ON c.oid = i.indrelid
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE c.relname = 'activity_events'   -- só o pai da partição
      AND NOT i.indisprimary
    GROUP BY i.indexrelid
  LOOP
    IF r.cols = ANY(want) THEN
      EXECUTE format('DROP INDEX IF EXISTS %s', r.idx_name);
      RAISE NOTICE 'dropped %', r.idx_name;
    END IF;
  END LOOP;
END $$;
