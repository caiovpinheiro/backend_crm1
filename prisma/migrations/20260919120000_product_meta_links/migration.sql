-- Vínculo Produto Bwipo ↔ item do catálogo Commerce da Meta.
-- Separado de products.catalogId (catálogo interno / capacidades).

CREATE TABLE "product_meta_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "metaCatalogId" TEXT NOT NULL,
    "productRetailerId" TEXT NOT NULL,
    "syncStatus" TEXT NOT NULL DEFAULT 'MANUAL',
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_meta_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_meta_links_productId_channelId_key" ON "product_meta_links"("productId", "channelId");
CREATE INDEX "product_meta_links_organizationId_idx" ON "product_meta_links"("organizationId");
CREATE INDEX "product_meta_links_channelId_idx" ON "product_meta_links"("channelId");
CREATE INDEX "product_meta_links_organizationId_metaCatalogId_idx" ON "product_meta_links"("organizationId", "metaCatalogId");

ALTER TABLE "product_meta_links" ADD CONSTRAINT "product_meta_links_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_meta_links" ADD CONSTRAINT "product_meta_links_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_meta_links" ADD CONSTRAINT "product_meta_links_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
