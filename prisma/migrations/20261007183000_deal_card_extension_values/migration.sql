CREATE TABLE "deal_card_extension_values" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "customFieldId" TEXT NOT NULL,

    CONSTRAINT "deal_card_extension_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deal_card_extension_values_dealId_customFieldId_key" ON "deal_card_extension_values"("dealId", "customFieldId");

CREATE INDEX "deal_card_extension_values_organizationId_idx" ON "deal_card_extension_values"("organizationId");

ALTER TABLE "deal_card_extension_values" ADD CONSTRAINT "deal_card_extension_values_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deal_card_extension_values" ADD CONSTRAINT "deal_card_extension_values_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deal_card_extension_values" ADD CONSTRAINT "deal_card_extension_values_customFieldId_fkey" FOREIGN KEY ("customFieldId") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;
