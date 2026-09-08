-- AgentTemplate + AIAgentConfig.templateId / maxSteps (Onda 3)

CREATE TABLE IF NOT EXISTS "ai_agent_templates" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "archetypeKey" TEXT,
  "systemPromptTemplate" TEXT NOT NULL,
  "defaultTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "defaultTone" TEXT NOT NULL DEFAULT 'profissional e cordial',
  "defaultModel" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  "defaultInboxPolicy" JSONB,
  "verticalPack" TEXT,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_agent_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_agent_templates_organizationId_idx" ON "ai_agent_templates"("organizationId");
CREATE INDEX IF NOT EXISTS "ai_agent_templates_isSystem_archetypeKey_idx" ON "ai_agent_templates"("isSystem", "archetypeKey");

ALTER TABLE "ai_agent_templates"
  DROP CONSTRAINT IF EXISTS "ai_agent_templates_organizationId_fkey";
ALTER TABLE "ai_agent_templates"
  ADD CONSTRAINT "ai_agent_templates_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "templateId" TEXT;
ALTER TABLE "ai_agent_configs" ADD COLUMN IF NOT EXISTS "maxSteps" INTEGER NOT NULL DEFAULT 8;

CREATE INDEX IF NOT EXISTS "ai_agent_configs_templateId_idx" ON "ai_agent_configs"("templateId");

ALTER TABLE "ai_agent_configs"
  DROP CONSTRAINT IF EXISTS "ai_agent_configs_templateId_fkey";
ALTER TABLE "ai_agent_configs"
  ADD CONSTRAINT "ai_agent_configs_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "ai_agent_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed 4 system templates (idempotent by archetypeKey + isSystem)
INSERT INTO "ai_agent_templates" (
  "id", "name", "description", "archetypeKey", "systemPromptTemplate",
  "defaultTools", "defaultTone", "defaultModel", "defaultInboxPolicy",
  "verticalPack", "isSystem", "createdAt", "updatedAt"
)
SELECT
  'tmpl_sys_sdr',
  'SDR — Qualificação de leads',
  'Faz primeiro contato, qualifica o interesse e cria o deal.',
  'SDR',
  'PLACEHOLDER_SDR',
  ARRAY['create_deal','add_tag','create_activity','search_products','transfer_to_human']::TEXT[],
  'amigável, curioso e objetivo',
  'gpt-4o-mini',
  NULL,
  NULL,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ai_agent_templates" WHERE "isSystem" = true AND "archetypeKey" = 'SDR'
);

INSERT INTO "ai_agent_templates" (
  "id", "name", "description", "archetypeKey", "systemPromptTemplate",
  "defaultTools", "defaultTone", "defaultModel", "defaultInboxPolicy",
  "verticalPack", "isSystem", "createdAt", "updatedAt"
)
SELECT
  'tmpl_sys_atendimento',
  'Atendimento — Primeiro nível',
  'Responde dúvidas frequentes; pack academic por padrão.',
  'ATENDIMENTO',
  'PLACEHOLDER_ATENDIMENTO',
  ARRAY['add_tag','create_activity','consultar_matricula','transfer_to_department','execute_distribution','transfer_to_human','close_conversation']::TEXT[],
  'simpática, paciente e natural (WhatsApp)',
  'gpt-4.1-mini',
  '{"interceptRetention":true,"interceptCourseShopping":true,"inauguralEnabled":true}'::jsonb,
  'academic',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ai_agent_templates" WHERE "isSystem" = true AND "archetypeKey" = 'ATENDIMENTO'
);

INSERT INTO "ai_agent_templates" (
  "id", "name", "description", "archetypeKey", "systemPromptTemplate",
  "defaultTools", "defaultTone", "defaultModel", "defaultInboxPolicy",
  "verticalPack", "isSystem", "createdAt", "updatedAt"
)
SELECT
  'tmpl_sys_vendedor',
  'Vendedor',
  'Conduz a conversa comercial até o fechamento.',
  'VENDEDOR',
  'PLACEHOLDER_VENDEDOR',
  ARRAY['create_deal','move_stage','search_products','add_tag','create_activity','transfer_to_human']::TEXT[],
  'consultivo e confiante',
  'gpt-4o-mini',
  NULL,
  NULL,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ai_agent_templates" WHERE "isSystem" = true AND "archetypeKey" = 'VENDEDOR'
);

INSERT INTO "ai_agent_templates" (
  "id", "name", "description", "archetypeKey", "systemPromptTemplate",
  "defaultTools", "defaultTone", "defaultModel", "defaultInboxPolicy",
  "verticalPack", "isSystem", "createdAt", "updatedAt"
)
SELECT
  'tmpl_sys_suporte',
  'Suporte técnico',
  'Diagnostica e resolve problemas técnicos de primeiro nível.',
  'SUPORTE',
  'PLACEHOLDER_SUPORTE',
  ARRAY['add_tag','create_activity','transfer_to_human','close_conversation']::TEXT[],
  'técnico, claro e empático',
  'gpt-4o-mini',
  NULL,
  NULL,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "ai_agent_templates" WHERE "isSystem" = true AND "archetypeKey" = 'SUPORTE'
);

-- Dual-write: map existing agents to system templates by archetype
UPDATE "ai_agent_configs" c
SET "templateId" = t."id"
FROM "ai_agent_templates" t
WHERE c."templateId" IS NULL
  AND t."isSystem" = true
  AND t."archetypeKey" = c."archetype"::text;
