-- Endurecimento do MCP (tabelas novas de 20261118120000_mcp_integration,
-- ainda pequenas: DDL simples, sem CONCURRENTLY).
-- 1) Retenção do histórico por data (services/mcp/retention.ts).
CREATE INDEX IF NOT EXISTS "mcp_audit_logs_createdAt_idx" ON "mcp_audit_logs"("createdAt");
-- 2) Versão de sessão do usuário no consentimento: troca de senha /
--    "sair de todos os dispositivos" derruba a conexão MCP.
ALTER TABLE "mcp_connections" ADD COLUMN IF NOT EXISTS "userSessionVersion" INTEGER;
