-- Autovacuum mais cedo nas tabelas grandes (C6 da auditoria de banco, 05/10).
--
-- pg_stat_user_tables de produção (janela de 5,9 dias):
--   tabela                     vivas       mortas    último autovacuum
--   messages                   1.925.173   224.358   nunca
--   deal_custom_field_values   1.100.330   206.968   nunca
--   meta_webhook_events        3.748.041   649.598   nunca
--   deal_events                1.939.775    39.743   nunca
--   automation_logs            2.537.349     1.251   nunca
--   conversations                362.837    59.794   05/10 (60 mil mortas em 4 h)
--
-- Com o padrão do Postgres (autovacuum_vacuum_scale_factor = 0.2) o vacuum
-- só dispara com 20% da tabela morta: 385 mil linhas em `messages`, 750 mil
-- em `meta_webhook_events`. Até lá as mortas ficam no heap e nos índices
-- (consulta lê mais páginas), o mapa de visibilidade envelhece (index-only
-- scan vira ida ao heap — é o caso do MAX(updatedAt) por contato em
-- `conversations`) e as estatísticas do planner ficam velhas (analyze em
-- 10%). O mesmo vale para o gatilho por INSERT nas tabelas só-inserção
-- (autovacuum_vacuum_insert_scale_factor = 0.2).
--
-- Novo limite por tabela: vacuum com 2% de linhas mortas (ou 5% de linhas
-- inseridas), analyze com 1% alteradas. Em `messages` isso é ~38 mil mortas
-- (≈ 1 vez por dia no ritmo atual); em `conversations`, ~7 mil (≈ a cada
-- meia hora). Vacuums menores e mais frequentes — o custo de cada um cai
-- junto. A retenção de `meta_webhook_events` (até 300 mil DELETEs por noite)
-- passa a ser recolhida no mesmo dia.
--
-- Segurança: `ALTER TABLE … SET (parâmetro de armazenamento)` pede só SHARE
-- UPDATE EXCLUSIVE — NÃO bloqueia SELECT/INSERT/UPDATE/DELETE, não reescreve
-- a tabela e vale para o próximo ciclo do autovacuum. É permitido ao dono da
-- tabela (o papel que roda as migrations), inclusive no Postgres gerenciado
-- da DigitalOcean; não mexe em parâmetro global do servidor. Pode rodar no
-- `migrate deploy` normalmente — não precisa de passo manual.
--
-- Conferir depois:
--   SELECT relname, reloptions FROM pg_class
--    WHERE relname IN ('messages','deal_custom_field_values','meta_webhook_events',
--                      'deal_events','automation_logs','conversations');
--   SELECT relname, n_dead_tup, last_autovacuum, last_autoanalyze
--     FROM pg_stat_user_tables
--    WHERE relname IN ('messages','deal_custom_field_values','meta_webhook_events',
--                      'deal_events','automation_logs','conversations');
--
-- Opcional, uma vez, fora de horário de pico (não bloqueia leitura/escrita;
-- recolhe o passivo sem esperar o primeiro ciclo):
--   VACUUM (ANALYZE) "deal_custom_field_values";
--   VACUUM (ANALYZE) "messages";
--
-- Rollback (volta ao padrão do servidor):
--   ALTER TABLE "<tabela>" RESET (autovacuum_vacuum_scale_factor,
--     autovacuum_analyze_scale_factor, autovacuum_vacuum_insert_scale_factor);

ALTER TABLE "messages" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.05
);

ALTER TABLE "deal_custom_field_values" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.05
);

ALTER TABLE "meta_webhook_events" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.05
);

ALTER TABLE "deal_events" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.05
);

ALTER TABLE "automation_logs" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.05
);

ALTER TABLE "conversations" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.05
);
