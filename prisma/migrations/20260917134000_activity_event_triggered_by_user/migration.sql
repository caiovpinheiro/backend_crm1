-- Coluna de atribuição do disparador humano de automações.
-- Distinta de actorUserId: actorUserId é quem executou (AUTOMATION/AI/SYSTEM),
-- triggeredByUserId é o colaborador que deu origem à execução (ex.: botão
-- "Executar automação" ou gatilho nascido de uma ação humana). Sem backfill
-- — eventos históricos permanecem NULL, pois a informação não foi coletada
-- antes desta fase. Rollups de agentes usarão COALESCE(actorUserId, triggeredByUserId).

ALTER TABLE "activity_events"
    ADD COLUMN "triggeredByUserId" TEXT;

-- FK simples para DELETE de usuário não seq-scanar activity_events particionada.
CREATE INDEX "activity_events_triggeredByUserId_idx"
ON "activity_events" ("triggeredByUserId");

-- Foreign key: ON DELETE CASCADE mantém o evento, mas limpa a atribuição.
ALTER TABLE "activity_events"
    ADD CONSTRAINT "activity_events_triggeredByUserId_fkey"
    FOREIGN KEY ("triggeredByUserId") REFERENCES "User"(id)
    ON DELETE SET NULL ON UPDATE CASCADE;
