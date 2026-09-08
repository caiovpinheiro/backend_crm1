-- WiPO Chat Fases 2–5: âncoras, work items, encaminhamentos. Idempotente.

CREATE TABLE IF NOT EXISTS "team_chat_work_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "originType" TEXT NOT NULL,
    "originId" TEXT NOT NULL,
    "roomId" TEXT,
    "anchorType" TEXT,
    "anchorId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'canal',
    "createdById" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "callUrl" TEXT,
    "recurrenceKey" TEXT,
    "participantIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_chat_work_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "team_chat_work_item_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "assigneeId" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,

    CONSTRAINT "team_chat_work_item_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "team_chat_work_item_entry_revisions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "changedById" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_chat_work_item_entry_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "team_chat_message_anchors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "anchorType" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_chat_message_anchors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "team_chat_message_forwards" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "destMessageId" TEXT,
    "excerpt" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "destRoomId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "responseNote" TEXT,
    "respondedById" TEXT,

    CONSTRAINT "team_chat_message_forwards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_chat_message_anchors_messageId_key"
  ON "team_chat_message_anchors"("messageId");

CREATE INDEX IF NOT EXISTS "team_chat_work_items_organizationId_createdById_idx"
  ON "team_chat_work_items"("organizationId", "createdById");
CREATE INDEX IF NOT EXISTS "team_chat_work_items_organizationId_type_idx"
  ON "team_chat_work_items"("organizationId", "type");
CREATE INDEX IF NOT EXISTS "team_chat_work_items_roomId_idx"
  ON "team_chat_work_items"("roomId");
CREATE INDEX IF NOT EXISTS "team_chat_work_items_anchorType_anchorId_idx"
  ON "team_chat_work_items"("anchorType", "anchorId");
CREATE INDEX IF NOT EXISTS "team_chat_work_items_recurrenceKey_idx"
  ON "team_chat_work_items"("recurrenceKey");

CREATE INDEX IF NOT EXISTS "team_chat_work_item_entries_workItemId_sortOrder_idx"
  ON "team_chat_work_item_entries"("workItemId", "sortOrder");
CREATE INDEX IF NOT EXISTS "team_chat_work_item_entries_organizationId_assigneeId_status_idx"
  ON "team_chat_work_item_entries"("organizationId", "assigneeId", "status");
CREATE INDEX IF NOT EXISTS "team_chat_work_item_entries_dueAt_idx"
  ON "team_chat_work_item_entries"("dueAt");

CREATE INDEX IF NOT EXISTS "team_chat_work_item_entry_revisions_entryId_createdAt_idx"
  ON "team_chat_work_item_entry_revisions"("entryId", "createdAt");

CREATE INDEX IF NOT EXISTS "team_chat_message_anchors_organizationId_anchorType_anchorId_idx"
  ON "team_chat_message_anchors"("organizationId", "anchorType", "anchorId");

CREATE INDEX IF NOT EXISTS "team_chat_message_forwards_organizationId_destRoomId_idx"
  ON "team_chat_message_forwards"("organizationId", "destRoomId");
CREATE INDEX IF NOT EXISTS "team_chat_message_forwards_fromUserId_createdAt_idx"
  ON "team_chat_message_forwards"("fromUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "team_chat_message_forwards_sourceMessageId_idx"
  ON "team_chat_message_forwards"("sourceMessageId");

DO $$ BEGIN
  ALTER TABLE "team_chat_work_items"
    ADD CONSTRAINT "team_chat_work_items_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_work_items"
    ADD CONSTRAINT "team_chat_work_items_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "team_chat_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_work_items"
    ADD CONSTRAINT "team_chat_work_items_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_work_item_entries"
    ADD CONSTRAINT "team_chat_work_item_entries_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_work_item_entries"
    ADD CONSTRAINT "team_chat_work_item_entries_workItemId_fkey"
    FOREIGN KEY ("workItemId") REFERENCES "team_chat_work_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_work_item_entries"
    ADD CONSTRAINT "team_chat_work_item_entries_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_work_item_entries"
    ADD CONSTRAINT "team_chat_work_item_entries_completedById_fkey"
    FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_work_item_entry_revisions"
    ADD CONSTRAINT "team_chat_work_item_entry_revisions_entryId_fkey"
    FOREIGN KEY ("entryId") REFERENCES "team_chat_work_item_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_work_item_entry_revisions"
    ADD CONSTRAINT "team_chat_work_item_entry_revisions_changedById_fkey"
    FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_message_anchors"
    ADD CONSTRAINT "team_chat_message_anchors_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_message_anchors"
    ADD CONSTRAINT "team_chat_message_anchors_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "team_chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_message_forwards"
    ADD CONSTRAINT "team_chat_message_forwards_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_message_forwards"
    ADD CONSTRAINT "team_chat_message_forwards_sourceMessageId_fkey"
    FOREIGN KEY ("sourceMessageId") REFERENCES "team_chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_message_forwards"
    ADD CONSTRAINT "team_chat_message_forwards_destMessageId_fkey"
    FOREIGN KEY ("destMessageId") REFERENCES "team_chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_message_forwards"
    ADD CONSTRAINT "team_chat_message_forwards_fromUserId_fkey"
    FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_chat_message_forwards"
    ADD CONSTRAINT "team_chat_message_forwards_respondedById_fkey"
    FOREIGN KEY ("respondedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE "roles"
SET "permissions" = ARRAY(
  SELECT DISTINCT k FROM UNNEST(
    "permissions" || ARRAY[
      'team_chat:work_item',
      'team_chat:forward'
    ]::TEXT[]
  ) AS k
),
"updatedAt" = NOW()
WHERE "systemPreset" IN ('MANAGER', 'MEMBER');
