-- `contacts_org_phone_digits_rev_idx` (criado em
-- 20260610_search_phone_digits) nunca serviu ao seu propósito: o banco roda
-- em collation en_US.UTF-8 e, fora da collation C, um btree comum não pode
-- responder `LIKE 'prefixo%'`. É preciso `text_pattern_ops`.
--
-- Efeito medido em produção (26/ago/26): a busca por telefone em
-- `findContactIdsByPhoneDigits` varria os 42.666 contatos da organização
-- aplicando regexp_replace + reverse por linha — 95ms por chamada. Com o
-- índice certo, 0,10ms. O caminho é compartilhado por inbox, negócios,
-- contatos e kanban.
--
-- O índice antigo fica de pé: ainda cobre igualdade e a remoção exigiria
-- confirmar que nenhum plano depende dele.
--
-- Versão CONCURRENTLY (produção, fora do prisma migrate) em
-- `prisma/scripts/create-trgm-indexes-concurrently.sql`.

CREATE INDEX IF NOT EXISTS "contacts_org_phone_digits_rev_pattern_idx"
  ON "contacts" USING btree (
    "organizationId",
    (reverse(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'))) text_pattern_ops
  );
