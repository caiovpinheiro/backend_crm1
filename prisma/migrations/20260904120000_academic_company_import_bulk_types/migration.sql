-- ETL: matriculados (academic) e empresas — novos valores no BulkOperationType.
-- migration-safety: ignore (ADD VALUE em enum é aditivo; idempotente via guard).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'BulkOperationType' AND e.enumlabel = 'ACADEMIC_IMPORT'
  ) THEN
    ALTER TYPE "BulkOperationType" ADD VALUE 'ACADEMIC_IMPORT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'BulkOperationType' AND e.enumlabel = 'COMPANY_IMPORT'
  ) THEN
    ALTER TYPE "BulkOperationType" ADD VALUE 'COMPANY_IMPORT';
  END IF;
END
$$;
