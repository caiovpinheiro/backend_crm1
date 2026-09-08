-- Auditoria honesta de runs de IA.
--
-- HANDOFF_QUEUED: a distribuição rodou e o pedido ficou em fila
-- (distribution_pending PENDING / NO_ELIGIBLE_RESPONSIBLE) sem responsável
-- elegível, e a conversa voltou para a IA. Antes isso caía em ANSWERED ou
-- TOOL_FAILED — a transferência que de fato aconteceu ficava invisível.
--
-- RESPONSE_DISCARDED: o run produziu (ou devia produzir) resposta e nada foi
-- entregue ao cliente. Antes virava ANSWERED sem nenhuma outbound.
--
-- Só adiciona valores ao enum. Nenhuma coluna existente é alterada.
ALTER TYPE "AIAgentRunOutcome" ADD VALUE IF NOT EXISTS 'HANDOFF_QUEUED';
ALTER TYPE "AIAgentRunOutcome" ADD VALUE IF NOT EXISTS 'RESPONSE_DISCARDED';
