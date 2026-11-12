-- Tarefa pública: quando true, todos da organização veem e concluem a tarefa.
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "visibleToAll" BOOLEAN NOT NULL DEFAULT false;
