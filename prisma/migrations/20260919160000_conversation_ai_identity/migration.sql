-- Identificação do cliente passa a pertencer à conversa, não ao turno do agente.
-- Sem isto, cada transferência entre agentes recomeçava do zero e pedia de
-- novo o número que a pessoa já tinha informado.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "aiIdentifiedEntity" TEXT,
  ADD COLUMN IF NOT EXISTS "aiIdentifiedRecordId" TEXT,
  ADD COLUMN IF NOT EXISTS "aiIdentifiedRef" TEXT,
  ADD COLUMN IF NOT EXISTS "aiIdentifiedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "aiIdentifiedAt" TIMESTAMP(3);
