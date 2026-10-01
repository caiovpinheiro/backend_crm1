ALTER TABLE "course_configs" ADD COLUMN IF NOT EXISTS "gradeUrl" TEXT;
ALTER TABLE "course_configs" ADD COLUMN IF NOT EXISTS "gradeFileName" TEXT;
ALTER TABLE "course_configs" ADD COLUMN IF NOT EXISTS "gradeMime" TEXT;
