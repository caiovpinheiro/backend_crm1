-- Vários responsáveis por demanda. assigneeId no item continua como
-- o primeiro da lista (compatível com o front antigo).

CREATE TABLE IF NOT EXISTS "demand_item_assignees" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demand_item_assignees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "demand_item_assignees_itemId_userId_key"
  ON "demand_item_assignees"("itemId", "userId");
CREATE INDEX IF NOT EXISTS "demand_item_assignees_organizationId_idx"
  ON "demand_item_assignees"("organizationId");
CREATE INDEX IF NOT EXISTS "demand_item_assignees_userId_idx"
  ON "demand_item_assignees"("userId");

DO $$ BEGIN
  ALTER TABLE "demand_item_assignees"
    ADD CONSTRAINT "demand_item_assignees_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demand_item_assignees"
    ADD CONSTRAINT "demand_item_assignees_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "demand_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "demand_item_assignees"
    ADD CONSTRAINT "demand_item_assignees_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO "demand_item_assignees" ("id", "organizationId", "itemId", "userId", "createdAt")
SELECT 'dia_' || i."id", i."organizationId", i."id", i."assigneeId", CURRENT_TIMESTAMP
FROM "demand_items" i
WHERE i."assigneeId" IS NOT NULL
ON CONFLICT ("itemId", "userId") DO NOTHING;
