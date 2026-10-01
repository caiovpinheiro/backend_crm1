-- O RGM passou a ser chave de busca em `lookupStudent` (antes a coluna era
-- importada e nunca consultada). Sem índice, cada identificação informado
-- no chat vira seq scan na tabela do relatório.
--
-- Idempotente (IF NOT EXISTS) para permitir retry de `prisma migrate deploy`.
CREATE INDEX IF NOT EXISTS "student_academic_records_organization_id_rgm_idx"
  ON "student_academic_records" ("organization_id", "rgm");
