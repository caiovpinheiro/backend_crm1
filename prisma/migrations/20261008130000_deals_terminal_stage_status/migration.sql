-- Negócios com status/closedAt incoerentes com a etapa terminal (Ganho/Perdido)
-- e negócios fechados (WON/LOST) sem data de fechamento.
--
-- POR QUÊ: importação/migração, POST /api/deals, /api/leads, automação
-- `create_deal`/`update_field` e ferramentas de IA gravavam `stageId` direto,
-- sem o patch de status que o move do Kanban aplica. O código passou a
-- sincronizar em todos os caminhos; esta migration acerta o legado. Os KPIs do
-- painel (ganhos, receita, conversão, perdidos, ganhos por agente) contam
-- `status` + `closedAt` no período, então hoje subcontam muito.
--   Produção, etapa Ganho (isWon): OPEN sem closedAt 4.071 | WON sem closedAt
--   1.365 | WON com closedAt 923 | LOST com closedAt 9.
--   DEV, etapa Perdido (isLost): OPEN sem closedAt 1.805 | LOST ok 23.
--
-- REGRAS (só UPDATE em "deals"; um UPDATE por regra):
--
--   A) status = 'OPEN' numa etapa terminal:
--        etapa isWon  → status 'WON',  closedAt = entrada na etapa, lostReason = NULL
--        etapa isLost → status 'LOST', closedAt = entrada na etapa, lostReason mantido
--      (etapa marcada isWon e isLost ao mesmo tempo vale como Ganho, igual ao
--      `buildStatusSyncPatch`.)
--      Data de entrada na etapa, nesta ordem:
--        1) último `deal_events` STAGE_CHANGED cujo destino é a etapa atual
--           (`meta->'to'->>'id'`; o formato antigo com `meta->>'to'` = id da
--           etapa também conta — a timeline normaliza os dois);
--        2) se o negócio NUNCA mudou de etapa (nenhum STAGE_CHANGED), nasceu
--           nela: "createdAt" (caso da importação);
--        3) senão "updatedAt".
--      NÃO converte LOST em etapa Ganho nem WON em etapa Perdido: alguém marcou
--      de propósito (ex.: os 9 LOST na coluna Ganho em produção).
--      NÃO toca negócio reaberto de propósito: STATUS_CHANGED com
--      `meta->>'to' = 'OPEN'` (PUT /api/deals/:id/status "Reabrir", formulário
--      do WhatsApp) mais recente que o último STAGE_CHANGED. `reopenDeal` deixa
--      o card na coluna onde estava por decisão de produto (incidente
--      2026-08-05); fechá-lo desfaria a ação do operador.
--
--   B) status IN ('WON','LOST') e closedAt IS NULL, em QUALQUER etapa:
--        só closedAt muda (status e lostReason ficam como estão). Data, nesta ordem:
--        1) último `deal_events` STATUS_CHANGED com `meta->>'to'` igual ao status
--           atual (é assim que move, PUT status, bulk, jobs e automação gravam:
--           `type = 'STATUS_CHANGED'`, `meta = {from, to: 'WON'|'LOST'|'OPEN'}`);
--        2) se a etapa atual é terminal (isWon/isLost): último STAGE_CHANGED para
--           ela;
--        3) senão "updatedAt".
--
--   As duas regras não se sobrepõem (A só pega OPEN; B só WON/LOST) e são
--   calculadas sobre o estado ANTERIOR, na tabela temporária
--   "_alvo_deals_terminal" (fonte única para o backup e para os UPDATEs).
--
-- "updatedAt" NÃO muda: é preenchido pelo Prisma (@updatedAt) no cliente, não
-- por trigger, e nenhum SET abaixo o menciona.
--
-- IDEMPOTENTE: depois de rodar, todo negócio tocado por A está WON/LOST com
-- closedAt preenchido (createdAt/updatedAt nunca são nulos) e todo negócio de B
-- tem closedAt. Rodar de novo encontra alvo vazio; os reabertos de propósito
-- continuam excluídos pelo mesmo critério.
--
-- BACKUP E ROLLBACK: antes de qualquer UPDATE, os negócios do alvo são copiados
-- (id, status, closedAt, lostReason, updatedAt) em "_bkp_deals_terminal_20261010".
-- Se a tabela já existir, não é recriada; só entram as linhas do alvo que ainda
-- não estão lá (preserva o valor ORIGINAL quando a variante em lotes roda
-- antes). Para desfazer:
--
--   UPDATE deals d SET status = b.status, "closedAt" = b."closedAt",
--          "lostReason" = b."lostReason"
--   FROM "_bkp_deals_terminal_20261010" b WHERE d.id = b.id;
--
-- Depois de conferir o painel, a tabela de backup pode ser apagada à mão
-- (`DROP TABLE "_bkp_deals_terminal_20261010";`).
--
-- SIMULAÇÃO (só leitura; rodar ANTES do deploy). Cole o SELECT entre as marcas
-- `@alvo:inicio` e `@alvo:fim` abaixo no lugar de <ALVO>:
--
--   -- linhas por regra / status novo / origem da data (ficam_sem_data deve ser 0)
--   SELECT "regra", "novoStatus", "fonte", count(*) AS linhas,
--          count(*) FILTER (WHERE "novoClosedAt" IS NULL) AS ficam_sem_data
--   FROM (<ALVO>) x GROUP BY 1,2,3 ORDER BY 1,2,3;
--
--   -- em que mês cada negócio passa a contar no painel
--   SELECT "regra", "novoStatus", date_trunc('month', "novoClosedAt") AS mes, count(*)
--   FROM (<ALVO>) x GROUP BY 1,2,3 ORDER BY 1,2,3;
--
--   -- OPEN em etapa terminal que fica de fora por ter sido reaberto de propósito
--   SELECT count(*) FROM deals d JOIN stages s ON s.id = d."stageId"
--   WHERE d.status = 'OPEN' AND (s."isWon" OR s."isLost")
--     AND EXISTS (SELECT 1 FROM deal_events e WHERE e."dealId" = d.id
--                   AND e.type = 'STATUS_CHANGED' AND e.meta->>'to' = 'OPEN'
--                   AND e."createdAt" > COALESCE((SELECT max(x."createdAt") FROM deal_events x
--                                                 WHERE x."dealId" = d.id AND x.type = 'STAGE_CHANGED'),
--                                                '-infinity'::timestamp));
--
-- CONFERÊNCIA depois (Ganho: só WON/false e os LOST de propósito; Perdido: só
-- LOST/false, salvo reabertos):
--
--   SELECT s."isWon", s."isLost", d.status, (d."closedAt" IS NULL) AS sem_closed_at, count(*)
--   FROM deals d JOIN stages s ON s.id = d."stageId"
--   WHERE s."isWon" OR s."isLost" GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
--
-- DESEMPENHO E LOTES: cada negócio candidato custa alguns index scans em
-- deal_events pelo índice ("dealId","createdAt"). Produção espera ~5,5 mil
-- linhas: bem menos de 1 s dentro da transação do `migrate deploy` do boot.
-- Se o volume for muito maior, rode antes, fora do boot (psql), este mesmo
-- arquivo trocando o `CREATE TEMP TABLE ... AS <ALVO>` por
-- `CREATE TEMP TABLE ... AS SELECT * FROM (<ALVO>) x ORDER BY "id" LIMIT 2000`,
-- um lote por transação, até os dois UPDATEs afetarem 0 linhas. O backup
-- acumula as linhas de cada lote, e a migration, quando rodar no boot, não
-- encontra mais nada.

DROP TABLE IF EXISTS pg_temp."_alvo_deals_terminal";

CREATE TEMP TABLE "_alvo_deals_terminal" AS
-- @alvo:inicio
SELECT
  d."id",
  'A_open_em_etapa_terminal'::text AS "regra",
  (CASE WHEN s."isWon" THEN 'WON' ELSE 'LOST' END)::text AS "novoStatus",
  COALESCE(
    entrada."em",
    CASE WHEN ultima_troca."em" IS NULL THEN d."createdAt" END,
    d."updatedAt"
  ) AS "novoClosedAt",
  (CASE
     WHEN entrada."em" IS NOT NULL THEN 'STAGE_CHANGED'
     WHEN ultima_troca."em" IS NULL THEN 'createdAt'
     ELSE 'updatedAt'
   END)::text AS "fonte"
FROM "deals" d
JOIN "stages" s ON s."id" = d."stageId"
CROSS JOIN LATERAL (
  SELECT max(e."createdAt") AS "em" FROM "deal_events" e
  WHERE e."dealId" = d."id"
    AND e."type" = 'STAGE_CHANGED'
    AND (e."meta"->'to'->>'id' = d."stageId" OR e."meta"->>'to' = d."stageId")
) entrada
CROSS JOIN LATERAL (
  SELECT max(e."createdAt") AS "em" FROM "deal_events" e
  WHERE e."dealId" = d."id" AND e."type" = 'STAGE_CHANGED'
) ultima_troca
WHERE d."status" = 'OPEN'
  AND (s."isWon" OR s."isLost")
  AND NOT EXISTS (
    SELECT 1 FROM "deal_events" e
    WHERE e."dealId" = d."id"
      AND e."type" = 'STATUS_CHANGED'
      AND e."meta"->>'to' = 'OPEN'
      AND e."createdAt" > COALESCE(ultima_troca."em", '-infinity'::timestamp)
  )
UNION ALL
SELECT
  d."id",
  'B_fechado_sem_closedAt'::text AS "regra",
  d."status"::text AS "novoStatus",
  COALESCE(
    fechamento."em",
    CASE WHEN s."isWon" OR s."isLost" THEN entrada."em" END,
    d."updatedAt"
  ) AS "novoClosedAt",
  (CASE
     WHEN fechamento."em" IS NOT NULL THEN 'STATUS_CHANGED'
     WHEN (s."isWon" OR s."isLost") AND entrada."em" IS NOT NULL THEN 'STAGE_CHANGED'
     ELSE 'updatedAt'
   END)::text AS "fonte"
FROM "deals" d
JOIN "stages" s ON s."id" = d."stageId"
CROSS JOIN LATERAL (
  SELECT max(e."createdAt") AS "em" FROM "deal_events" e
  WHERE e."dealId" = d."id"
    AND e."type" = 'STATUS_CHANGED'
    AND e."meta"->>'to' = d."status"::text
) fechamento
CROSS JOIN LATERAL (
  SELECT max(e."createdAt") AS "em" FROM "deal_events" e
  WHERE e."dealId" = d."id"
    AND e."type" = 'STAGE_CHANGED'
    AND (e."meta"->'to'->>'id' = d."stageId" OR e."meta"->>'to' = d."stageId")
) entrada
WHERE d."status" IN ('WON', 'LOST')
  AND d."closedAt" IS NULL
-- @alvo:fim
;

-- Backup, antes de qualquer UPDATE: exatamente os negócios do alvo.
CREATE TABLE IF NOT EXISTS "_bkp_deals_terminal_20261010" AS
SELECT d."id", d."status", d."closedAt", d."lostReason", d."updatedAt"
FROM "deals" d
WHERE d."id" IN (SELECT a."id" FROM pg_temp."_alvo_deals_terminal" a);

-- Tabela já existia (lotes rodados antes): acrescenta só o que falta, sem
-- sobrescrever o valor original guardado.
INSERT INTO "_bkp_deals_terminal_20261010" ("id", "status", "closedAt", "lostReason", "updatedAt")
SELECT d."id", d."status", d."closedAt", d."lostReason", d."updatedAt"
FROM "deals" d
WHERE d."id" IN (SELECT a."id" FROM pg_temp."_alvo_deals_terminal" a)
  AND NOT EXISTS (
    SELECT 1 FROM "_bkp_deals_terminal_20261010" b WHERE b."id" = d."id"
  );

-- Regra A: OPEN em etapa terminal → WON/LOST com a data de entrada na etapa.
UPDATE "deals" d
SET "status" = a."novoStatus"::"DealStatus",
    "closedAt" = a."novoClosedAt",
    "lostReason" = CASE WHEN a."novoStatus" = 'WON' THEN NULL ELSE d."lostReason" END
FROM pg_temp."_alvo_deals_terminal" a
WHERE d."id" = a."id"
  AND a."regra" = 'A_open_em_etapa_terminal'
  AND d."status" = 'OPEN';

-- Regra B: WON/LOST sem closedAt → closedAt pelo histórico.
UPDATE "deals" d
SET "closedAt" = a."novoClosedAt"
FROM pg_temp."_alvo_deals_terminal" a
WHERE d."id" = a."id"
  AND a."regra" = 'B_fechado_sem_closedAt'
  AND d."closedAt" IS NULL;

DROP TABLE pg_temp."_alvo_deals_terminal";
