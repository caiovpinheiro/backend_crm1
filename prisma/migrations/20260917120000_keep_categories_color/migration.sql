-- AlterTable
ALTER TABLE "keep_categories" ADD COLUMN IF NOT EXISTS "color" TEXT;

UPDATE "keep_categories" SET "color" = 'ember' WHERE "color" IS NULL;

ALTER TABLE "keep_categories" ALTER COLUMN "color" SET NOT NULL;
