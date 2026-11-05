-- Opção por automação: mensagem do consultor não encerra o fluxo em andamento.
-- Padrão desligado: nenhuma automação muda de comportamento ao aplicar.
ALTER TABLE "automations"
  ADD COLUMN IF NOT EXISTS "keepRunningOnAgentReply" BOOLEAN NOT NULL DEFAULT false;
