-- Aba Inbox "Resolvido": ticket encerrado em acompanhamento (tarefa no calendário).
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "followUpAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "conversations_org_followUpAt_idx"
  ON "conversations" ("organizationId", "followUpAt")
  WHERE "followUpAt" IS NOT NULL;

-- Quem já vê Encerradas ou Respondidas passa a ver Resolvido.
UPDATE "roles"
SET "permissions" = array_append("permissions", 'inbox:tab:resolvidos')
WHERE NOT ('inbox:tab:resolvidos' = ANY("permissions"))
  AND (
    '*' = ANY("permissions")
    OR 'inbox:tab:finalizados' = ANY("permissions")
    OR 'inbox:tab:respondidas' = ANY("permissions")
  );
