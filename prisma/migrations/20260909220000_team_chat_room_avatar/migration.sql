-- Foto de perfil de grupo/canal no chat interno. Idempotente.

ALTER TABLE "team_chat_rooms" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
