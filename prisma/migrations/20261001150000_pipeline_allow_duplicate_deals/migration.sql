-- Opção do funil: permitir ou não vários negócios abertos do mesmo contato.
-- Default true = comportamento atual. Sem índice novo.
-- migration-safety: ignore (ADD COLUMN com default constante, sem rewrite de tabela
-- em Postgres 11+; coluna nova, não lida pelo GET /api/pipelines até o deploy).

ALTER TABLE "pipelines"
  ADD COLUMN IF NOT EXISTS "allowDuplicateDeals" BOOLEAN NOT NULL DEFAULT true;
