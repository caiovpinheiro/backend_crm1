-- Daily OPEN-deal counts per stage. Required for the Painel stacked evolution
-- chart; current state cannot reconstruct history.
CREATE TABLE IF NOT EXISTS "deal_stage_daily_snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "openCount" INTEGER NOT NULL,
    "openValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_stage_daily_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "deal_stage_daily_snapshots_organizationId_stageId_date_key"
    ON "deal_stage_daily_snapshots"("organizationId", "stageId", "date");

CREATE INDEX IF NOT EXISTS "deal_stage_daily_snapshots_organizationId_pipelineId_date_idx"
    ON "deal_stage_daily_snapshots"("organizationId", "pipelineId", "date");

CREATE INDEX IF NOT EXISTS "deal_stage_daily_snapshots_organizationId_date_idx"
    ON "deal_stage_daily_snapshots"("organizationId", "date");

DO $$ BEGIN
  ALTER TABLE "deal_stage_daily_snapshots"
    ADD CONSTRAINT "deal_stage_daily_snapshots_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "deal_stage_daily_snapshots"
    ADD CONSTRAINT "deal_stage_daily_snapshots_pipelineId_fkey"
    FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "deal_stage_daily_snapshots"
    ADD CONSTRAINT "deal_stage_daily_snapshots_stageId_fkey"
    FOREIGN KEY ("stageId") REFERENCES "stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
