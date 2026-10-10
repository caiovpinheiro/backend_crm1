-- Negócios com status/closedAt incoerentes com a etapa terminal (Ganho/Perdido)
-- e negócios fechados (WON/LOST) sem data de fechamento — SÓ COM EVIDÊNCIA no
-- histórico (`deal_events`).
--
-- POR QUÊ: importação/migração, POST /api/deals, /api/leads, automação
-- `create_deal`/`update_field` e ferramentas de IA gravavam `stageId` direto,
-- sem o patch de status que o move do Kanban aplica. O código passou a
-- sincronizar em todos os caminhos; esta migration acerta o legado. Os KPIs do
-- painel (ganhos, receita, conversão, perdidos, ganhos por agente) contam
-- `status` + `closedAt` no período.
--   Produção, etapa Ganho (isWon): OPEN sem closedAt 4.071 | WON sem closedAt
--   1.365 | WON com closedAt 923 | LOST com closedAt 9.
--   DEV, etapa Perdido (isLost): OPEN sem closedAt 1.805 | LOST ok 23.
--
-- SÓ COM EVIDÊNCIA (decisão de 10/10 após a simulação em produção): a primeira
-- versão datava pelo "createdAt"/"updatedAt" quem não tinha histórico e tocava
-- 62.703 linhas, ~48 mil LOST e ~5 mil WON caindo em setembro/2026. Esses
-- negócios vieram da IMPORTAÇÃO de outro CRM ("createdAt" = data da
-- importação), então a data seria um pico falso. Agora só entra quem tem um
-- evento real de entrada na etapa ou de mudança de status. Os importados sem
-- histórico FICAM COMO ESTÃO (OPEN em etapa terminal, ou WON/LOST sem data) e
-- podem ser tratados depois, se a importação tiver a data original.
--
-- REGRAS (só UPDATE em "deals"; um UPDATE por regra):
--
--   A) status = 'OPEN' numa etapa terminal E com `deal_events` STAGE_CHANGED
--      para a etapa atual (destino `meta->'to'->>'id'`; o formato antigo com
--      `meta->>'to'` = id da etapa também conta — a timeline normaliza os dois):
--        etapa isWon  → status 'WON',  lostReason = NULL
--        etapa isLost → status 'LOST', lostReason mantido
--        closedAt = o ÚLTIMO desses STAGE_CHANGED (entrada na etapa).
--      (etapa marcada isWon e isLost ao mesmo tempo vale como Ganho, igual ao
--      `buildStatusSyncPatch`.)
--      Sem STAGE_CHANGED para a etapa atual: fica OPEN, sem data.
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
--           ela.
--      Sem nenhum dos dois: fica sem data.
--
--   As duas regras não se sobrepõem (A só pega OPEN; B só WON/LOST) e são
--   calculadas sobre o estado ANTERIOR, na tabela temporária
--   "_alvo_deals_terminal" (fonte única para o backup e para os UPDATEs). Toda
--   linha do alvo tem data vinda de um evento; nenhuma usa createdAt/updatedAt.
--
-- "updatedAt" NÃO muda: é preenchido pelo Prisma (@updatedAt) no cliente, não
-- por trigger, e nenhum SET abaixo o menciona.
--
-- IDEMPOTENTE: depois de rodar, todo negócio tocado por A está WON/LOST com
-- closedAt preenchido e todo negócio de B tem closedAt. Rodar de novo encontra
-- alvo vazio; reabertos e negócios sem evidência continuam fora pelo mesmo
-- critério.
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
--   -- o que fica de fora por falta de evidência (importados sem histórico) ou
--   -- por reabertura de propósito
--   SELECT d.status, s."isWon", s."isLost", count(*) AS fica_como_esta
--   FROM deals d JOIN stages s ON s.id = d."stageId"
--   WHERE (d.status = 'OPEN' AND (s."isWon" OR s."isLost")
--          OR d.status IN ('WON','LOST') AND d."closedAt" IS NULL)
--     AND d.id NOT IN (SELECT x."id" FROM (<ALVO>) x)
--   GROUP BY 1,2,3 ORDER BY 1,2,3;
--
-- CONFERÊNCIA antes e depois:
--
--   SELECT s."isWon", s."isLost", d.status, (d."closedAt" IS NULL) AS sem_closed_at, count(*)
--   FROM deals d JOIN stages s ON s.id = d."stageId"
--   WHERE s."isWon" OR s."isLost" GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
--
-- DESEMPENHO E LOTES: cada negócio candidato custa alguns index scans em
-- deal_events pelo índice ("dealId","createdAt"). Produção espera ~10,8 mil
-- linhas no alvo (de ~63 mil candidatos avaliados): poucos segundos no máximo,
-- dentro da transação do `migrate deploy` do boot. Se o volume for muito
-- maior, rode antes, fora do boot (psql), este mesmo arquivo trocando o
-- `CREATE TEMP TABLE ... AS <ALVO>` por
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
  entrada."em" AS "novoClosedAt",
  'STAGE_CHANGED'::text AS "fonte"
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
  AND entrada."em" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "deal_events" e
    WHERE e."dealId" = d."id"
      AND e."type" = 'STATUS_CHANGED'
      AND e."meta"->>'to' = 'OPEN'
      AND e."createdAt" > ultima_troca."em"
  )
UNION ALL
SELECT
  d."id",
  'B_fechado_sem_closedAt'::text AS "regra",
  d."status"::text AS "novoStatus",
  COALESCE(
    fechamento."em",
    CASE WHEN s."isWon" OR s."isLost" THEN entrada."em" END
  ) AS "novoClosedAt",
  (CASE WHEN fechamento."em" IS NOT NULL THEN 'STATUS_CHANGED' ELSE 'STAGE_CHANGED' END)::text AS "fonte"
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
  AND (
    fechamento."em" IS NOT NULL
    OR ((s."isWon" OR s."isLost") AND entrada."em" IS NOT NULL)
  )
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
