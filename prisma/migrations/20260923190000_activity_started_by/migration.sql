-- Quem está executando a tarefa. Colunas soltas, sem FK/índice (lock no boot).
ALTER TABLE "activities"
  ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "startedById" TEXT;
