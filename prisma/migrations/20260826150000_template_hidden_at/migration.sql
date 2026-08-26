-- Oculta template no CRM sem excluir na Meta.
-- Usado quando a Graph recusa a exclusão (template em campanha, janela de
-- 30 dias) mas o operador não quer mais vê-lo na lista.
ALTER TABLE "whatsapp_template_configs"
  ADD COLUMN IF NOT EXISTS "hidden_at" TIMESTAMP(3);

-- A lista de Configurações e o seletor das automações filtram por
-- `hidden_at IS NULL` dentro da org.
CREATE INDEX IF NOT EXISTS "whatsapp_template_configs_organizationId_hidden_at_idx"
  ON "whatsapp_template_configs" ("organizationId", "hidden_at");
