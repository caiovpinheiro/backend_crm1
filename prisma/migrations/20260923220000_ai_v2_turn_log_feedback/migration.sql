-- Agente IA v2: "onde o agente errou" marcado na tela de conversas de teste
-- e o diagnóstico gerado, guardados no próprio log do turno.
ALTER TABLE "ai_simple_turn_logs" ADD COLUMN IF NOT EXISTS "feedback" JSONB;
