-- Repasse da IA no modo por leads guarda o recorte (departamento, papéis,
-- pessoas) na fila. Null = rodízio da organização, sem mudança para automações.
ALTER TABLE "distribution_leads_pending" ADD COLUMN IF NOT EXISTS "scope" JSONB;
