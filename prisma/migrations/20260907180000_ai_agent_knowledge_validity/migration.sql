-- Validade do documento de conhecimento.
--
-- Antes desta migration todo documento indexado era servido como verdade
-- atemporal: um doc com prazos que vencem em 21/12/2026 continuaria sendo
-- citado como fato em janeiro.
--
-- Nenhuma coluna existente e alterada. `validFrom`/`validUntil` nulos =
-- comportamento anterior (sem validade), portanto nenhum documento ja
-- cadastrado muda de comportamento no deploy. `expiredBehavior` so tem
-- efeito quando `validUntil` esta preenchido.
ALTER TABLE "ai_agent_knowledge_docs"
  ADD COLUMN "validFrom" TIMESTAMP(3),
  ADD COLUMN "validUntil" TIMESTAMP(3),
  ADD COLUMN "expiredBehavior" TEXT NOT NULL DEFAULT 'instruct',
  ADD COLUMN "expiredInstruction" TEXT;

-- Corte por validade na recuperacao (RAG) filtra por agente + validUntil.
CREATE INDEX "ai_agent_knowledge_docs_agentId_validUntil_idx"
  ON "ai_agent_knowledge_docs" ("agentId", "validUntil");
