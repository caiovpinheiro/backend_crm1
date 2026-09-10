-- Trava de disparo por lote na campanha.
-- sendLimit: tamanho do lote escolhido na criação (null = sem trava).
-- sendCap: teto acumulado de processados (sentCount + failedCount) da rodada.
ALTER TABLE "campaigns" ADD COLUMN "sendLimit" INTEGER;
ALTER TABLE "campaigns" ADD COLUMN "sendCap" INTEGER;
