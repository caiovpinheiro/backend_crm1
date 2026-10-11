-- Retrospectiva do motor v2 desde que os agentes foram ligados.
-- Só agregados: nenhuma consulta devolve mensagem, nome ou telefone.
-- Troque a data '2026-09-29' pela data em que o agente foi ligado e rode
-- bloco a bloco; cole as saídas no chat.
--
-- Complemento: a tela "Auditoria do motor" de cada agente, com o período
-- inteiro, dá o índice e os 12 defeitos por conversa (sem_resposta,
-- transferencia_muda, ping_pong, …). Cole o resumo (conversas, com defeito,
-- índice, por bandeira) de cada agente.

-- 1. Volume por agente e por dia: turnos, conversas, transferências,
--    encerramentos, erros, sem resposta.
SELECT a."name" AS agente, date_trunc('day', l."createdAt")::date AS dia,
       count(*) AS turnos,
       count(DISTINCT l."conversationId") AS conversas,
       count(*) FILTER (WHERE l."handoff") AS transferiu,
       count(*) FILTER (WHERE (l."contextSnapshot"->>'closed') = 'true') AS encerrou,
       count(*) FILTER (WHERE l."error" IS NOT NULL) AS erros,
       count(*) FILTER (WHERE l."reply" IS NULL AND NOT l."handoff" AND l."error" IS NULL AND (l."contextSnapshot"->>'closed') IS DISTINCT FROM 'true') AS sem_resposta,
       round(avg(l."latencyMs")) AS latencia_ms
  FROM "ai_simple_turn_logs" l
  JOIN "ai_agent_configs" a ON a."id" = l."agentId"
 WHERE l."createdAt" >= '2026-09-29'
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- 2. Causa das transferências por agente (motor × modelo × configuração).
--    limit/identification/media/cost_cap/error/guard/no_source = motor ou
--    material; model/sentiment/tried_and_failed/human_request = modelo ou
--    cliente; direct_theme/onboarding/rule = configuração.
SELECT a."name" AS agente,
       coalesce(l."contextSnapshot"->'facts'->>'handoffCause', '(sem causa registrada)') AS causa,
       count(*) AS turnos,
       count(DISTINCT l."conversationId") AS conversas
  FROM "ai_simple_turn_logs" l
  JOIN "ai_agent_configs" a ON a."id" = l."agentId"
 WHERE l."createdAt" >= '2026-09-29' AND l."handoff"
 GROUP BY 1, 2
 ORDER BY 1, 3 DESC;

-- 3. Para onde foi: destino da transferência (passo "Transferido para X").
SELECT a."name" AS agente,
       substring(s->>'detail' FROM '^Transferido para ([a-z_]+)') AS destino,
       count(*) AS vezes
  FROM "ai_simple_turn_logs" l
  JOIN "ai_agent_configs" a ON a."id" = l."agentId"
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(l."contextSnapshot"->'trace', '[]'::jsonb)) s
 WHERE l."createdAt" >= '2026-09-29' AND s->>'detail' LIKE 'Transferido para %'
 GROUP BY 1, 2
 ORDER BY 1, 3 DESC;

-- 4. Decisões mais frequentes do motor (passo do rastro, sem o trecho
--    variável). É o "mapa de decisões" medido: quais caminhos de fato rodam.
SELECT s->>'step' AS etapa,
       left(regexp_replace(s->>'detail', '[“"].*?[”"]|\(.*?\)|\d+', '…', 'g'), 90) AS decisao,
       count(*) AS vezes,
       count(DISTINCT l."conversationId") AS conversas
  FROM "ai_simple_turn_logs" l
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(l."contextSnapshot"->'trace', '[]'::jsonb)) s
 WHERE l."createdAt" >= '2026-09-29'
   AND s->>'step' IN ('transferência','limites','regra','encerramento','fila','verificação','entrada','mídia','parada','pós-encerramento','sentimento','ações')
 GROUP BY 1, 2
HAVING count(*) >= 3
 ORDER BY 3 DESC
 LIMIT 80;

-- 5. Erros do motor por tipo (primeiras palavras da mensagem).
SELECT a."name" AS agente, left(regexp_replace(l."error", '\d+', 'N', 'g'), 80) AS erro, count(*) AS vezes,
       min(l."createdAt") AS primeiro, max(l."createdAt") AS ultimo
  FROM "ai_simple_turn_logs" l
  JOIN "ai_agent_configs" a ON a."id" = l."agentId"
 WHERE l."createdAt" >= '2026-09-29' AND l."error" IS NOT NULL
 GROUP BY 1, 2
 ORDER BY 3 DESC;

-- 6. Como as conversas do agente terminaram (estado final por conversa).
SELECT a."name" AS agente, s."stage", s."owner", coalesce(s."closeReason", '-') AS motivo_fecho, count(*) AS conversas
  FROM "ai_simple_conversation_states" s
  JOIN "ai_agent_configs" a ON a."id" = s."agentId"
 WHERE s."updatedAt" >= '2026-09-29'
 GROUP BY 1, 2, 3, 4
 ORDER BY 1, 5 DESC;

-- 7. Conversas com mais de uma transferência (cadeia / ping-pong / volta).
SELECT a."name" AS agente, n AS transferencias_na_conversa, count(*) AS conversas
  FROM (
    SELECT l."agentId", l."conversationId", count(*) FILTER (WHERE l."handoff") AS n
      FROM "ai_simple_turn_logs" l
     WHERE l."createdAt" >= '2026-09-29'
     GROUP BY 1, 2
  ) x
  JOIN "ai_agent_configs" a ON a."id" = x."agentId"
 WHERE n >= 1
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- 8. Verificação da resposta (afirmação sem fonte, data no tempo errado,
--    instrução desautorizada): quantas vezes a guarda agiu.
SELECT left(s->>'detail', 70) AS guarda, count(*) AS vezes, count(DISTINCT l."conversationId") AS conversas
  FROM "ai_simple_turn_logs" l
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(l."contextSnapshot"->'trace', '[]'::jsonb)) s
 WHERE l."createdAt" >= '2026-09-29' AND s->>'step' IN ('verificação','guarda')
 GROUP BY 1
 ORDER BY 2 DESC
 LIMIT 40;

-- 9. Mensagens prontas e anexos: enviados × barrados × anunciados e não enviados.
SELECT left(regexp_replace(s->>'detail', '[“"].*?[”"]|\(.*?\)', '…', 'g'), 80) AS acao, count(*) AS vezes
  FROM "ai_simple_turn_logs" l
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(l."contextSnapshot"->'trace', '[]'::jsonb)) s
 WHERE l."createdAt" >= '2026-09-29' AND s->>'step' IN ('ações','mídia')
 GROUP BY 1
 ORDER BY 2 DESC
 LIMIT 40;

-- 10. Feedback marcado nas conversas de teste/produção ("onde o agente errou").
SELECT a."name" AS agente, l."feedback"->>'kind' AS tipo, count(*) AS vezes
  FROM "ai_simple_turn_logs" l
  JOIN "ai_agent_configs" a ON a."id" = l."agentId"
 WHERE l."createdAt" >= '2026-09-29' AND l."feedback" IS NOT NULL
 GROUP BY 1, 2
 ORDER BY 1, 3 DESC;

-- 11. Tempo até a primeira resposta do agente em cada conversa (p50/p90).
SELECT a."name" AS agente,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) AS p50_s,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) AS p90_s,
       count(*) AS conversas
  FROM (
    SELECT l."agentId", l."conversationId",
           extract(epoch FROM min(l."createdAt") - min(c."createdAt")) AS secs
      FROM "ai_simple_turn_logs" l
      JOIN "conversations" c ON c."id" = l."conversationId"
     WHERE l."createdAt" >= '2026-09-29' AND l."reply" IS NOT NULL
     GROUP BY 1, 2
  ) x
  JOIN "ai_agent_configs" a ON a."id" = x."agentId"
 GROUP BY 1;

-- 12. Pessoas assumindo depois do agente: conversas do agente em que uma
--     pessoa respondeu (hasHumanReply) — sinal de que o agente não resolveu.
SELECT a."name" AS agente,
       count(DISTINCT l."conversationId") AS conversas_do_agente,
       count(DISTINCT l."conversationId") FILTER (WHERE c."hasHumanReply") AS com_pessoa_depois,
       round(100.0 * count(DISTINCT l."conversationId") FILTER (WHERE c."hasHumanReply") / nullif(count(DISTINCT l."conversationId"), 0), 1) AS pct
  FROM "ai_simple_turn_logs" l
  JOIN "conversations" c ON c."id" = l."conversationId"
  JOIN "ai_agent_configs" a ON a."id" = l."agentId"
 WHERE l."createdAt" >= '2026-09-29'
 GROUP BY 1;
