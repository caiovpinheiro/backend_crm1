-- Suporte remoto como widget (`remote_support`).
--
-- O módulo (card "Suporte remoto" na ficha do contato + rotas
-- /api/remote-support/* + página pública do cliente) passa a existir só
-- nas orgs que instalarem o widget na Central de Widgets — mesmo padrão
-- da Distribuição Inteligente e da Telefonia.
--
-- Sem backfill: é recurso novo, nenhuma org usa ainda; cada uma liga quando
-- quiser. Textos com acento vão em hex UTF-8 (mesmo motivo da
-- 20260815140000_fix_calls_history_widget_copy).
--
-- migration-safety: ignore (só insere no catálogo; não altera schema).

INSERT INTO "widgets" (
  "id", "slug", "name", "description", "icon", "category", "features",
  "ownerType", "availability", "status", "createdAt", "updatedAt"
) VALUES (
  'c' || replace(gen_random_uuid()::text, '-', ''),
  'remote_support',
  'Suporte remoto',
  'Acesso assistido ao computador do cliente, sempre com o consentimento dele. O atendente gera um link na ficha do contato; o cliente abre, roda um arquivo sem instalar e autoriza cada acesso.',
  'screen-share',
  'Atendimento',
  ARRAY[
    'Link por contato, sem instalar nada no cliente',
    -- "O cliente autoriza cada acesso à tela"
    convert_from(decode('4f20636c69656e7465206175746f72697a6120636164612061636573736f20c3a02074656c61', 'hex'), 'UTF8'),
    'Controle da tela direto do CRM',
    -- "Histórico de sessões na ficha do contato"
    convert_from(decode('48697374c3b37269636f2064652073657373c3b56573206e6120666963686120646f20636f6e7461746f', 'hex'), 'UTF8')
  ]::TEXT[],
  'INTERNAL',
  'available',
  'ONLINE',
  NOW(),
  NOW()
)
ON CONFLICT ("slug") DO NOTHING;
