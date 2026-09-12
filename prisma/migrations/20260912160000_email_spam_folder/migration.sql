-- Pasta de sistema Spam (antes a ação SPAM só mandava para a lixeira).

ALTER TYPE "EmailFolder" ADD VALUE IF NOT EXISTS 'SPAM';
