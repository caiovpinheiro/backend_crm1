-- Reserva atômica do worker de mensagens agendadas (PENDING → SENDING).
--
-- migration-safety: ignore (ADD VALUE em enum é aditivo; idempotente via guard).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ScheduledMessageStatus'
      AND e.enumlabel = 'SENDING'
  ) THEN
    ALTER TYPE "ScheduledMessageStatus" ADD VALUE 'SENDING';
  END IF;
END
$$;
