-- CreateTable
CREATE TABLE "keep_imports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "noteCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "keep_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keep_notes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" JSONB NOT NULL,
    "plainText" TEXT NOT NULL DEFAULT '',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "trashed" BOOLEAN NOT NULL DEFAULT false,
    "trashedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "keep_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keep_attachments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "keep_attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "keep_imports_organizationId_userId_fileHash_key" ON "keep_imports"("organizationId", "userId", "fileHash");
CREATE INDEX "keep_imports_organizationId_userId_idx" ON "keep_imports"("organizationId", "userId");
CREATE INDEX "keep_notes_owner_folder_idx" ON "keep_notes"("organizationId", "userId", "trashed", "archived", "pinned", "updatedAt");
CREATE INDEX "keep_notes_organizationId_importBatchId_idx" ON "keep_notes"("organizationId", "importBatchId");
CREATE INDEX "keep_attachments_organizationId_noteId_idx" ON "keep_attachments"("organizationId", "noteId");

ALTER TABLE "keep_imports" ADD CONSTRAINT "keep_imports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "keep_imports" ADD CONSTRAINT "keep_imports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "keep_notes" ADD CONSTRAINT "keep_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "keep_notes" ADD CONSTRAINT "keep_notes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "keep_notes" ADD CONSTRAINT "keep_notes_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "keep_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "keep_attachments" ADD CONSTRAINT "keep_attachments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "keep_attachments" ADD CONSTRAINT "keep_attachments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "keep_attachments" ADD CONSTRAINT "keep_attachments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "keep_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Presets MANAGER/MEMBER: Bwipo Keeps. ADMIN já tem `*`.
UPDATE "roles"
SET "permissions" = ARRAY(
  SELECT DISTINCT k FROM UNNEST(
    "permissions" || ARRAY[
      'nav:bwipo-keeps',
      'keep:view',
      'keep:create',
      'keep:edit',
      'keep:delete'
    ]::TEXT[]
  ) AS k
),
"updatedAt" = NOW()
WHERE "systemPreset" IN ('MANAGER', 'MEMBER');
