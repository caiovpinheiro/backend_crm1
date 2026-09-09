ALTER TABLE "keep_notes" ADD COLUMN "position" DOUBLE PRECISION NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "keep_notes_owner_folder_idx";
CREATE INDEX "keep_notes_owner_folder_idx" ON "keep_notes"("organizationId", "userId", "trashed", "archived", "pinned", "position");

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "userId", pinned, archived, trashed
    ORDER BY "updatedAt" DESC
  ) AS rn
  FROM "keep_notes"
)
UPDATE "keep_notes" k
SET "position" = ranked.rn * 1000
FROM ranked
WHERE k.id = ranked.id;
