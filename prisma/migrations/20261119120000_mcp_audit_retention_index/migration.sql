-- Retenção do histórico MCP por data (services/mcp/retention.ts).
-- Tabela nova (20261118120000_mcp_integration), ainda pequena: CREATE INDEX
-- simples, sem CONCURRENTLY.
CREATE INDEX IF NOT EXISTS "mcp_audit_logs_createdAt_idx" ON "mcp_audit_logs"("createdAt");
