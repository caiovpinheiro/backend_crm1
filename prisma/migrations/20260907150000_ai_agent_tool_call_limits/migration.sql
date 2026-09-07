-- Tetos do tool-loop (item 3 da Fase 1).
-- `maxSteps` estava no schema Prisma mas nunca chegou ao banco: o runner
-- lia via cast silencioso e caía sempre no default do código. Sem teto de
-- chamadas, um run chegou a 42 chamadas em cinco minutos.
-- 0 = "usa o default seguro do código" (AGENT_MAX_STEPS / 24 / 3).
ALTER TABLE "ai_agent_configs"
  ADD COLUMN IF NOT EXISTS "maxSteps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxToolCallsPerRun" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "maxRepeatsPerTool" INTEGER NOT NULL DEFAULT 0;
