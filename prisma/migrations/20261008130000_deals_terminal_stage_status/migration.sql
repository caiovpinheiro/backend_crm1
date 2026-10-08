-- Negócios parados numa etapa terminal (Ganho/Perdido) com status incoerente.
--
-- O QUE FAZ (só UPDATE em "deals"; idempotente — rodar duas vezes não muda nada):
--   1. Etapa `isLost` e status <> 'LOST'  → status = 'LOST', closedAt = data de
--      entrada na etapa, lostReason mantido.
--   2. Etapa `isWon`  e status <> 'WON'   → status = 'WON',  closedAt = data de
--      entrada na etapa, lostReason = NULL.
--   Negócio com status já coerente com a etapa não é tocado.
--
-- POR QUÊ: importação/migração, POST /api/deals, /api/leads, automação
-- `create_deal`/`update_field` e ferramentas de IA gravavam `stageId` direto,
-- sem o patch de status que o move do Kanban aplica. Na DEV, 1.805 negócios
-- ficaram na coluna Perdido com status OPEN e closedAt nulo: o Kanban (conta
-- por etapa) mostrava 1.805 perdidos, o painel (status + closedAt) mostrava 0.
-- O código passou a sincronizar em todos os caminhos; esta migration acerta o
-- legado.
--
-- DATA DE ENTRADA NA ETAPA (closedAt), por ordem de preferência:
--   a) último `deal_events.type = 'STAGE_CHANGED'` cujo `meta->'to'->>'id'` é a
--      etapa atual (é assim que move manual, PUT, bulk, job e automação gravam);
--   b) se o negócio NUNCA mudou de etapa (nenhum STAGE_CHANGED), nasceu nela:
--      "createdAt" — caso da importação de 21/07;
--   c) senão, "updatedAt" (mudou de etapa por um caminho sem evento).
--
-- NÃO TOCA em negócio reaberto de propósito: `STATUS_CHANGED` com `to = OPEN`
-- (PUT /api/deals/:id/status "Reabrir", formulário do WhatsApp) mais recente que
-- o último STAGE_CHANGED. `reopenDeal` deixa o card na coluna onde estava por
-- decisão de produto (incidente 2026-08-05); marcá-lo LOST desfaria a ação do
-- operador. Quantos são (rodar antes):
--
--   SELECT count(*) FROM deals d JOIN stages s ON s.id = d."stageId"
--   WHERE (s."isLost" AND d.status <> 'LOST' OR s."isWon" AND d.status <> 'WON')
--     AND EXISTS (SELECT 1 FROM deal_events e WHERE e."dealId" = d.id
--                   AND e.type = 'STATUS_CHANGED' AND e.meta->>'to' = 'OPEN'
--                   AND e."createdAt" > COALESCE((SELECT max(x."createdAt") FROM deal_events x
--                                                 WHERE x."dealId" = d.id AND x.type = 'STAGE_CHANGED'),
--                                                '-infinity'::timestamp));
--
-- CONFERÊNCIA — a mesma consulta antes e depois (DEV antes: LOST/false = 23,
-- OPEN/true = 1.805; depois: só LOST/false = 1.828, salvo reabertos):
--
--   SELECT d.status, (d."closedAt" IS NULL) AS sem_closed_at, count(*)
--   FROM deals d JOIN stages s ON s.id = d."stageId"
--   WHERE s."isLost" = true GROUP BY 1,2;
--
--   -- idem para Ganho:
--   SELECT d.status, (d."closedAt" IS NULL) AS sem_closed_at, count(*)
--   FROM deals d JOIN stages s ON s.id = d."stageId"
--   WHERE s."isWon" = true GROUP BY 1,2;
--
-- LOTES: um UPDATE por tipo de etapa (Perdido, Ganho). Cada linha custa um
-- index scan em deal_events ("dealId","createdAt"); 1.805 linhas na DEV levam
-- bem menos de 1 s. Em produção, com dezenas de milhares de linhas, espere
-- alguns segundos; o `migrate deploy` do boot roda tudo numa transação. Se a
-- tabela for muito maior, rode antes, fora do boot, o mesmo UPDATE com
-- `AND d.id IN (SELECT ... LIMIT 5000)` em loop até afetar 0 linhas — a
-- migration então não encontra nada e passa na hora.
--
-- ROLLBACK: não há. O status/closedAt anteriores (OPEN/NULL) não ficam
-- guardados em lugar nenhum; só um backup de "deals" anterior à migration
-- permite voltar. Tire o snapshot antes de subir em produção.

-- 1. Etapa Perdido → LOST (lostReason mantido).
WITH alvo AS (
  SELECT
    d."id",
    COALESCE(
      (SELECT max(e."createdAt") FROM "deal_events" e
        WHERE e."dealId" = d."id"
          AND e."type" = 'STAGE_CHANGED'
          AND e."meta"->'to'->>'id' = d."stageId"),
      CASE WHEN NOT EXISTS (SELECT 1 FROM "deal_events" e
                              WHERE e."dealId" = d."id" AND e."type" = 'STAGE_CHANGED')
           THEN d."createdAt" END,
      d."updatedAt"
    ) AS "entrouEm"
  FROM "deals" d
  JOIN "stages" s ON s."id" = d."stageId"
  WHERE s."isLost" = true
    AND d."status" <> 'LOST'
    AND NOT EXISTS (
      SELECT 1 FROM "deal_events" e
      WHERE e."dealId" = d."id"
        AND e."type" = 'STATUS_CHANGED'
        AND e."meta"->>'to' = 'OPEN'
        AND e."createdAt" > COALESCE(
          (SELECT max(x."createdAt") FROM "deal_events" x
            WHERE x."dealId" = d."id" AND x."type" = 'STAGE_CHANGED'),
          '-infinity'::timestamp)
    )
)
UPDATE "deals" d
SET "status" = 'LOST',
    "closedAt" = a."entrouEm"
FROM alvo a
WHERE d."id" = a."id";

-- 2. Etapa Ganho → WON (lostReason limpo).
WITH alvo AS (
  SELECT
    d."id",
    COALESCE(
      (SELECT max(e."createdAt") FROM "deal_events" e
        WHERE e."dealId" = d."id"
          AND e."type" = 'STAGE_CHANGED'
          AND e."meta"->'to'->>'id' = d."stageId"),
      CASE WHEN NOT EXISTS (SELECT 1 FROM "deal_events" e
                              WHERE e."dealId" = d."id" AND e."type" = 'STAGE_CHANGED')
           THEN d."createdAt" END,
      d."updatedAt"
    ) AS "entrouEm"
  FROM "deals" d
  JOIN "stages" s ON s."id" = d."stageId"
  WHERE s."isWon" = true
    AND d."status" <> 'WON'
    AND NOT EXISTS (
      SELECT 1 FROM "deal_events" e
      WHERE e."dealId" = d."id"
        AND e."type" = 'STATUS_CHANGED'
        AND e."meta"->>'to' = 'OPEN'
        AND e."createdAt" > COALESCE(
          (SELECT max(x."createdAt") FROM "deal_events" x
            WHERE x."dealId" = d."id" AND x."type" = 'STAGE_CHANGED'),
          '-infinity'::timestamp)
    )
)
UPDATE "deals" d
SET "status" = 'WON',
    "closedAt" = a."entrouEm",
    "lostReason" = NULL
FROM alvo a
WHERE d."id" = a."id";
