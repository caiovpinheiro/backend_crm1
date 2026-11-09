-- "Manter dono do negócio" por departamento: distribuir/transferir para o
-- departamento troca só o responsável da conversa. Default false = ninguém
-- muda de comportamento até alguém ligar a opção.
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "keepDealOwner" BOOLEAN NOT NULL DEFAULT false;
