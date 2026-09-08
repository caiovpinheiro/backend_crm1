-- `number` sequencial por org agora é preenchido pelo middleware do Prisma
-- (`allocateOrgNumber` em src/lib/prisma.ts, via `org_number_counters`).
-- Antes o campo era `Int` sem default no schema, o que fazia o
-- `CreateInput` gerado exigir `number` em ~44 call-sites — mesmo o
-- middleware preenchendo em runtime.
--
-- `@default(0)` no schema torna o campo opcional no tipo. O middleware
-- continua sobrescrevendo (checa `number == null`, e `undefined == null`).
-- O `0` só chega ao banco se algo inserir por fora da extension E sem
-- passar `number` — aí `allocateOrgNumber` (GREATEST(lastNumber, MAX))
-- realinha e a próxima alocação é 1, sem colisão.

ALTER TABLE "contacts"                   ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "companies"                  ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "tags"                       ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "custom_fields"              ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "saved_filters"              ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "pipelines"                  ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "deals"                      ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "products"                   ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "org_units"                  ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "job_openings"               ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "catalogs"                   ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "conversations"              ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "automations"                ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "channels"                   ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "quick_replies"              ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "departments"                ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "tabulations"                ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "message_templates"          ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "whatsapp_flow_definitions"  ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "distribution_rules"         ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "segments"                   ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "campaigns"                  ALTER COLUMN "number" SET DEFAULT 0;
