-- verticalPack: existing agents → 'academic'; new agents → NULL (no DB default).
ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "verticalPack" TEXT;

UPDATE "ai_agent_configs" SET "verticalPack" = 'academic' WHERE "verticalPack" IS NULL;

-- Drop accidental default so INSERT without the column stays NULL.
ALTER TABLE "ai_agent_configs" ALTER COLUMN "verticalPack" DROP DEFAULT;
