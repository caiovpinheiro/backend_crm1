-- ADR-S2-1: Remove Role.scopeConfig (YAGNI — UserGroup.grants cobre os casos de uso)
-- Decis~ao Opus registrada: scope por instancia fica em UserGroup.channelGrants/stageGrants
ALTER TABLE "roles" DROP COLUMN IF EXISTS "scope_config";
