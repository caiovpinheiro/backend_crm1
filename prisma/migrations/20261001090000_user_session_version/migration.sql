-- Versão da sessão (SV-1): o JWT carrega o valor do login e é rejeitado quando
-- o banco já incrementou (troca de senha, "sair de todos os dispositivos",
-- erase/desativação, remoção da org).
-- Default 0: usuários e tokens já emitidos continuam válidos — sem logout em massa.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;
