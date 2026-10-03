-- Lista do inbox pela última mensagem (D1 = N-BE-1 / 2.2 / N-FE-5 da
-- auditoria, rodada 2).
--
-- A lista paginava por "updatedAt", que muda quando alguém só lê, atribui ou
-- encerra a conversa; a tela ordena pela última mensagem. Agora a conversa
-- guarda "lastMessageAt" (última mensagem de chat, entrada ou saída — mesmo
-- recorte da prévia do card) e a lista ordena e pagina (keyset) por
--   COALESCE("lastMessageAt", "updatedAt") DESC, id DESC
-- O COALESCE é o fallback enquanto o backfill não passou (e para conversa sem
-- nenhuma mensagem de chat): a linha NULL fica na posição que tinha antes.
-- Por isso os índices são de expressão — um índice em "lastMessageAt" puro não
-- serviria essa ordem. Sem NULL na chave, "NULLS LAST" não se aplica.
--
-- Expand-only: coluna nullable sem default (ADD COLUMN é só catálogo no
-- PG 17, instantâneo) e dois índices novos. Nada é removido; o código anterior
-- ignora a coluna.
--
--   1. conversations_org_last_message_at_id_idx — "Todos", Encerradas,
--      Resolvendo e qualquer filtro sem status fixo.
--   2. conversations_open_org_last_message_at_id_idx — parcial das filas em
--      aberto (Entrada, Aguardando, Respondidas, Agente IA, Automação, Erro:
--      todas fixam status = 'OPEN'). Pequeno: só os tickets abertos.
--
-- PRODUÇÃO (conversations ~590 MB): o CREATE INDEX abaixo bloqueia escrita
-- em "conversations" enquanto constrói. ANTES do deploy, rode à mão, fora de
-- transação (psql, uma linha por vez):
--
--   ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_org_last_message_at_id_idx"
--     ON "conversations" ("organizationId", (COALESCE("lastMessageAt", "updatedAt")) DESC, "id" DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "conversations_open_org_last_message_at_id_idx"
--     ON "conversations" ("organizationId", (COALESCE("lastMessageAt", "updatedAt")) DESC, "id" DESC)
--     WHERE "status" = 'OPEN';
--
-- e confira que ficaram válidos (um CONCURRENTLY interrompido deixa o índice
-- INVALID; nesse caso DROP INDEX CONCURRENTLY e crie de novo):
--
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname LIKE 'conversations_%last_message_at%';
--
-- Com isso os IF NOT EXISTS daqui viram no-op. Depois do deploy, o backfill:
--   DATABASE_URL=... node scripts/backfill-conversations-last-message-at.mjs --apply
--
-- Rollback (o código anterior não lê a coluna):
--   DROP INDEX CONCURRENTLY IF EXISTS "conversations_open_org_last_message_at_id_idx";
--   DROP INDEX CONCURRENTLY IF EXISTS "conversations_org_last_message_at_id_idx";
-- A coluna pode ficar.

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "lastMessageAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "conversations_org_last_message_at_id_idx"
  ON "conversations" ("organizationId", (COALESCE("lastMessageAt", "updatedAt")) DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "conversations_open_org_last_message_at_id_idx"
  ON "conversations" ("organizationId", (COALESCE("lastMessageAt", "updatedAt")) DESC, "id" DESC)
  WHERE "status" = 'OPEN';
