-- Visibilidade de equipe e pool livre no papel personalizado.
-- Default false: papéis já existentes não ganham acesso novo até o admin ligar.
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "seeTeam" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "seeUnassigned" BOOLEAN NOT NULL DEFAULT false;
