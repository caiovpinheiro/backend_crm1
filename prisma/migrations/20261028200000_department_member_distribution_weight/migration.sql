-- Peso do consultor na distribuição inteligente POR DEPARTAMENTO.
-- NULL = usa o peso geral (`distribution_responsibles.volume`), ou seja,
-- ninguém muda de comportamento até alguém preencher o campo.
ALTER TABLE "department_members" ADD COLUMN IF NOT EXISTS "distributionWeight" INTEGER;

ALTER TABLE "department_members" DROP CONSTRAINT IF EXISTS "department_members_distribution_weight_range";
ALTER TABLE "department_members"
  ADD CONSTRAINT "department_members_distribution_weight_range"
  CHECK ("distributionWeight" IS NULL OR ("distributionWeight" >= 1 AND "distributionWeight" <= 100));
