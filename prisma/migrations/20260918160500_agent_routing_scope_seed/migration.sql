-- `inboxPolicy.routingScope` (P1-A) passou a ser a fonte do roteamento do
-- coordenador, mas nenhum agente existente tinha o campo preenchido: a org
-- `teste-dev` seguia caindo no fallback do pack acadêmico.
--
-- Migration de DADOS (o campo mora no JSON de `inboxPolicy`, sem coluna
-- nova). Preenche o escopo de assunto dos três especialistas da org
-- `teste-dev`. Só grava onde ainda não existe `routingScope`.

UPDATE "ai_agent_configs" c
SET "inboxPolicy" = jsonb_set(
  COALESCE(c."inboxPolicy", '{}'::jsonb),
  '{routingScope}',
  to_jsonb(s."scope"),
  true
)
FROM "users" u, "organizations" o, (
  VALUES
    ('acolhi', 'primeiro acesso, portal, senha, onboarding, calouro, aula inaugural, certificado'),
    ('atendimento', 'financeiro, boleto, rematricula, documento, prova, disciplina, estagio, horario, suporte'),
    ('reten', 'cancelar, trancar, trancamento, desistir, transferencia de curso, transferencia de polo, churn')
) AS s("name_part", "scope")
WHERE c."userId" = u."id"
  AND c."organizationId" = o."id"
  AND o."slug" = 'teste-dev'
  AND u."name" ILIKE '%' || s."name_part" || '%'
  AND COALESCE(c."inboxPolicy" ->> 'routingScope', '') = '';
