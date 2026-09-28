CREATE TABLE IF NOT EXISTS "product_message_templates" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "ProductKind" NOT NULL,
  "courseLevel" "CourseLevel",
  "content" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_message_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "product_message_templates_organizationId_kind_active_idx"
  ON "product_message_templates"("organizationId", "kind", "active");

DO $$ BEGIN
  ALTER TABLE "product_message_templates"
    ADD CONSTRAINT "product_message_templates_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
