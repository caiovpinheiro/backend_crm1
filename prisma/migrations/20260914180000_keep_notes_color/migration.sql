-- AlterTable
ALTER TABLE "keep_notes" ADD COLUMN IF NOT EXISTS "color" TEXT;

CREATE INDEX IF NOT EXISTS "keep_notes_owner_color_idx"
  ON "keep_notes"("organizationId", "userId", "color");
