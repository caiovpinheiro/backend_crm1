ALTER TABLE "whatsapp_flow_definitions" ADD COLUMN IF NOT EXISTS "hidden_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "whatsapp_flow_definitions_organizationId_hidden_at_idx"
  ON "whatsapp_flow_definitions" ("organizationId", "hidden_at");
