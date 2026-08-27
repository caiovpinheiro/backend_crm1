-- Permissão da fila do Agente IA — `inbox:tab:agente_ia`.
-- migration-safety: ignore (apenas backfill idempotente em `roles.permissions`).
--
-- Contexto: as conversas com um usuário `type: AI` como responsável ficavam
-- espalhadas entre Entrada e Automação. Agora têm aba própria ("Agente IA"),
-- de onde saem no handoff (com consultor → Entrada com dono; fila cheia →
-- Entrada sem dono). Sem a key nova a aba apareceria vazia para MEMBER.
--
-- Pattern: mesmo de `20260808140000_add_inbox_tab_permissions` (UNNEST +
-- DISTINCT). ADMIN não precisa (`*`). Custom roles (systemPreset IS NULL) não
-- são tocadas — `canSeeInboxTab` / `withInboxQueueVisibility` têm fallback
-- para `inbox:tab:entrada` / `inbox:tab:automacao` enquanto o gestor não
-- marcar a nova caixa em Settings → Permissões.

UPDATE "roles"
SET "permissions" = ARRAY(
  SELECT DISTINCT k FROM UNNEST(
    "permissions" || ARRAY['inbox:tab:agente_ia']::TEXT[]
  ) AS k
),
"updatedAt" = NOW()
WHERE "systemPreset" IN ('MANAGER', 'MEMBER');
