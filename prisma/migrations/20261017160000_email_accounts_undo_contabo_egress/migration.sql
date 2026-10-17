-- Reverte, nas contas de e-mail já conectadas, o paliativo que o frontend
-- aplicou entre 11/09 e 17/10/2026 (frontend_crm1 5d075f38 → #222): toda
-- conta nova era gravada com smtp_host = 185.215.164.198 (smarthost
-- crm-smtp-proxy da Contabo, hoje desligado), smtp_port = 2525..2534 e
-- smtp_encryption = NONE. A porta identificava o preset do provedor. Sem
-- isto, enviar por essas contas dá "Servidor SMTP inacessível" e o usuário
-- teria de desconectar e reconectar cada uma.
--
-- Devolve host/porta/TLS reais do preset (mesmos valores de
-- frontend_crm1 src/features/email-v2/providers.ts). A saída bloqueada da
-- DigitalOcean é tratada no backend por SMTP_PROXY_URL (email-smtp.ts).
-- IMAP nunca foi alterado pelo paliativo. Idempotente: só toca linhas com o
-- IP da Contabo.

UPDATE "email_accounts" AS a
SET smtp_host = m.host,
    smtp_port = m.port,
    smtp_encryption = m.enc::"EmailEncryption"
FROM (VALUES
  (2525, 'smtp.gmail.com',      587, 'STARTTLS'),
  (2526, 'smtp.office365.com',  587, 'STARTTLS'),
  (2527, 'smtps.uhserver.com',  465, 'SSL_TLS'),
  (2528, 'email-ssl.com.br',    465, 'SSL_TLS'),
  (2529, 'smtp.hostinger.com',  465, 'SSL_TLS'),
  (2530, 'smtp.kinghost.net',   587, 'STARTTLS'),
  (2531, 'smtp.mail.yahoo.com', 587, 'STARTTLS'),
  (2532, 'smtp.zoho.com',       587, 'STARTTLS'),
  (2533, 'smtp.mail.me.com',    587, 'STARTTLS')
) AS m(old_port, host, port, enc)
WHERE a.smtp_host = '185.215.164.198'
  AND a.smtp_port = m.old_port;

-- Porta 2534 = provedor "Outro (configurar manualmente)": o paliativo não
-- guardou o SMTP digitado. Quando o IMAP casa com um preset conhecido, usa
-- o SMTP do preset; caso contrário a conta fica como está e o usuário
-- precisa reconectá-la (o backend devolve "Servidor SMTP inacessível").
UPDATE "email_accounts" AS a
SET smtp_host = m.host,
    smtp_port = m.port,
    smtp_encryption = m.enc::"EmailEncryption"
FROM (VALUES
  ('imap.gmail.com',        'smtp.gmail.com',      587, 'STARTTLS'),
  ('outlook.office365.com', 'smtp.office365.com',  587, 'STARTTLS'),
  ('imap.uhserver.com',     'smtps.uhserver.com',  465, 'SSL_TLS'),
  ('email-ssl.com.br',      'email-ssl.com.br',    465, 'SSL_TLS'),
  ('imap.hostinger.com',    'smtp.hostinger.com',  465, 'SSL_TLS'),
  ('imap.kinghost.net',     'smtp.kinghost.net',   587, 'STARTTLS'),
  ('imap.mail.yahoo.com',   'smtp.mail.yahoo.com', 587, 'STARTTLS'),
  ('imap.zoho.com',         'smtp.zoho.com',       587, 'STARTTLS'),
  ('imap.mail.me.com',      'smtp.mail.me.com',    587, 'STARTTLS')
) AS m(imap_host, host, port, enc)
WHERE a.smtp_host = '185.215.164.198'
  AND lower(a.imap_host) = m.imap_host;
