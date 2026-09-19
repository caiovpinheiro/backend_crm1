-- `consultar_matricula` deixou de existir: a consulta passou a ser genérica
-- (`search_crm_records`) sobre as fontes e campos configurados do tenant, e o
-- relatório acadêmico virou a entidade `matricula`.
--
-- Migration de DADOS. O que a tool fazia por código vira configuração:
--   * o que ela devolvia  → `readableFields`   ("polo" → "matricula.polo")
--   * o RGM/CPF que a pessoa digitava → `identityKeys`
--   * "duas pessoas no mesmo telefone" → `linkedIdentityKeys` (nome do aluno),
--     que é o que faz o agente perguntar em vez de escolher um registro.
--
-- No-op quando nenhum agente tem a ferramenta: o UPDATE não casa linha
-- nenhuma. Idempotente: rodar de novo não acha mais `consultar_matricula`.

WITH src AS (
  SELECT
    c."id",
    COALESCE(c."toolConfig" -> 'consultar_matricula', '{}'::jsonb) AS old,
    COALESCE(c."toolConfig" -> 'search_crm_records', '{}'::jsonb) AS cur
  FROM "ai_agent_configs" c
  WHERE 'consultar_matricula' = ANY (c."enabledTools")
),
mapped AS (
  SELECT
    s."id",
    s."cur",
    -- Chaves do relatório ganham o prefixo da entidade. O curinga do
    -- relatório inteiro ("*" na tool antiga) vira "matricula.*" — nunca o
    -- curinga global, que liberaria o CRM inteiro.
    (
      SELECT COALESCE(jsonb_agg(DISTINCT k), '[]'::jsonb)
      FROM (
        SELECT v AS k
        FROM jsonb_array_elements_text(
          COALESCE(s.cur -> 'readableFields', '[]'::jsonb)
        ) AS v
        UNION
        SELECT 'matricula.' || regexp_replace(v, '^matricula\.', '')
        FROM jsonb_array_elements_text(
          COALESCE(s.old -> 'readableFields', '[]'::jsonb)
        ) AS v
      ) t
    ) AS readable,
    -- Só RGM e CPF: eram os únicos que o lookup antigo sabia consultar.
    (
      SELECT COALESCE(jsonb_agg(DISTINCT k), '[]'::jsonb)
      FROM (
        SELECT v AS k
        FROM jsonb_array_elements_text(
          COALESCE(s.cur -> 'identityKeys', '[]'::jsonb)
        ) AS v
        UNION
        SELECT 'matricula.' || lower(regexp_replace(v, '^matricula\.', ''))
        FROM jsonb_array_elements_text(
          COALESCE(s.old -> 'identityKeys', '[]'::jsonb)
        ) AS v
        WHERE lower(regexp_replace(v, '^matricula\.', '')) IN ('rgm', 'cpf')
      ) t
    ) AS identity,
    (
      SELECT COALESCE(jsonb_agg(DISTINCT k), '[]'::jsonb)
      FROM (
        SELECT v AS k
        FROM jsonb_array_elements_text(
          COALESCE(s.cur -> 'linkedIdentityKeys', '[]'::jsonb)
        ) AS v
        UNION
        SELECT 'matricula.nome'
      ) t
    ) AS linked
  FROM src s
)
UPDATE "ai_agent_configs" c
SET
  "toolConfig" =
    (COALESCE(c."toolConfig", '{}'::jsonb) - 'consultar_matricula')
    || jsonb_build_object(
      'search_crm_records',
      m."cur" || jsonb_build_object(
        'readableFields', m."readable",
        'identityKeys', m."identity",
        'linkedIdentityKeys', m."linked"
      )
    ),
  -- A consulta precisa estar ligada, senão o agente perde a capacidade que
  -- a tool removida dava a ele.
  "enabledTools" = (
    SELECT array_agg(DISTINCT t)
    FROM unnest(
      array_remove(c."enabledTools", 'consultar_matricula')
      || ARRAY['search_crm_records']
    ) AS t
  )
FROM mapped m
WHERE c."id" = m."id";

-- Template de sistema: agente novo não pode nascer pedindo uma ferramenta
-- que o motor não constrói mais.
UPDATE "ai_agent_templates"
SET "enabledTools" = (
  SELECT array_agg(DISTINCT t)
  FROM unnest(
    array_remove("enabledTools", 'consultar_matricula')
    || ARRAY['search_crm_records']
  ) AS t
)
WHERE 'consultar_matricula' = ANY ("enabledTools");
