-- ActivityEvent ganhou colunas no schema (1077c3dc) sem migration.
-- migrate deploy não via pendência porque o SQL nunca existiu.
--
-- sourceIsReconstructed é Boolean @default(false): o client manda a coluna
-- em todo INSERT e o log falha com 42703 (column does not exist).
-- As demais são opcionais — o INSERT omite — mas findMany seleciona o model
-- inteiro, então a timeline/feed quebra no primeiro nome ausente.
-- idempotencyKey já entrou em 20260917190000_activity_outbox.
--
-- ADD COLUMN no pai particionado propaga às partições. Nullable, ou NOT NULL
-- com DEFAULT constante, não reescreve as linhas (PG 11+).
--
-- Sem índice/FK em triggeredByUserId: btree no pai trava as partições no boot
-- da API. Mesmo critério de 20260917190000_activity_outbox.

ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "pipelineId" TEXT;
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "fromStageId" TEXT;
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "toStageId" TEXT;
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "tabulationId" TEXT;
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "channel" TEXT;
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "triggeredByUserId" TEXT;
ALTER TABLE "activity_events" ADD COLUMN IF NOT EXISTS "sourceIsReconstructed" BOOLEAN NOT NULL DEFAULT false;
