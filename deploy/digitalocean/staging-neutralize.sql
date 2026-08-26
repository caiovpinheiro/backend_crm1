-- Neutralização do ambiente de staging após restaurar um dump de produção.
--
-- POR QUE ISTO EXISTE
-- -------------------
-- `BaileysManager.startAll()` reconecta, no boot do worker-whatsapp, todo
-- canal BAILEYS_MD com status CONNECTED ou CONNECTING. Um dump de produção
-- traz esses canais e as credenciais de sessão em `baileys_auth_keys`.
-- Subir o worker sem tratar isso faz o staging conectar nos MESMOS números
-- da produção — no multi-device do WhatsApp isso é conflito de sessão, e
-- pode derrubar a produção.
--
-- Rode ANTES de subir qualquer worker, logo após o pg_restore.
--
--   psql "$DATABASE_URL" -f staging-neutralize.sql
--
-- Isto NÃO substitui a regra principal: em staging, suba os workers um a um
-- e de forma deliberada, nunca todos de uma vez.

BEGIN;

-- 1. Nenhum canal pode estar em estado que dispare reconexão automática.
UPDATE channels
   SET status            = 'DISCONNECTED',
       "qrCode"          = NULL,
       "sessionData"     = NULL,
       "lastConnectedAt" = NULL
 WHERE status <> 'DISCONNECTED';

-- 2. Remove o material de sessão do WhatsApp. Sem estas chaves o staging
--    não consegue se passar pela produção nem que alguém reative o canal
--    por engano — o pareamento teria que ser refeito por QR, com um número
--    de teste.
DELETE FROM baileys_auth_keys;

-- 3. Conferência.
SELECT provider,
       status,
       count(*) AS canais
  FROM channels
 GROUP BY provider, status
 ORDER BY provider, status;

SELECT count(*) AS chaves_baileys_restantes FROM baileys_auth_keys;

COMMIT;
