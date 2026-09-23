-- Quem concluiu a tarefa. Coluna solta, sem FK/índice (lock no boot).
ALTER TABLE "activities"
  ADD COLUMN IF NOT EXISTS "completedById" TEXT;
