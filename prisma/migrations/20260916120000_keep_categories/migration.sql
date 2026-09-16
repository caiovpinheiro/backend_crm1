-- CreateTable
CREATE TABLE "keep_categories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "keep_categories_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "keep_notes" ADD COLUMN "categoryId" TEXT;

-- CreateIndex
CREATE INDEX "keep_categories_owner_pos_idx" ON "keep_categories"("organizationId", "userId", "position");

-- CreateIndex
CREATE INDEX "keep_notes_owner_category_idx" ON "keep_notes"("organizationId", "userId", "categoryId", "position");

-- AddForeignKey
ALTER TABLE "keep_categories" ADD CONSTRAINT "keep_categories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keep_categories" ADD CONSTRAINT "keep_categories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keep_notes" ADD CONSTRAINT "keep_notes_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "keep_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
