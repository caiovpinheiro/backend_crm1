-- Reatribuição / remoção de responsável em massa no inbox.
--
-- migration-safety: ignore (ADD VALUE em enum é aditivo; idempotente via guard).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'BulkOperationType' AND e.enumlabel = 'CONVERSATION_BULK_ASSIGN'
  ) THEN
    ALTER TYPE "BulkOperationType" ADD VALUE 'CONVERSATION_BULK_ASSIGN';
  END IF;
END
$$;
