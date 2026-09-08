-- messages: UNIQUE (organizationId, externalId) — dedup de inbound no BANCO.
--
-- Antes disso a dedup era só aplicação: `findFirst({ externalId })` seguido de
-- `create` dentro da mesma transação, nos 3 ingests (meta-webhook/handler.ts,
-- meta-webhook/messaging-handler.ts, workers/baileys/message-handler.ts).
-- READ COMMITTED não segura nada aqui: com o worker Meta em concurrency 4,
-- dois eventos do MESMO wamid leem "não existe" na mesma janela e gravam duas
-- linhas. Efeito visível: a IA responde DUAS vezes a mesma mensagem do cliente.
--
-- Escopo (organizationId, externalId) e não `externalId` global:
--   - a dedup em código sempre foi por org (`Message` está em SCOPED_MODELS,
--     então a extension de organization-scope injeta `organizationId` no
--     where do findFirst) — unique global mudaria a semântica;
--   - o mesmo número/WABA pode estar conectado em duas orgs do mesmo banco
--     (org de teste + org real). Unique global rejeitaria o ingest legítimo
--     da segunda org e a mensagem seria PERDIDA, não deduplicada;
--   - `Contact` e `Deal` já usam @@unique([organizationId, externalId]) —
--     mesma convenção.
--
-- `externalId` é nullable (mensagem interna/system não tem wamid). O btree
-- unique do Postgres é NULLS DISTINCT por default, então linhas sem externalId
-- não colidem entre si e NÃO precisamos de índice parcial. Índice parcial
-- (`WHERE "externalId" IS NOT NULL`) foi descartado de propósito: não é
-- expressável no schema.prisma, e o banco de DEV é gerenciado em estilo
-- `prisma db push` — o push dropa índice que não está no schema.
--
-- PRODUÇÃO (tabela grande): rode ANTES, fora de transação, para não travar
-- writes de mensagem durante o build do índice:
--
--   CREATE UNIQUE INDEX CONCURRENTLY "messages_organizationId_externalId_key"
--     ON "messages" ("organizationId", "externalId");
--
-- Feito isso, esta migration é no-op (IF NOT EXISTS). CONCURRENTLY não pode
-- vir aqui porque o `prisma migrate deploy` roda cada migration em transação.
--
-- Se houver duplicatas pré-existentes o CREATE falha. Em vez de abortar o
-- deploy inteiro (o ambiente aplica migrations à mão, com SKIP_PRISMA_MIGRATE),
-- a criação é tentada dentro de um bloco que converte a falha em WARNING: a
-- dedup em aplicação continua valendo e o operador limpa e re-roda. A migration
-- é idempotente e segura para re-execução.
--
-- Diagnóstico das duplicatas:
--
--   SELECT "organizationId", "externalId", count(*)
--     FROM messages
--    WHERE "externalId" IS NOT NULL
--    GROUP BY 1, 2 HAVING count(*) > 1
--    ORDER BY 3 DESC;
--
-- Limpeza (mantém a linha mais antiga de cada grupo; conferir os FKs
-- favorite_messages / pinned_messages antes, ambos são ON DELETE CASCADE):
--
--   DELETE FROM messages m
--    USING messages keep
--    WHERE m."externalId" IS NOT NULL
--      AND m."organizationId" = keep."organizationId"
--      AND m."externalId" = keep."externalId"
--      AND (keep."createdAt", keep.id) < (m."createdAt", m.id);

DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS "messages_organizationId_externalId_key"
      ON "messages" ("organizationId", "externalId");
  EXCEPTION
    WHEN unique_violation THEN
      RAISE WARNING
        'messages_organizationId_externalId_key NAO criado: existem duplicatas em (organizationId, externalId). Rode o SELECT/DELETE documentado no topo desta migration e crie o indice a mao (de preferencia CONCURRENTLY).';
  END;
END $$;
