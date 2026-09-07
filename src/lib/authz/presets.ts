/**
 * Defaults dos 3 presets de Role (ADMIN/MANAGER/MEMBER).
 *
 * IMPORTANTE: este arquivo e a fonte da verdade pra TS — o seed SQL na
 * migration 20260601000000_authz_foundation/migration.sql replica
 * literalmente esses arrays. Se voce alterar permissions de um preset
 * aqui, EDITE TAMBEM o SQL e crie uma migration de update se a alteracao
 * precisar refletir em orgs ja existentes.
 *
 * Por que duas fontes? Porque o seed inicial roda no Postgres direto
 * (sem app rodando), e o reset/recriacao de presets via UI roda no app
 * (e usa esses arrays). Mantemos sincronizados manualmente — preco da
 * simplicidade.
 *
 * Comportamento desejado: ZERO quebra na transicao da Fase 1. Os
 * presets espelham o que cada role conseguia fazer ANTES (ADMIN=tudo,
 * MANAGER=gestao, MEMBER=operacional basico). Editar valores so apos
 * Fase 2 (quando a UI permitir customizacao por org).
 */

import type { UserRole } from "@prisma/client";

export const ADMIN_PERMISSIONS: readonly string[] = ["*"];

export const MANAGER_PERMISSIONS: readonly string[] = [
  // Pipeline
  "pipeline:view", "pipeline:create", "pipeline:edit", "pipeline:delete", "pipeline:manage_stages",
  // Contact
  "contact:view", "contact:create", "contact:edit", "contact:delete",
  "contact:export", "contact:import", "contact:merge", "contact:bulk_edit",
  // Company
  "company:view", "company:create", "company:edit", "company:delete",
  // Deal
  "deal:view", "deal:create", "deal:edit", "deal:delete",
  "deal:transfer_owner", "deal:change_stage", "deal:set_won", "deal:set_lost",
  // Conversation
  "conversation:view", "conversation:claim", "conversation:transfer",
  "conversation:reassign_others",
  "conversation:resolve", "conversation:send_template", "conversation:transfer_channel",
  // Filas da Inbox — Gestor vê todas as abas
  "inbox:tab:todos", "inbox:tab:entrada", "inbox:tab:esperando", "inbox:tab:respondidas",
  "inbox:tab:ligar", "inbox:tab:agente_ia",
  "inbox:tab:automacao", "inbox:tab:resolvidos", "inbox:tab:finalizados", "inbox:tab:erro",
  // Automation / AI
  "automation:view", "automation:create", "automation:edit", "automation:publish", "automation:delete",
  "ai_agent:view", "ai_agent:create", "ai_agent:edit", "ai_agent:delete",
  // Distribution (módulo smart_distribution)
  "distribution:view", "distribution:manage", "distribution:execute",
  // Campaign
  "campaign:view", "campaign:create", "campaign:edit", "campaign:send", "campaign:cancel",
  // Reports
  "report:view", "report:export",
  // Settings (subset — billing/api_tokens ficam com ADMIN)
  "settings:team", "settings:branding", "settings:channels",
  "settings:custom_fields", "settings:integrations",
  // Tag / Segment / Product
  "tag:view", "tag:create", "tag:edit", "tag:delete",
  "segment:view", "segment:create", "segment:edit", "segment:delete",
  "product:view", "product:create", "product:edit", "product:delete",
  "product:manage_offers", "product:manage_stakeholders",
  // Inventário / Vagas / Unidades — Gestor tem tudo
  "inventory:view", "inventory:adjust",
  "job_opening:view", "job_opening:manage", "job_opening:close",
  "org_unit:view", "org_unit:manage",
  // Catálogo por capacidades — Gestor tem tudo
  "catalog:view", "catalog:create", "catalog:edit_capabilities",
  "catalog:delete", "catalog:save_as_template",
  // Cotas de desconto — Gestor gerencia e visualiza. Operador (MEMBER)
  // apenas visualiza (ver bloco abaixo).
  "quota:view", "quota:manage",
  // Channel / Template
  "channel:view", "channel:edit",
  "template:view", "template:create", "template:edit",
  // Tasks
  "task:view", "task:create", "task:edit", "task:delete", "task:complete_others",
  // Navegação (sidebar principal) — MANAGER vê TODOS os itens visíveis hoje
  // (`allowedRoles` no catálogo do front já cobria automations/distribution/logs).
  "nav:dashboard", "nav:pipeline", "nav:contacts", "nav:companies",
  "nav:inbox", "nav:activities", "nav:automations", "nav:campaigns",
  "nav:distribution", "nav:logs", "nav:widgets", "nav:calls",
  "nav:demands", "nav:team-chat",
  "demand:view", "demand:create", "demand:edit", "demand:move",
  "demand:comment", "demand:vote", "demand:manage_board",
  "team_chat:view", "team_chat:send", "team_chat:create_room",
  "team_chat:work_item", "team_chat:forward",
];

export const MEMBER_PERMISSIONS: readonly string[] = [
  "pipeline:view",
  "contact:view", "contact:create", "contact:edit",
  "company:view",
  "deal:view", "deal:create", "deal:edit", "deal:change_stage",
  "conversation:view", "conversation:claim", "conversation:transfer",
  "conversation:resolve",
  // Filas da Inbox — Operador: Todas + Entrada + Aguardando + Respondidas.
  // Entrada entra por padrão porque é onde ficam as conversas ainda sem
  // atendimento humano, atribuídas ou não: sem ela o operador não enxerga
  // as próprias conversas recém-distribuídas. O recorte entre "só as
  // minhas" e a fila inteira é o toggle do header da Inbox (`?mine=1`).
  // Automação segue exigindo grant explícito em Settings → Permissões.
  "inbox:tab:todos", "inbox:tab:entrada", "inbox:tab:esperando",
  "inbox:tab:respondidas", "inbox:tab:ligar", "inbox:tab:resolvidos",
  // Agente IA: as conversas com a IA como responsável apareciam em Entrada
  // antes da aba existir — sem esta chave o operador perderia visibilidade.
  "inbox:tab:agente_ia",
  "tag:view",
  "task:view", "task:create", "task:edit",
  "report:view",
  // Inventário / Vagas / Unidades — Operador só VISUALIZA (nada destrutivo).
  "product:view",
  "inventory:view",
  "job_opening:view",
  "org_unit:view",
  "catalog:view",
  "quota:view",
  // Distribution: operador só visualiza (e altera o próprio online/offline,
  // controlado fora do RBAC via ownership na rota de status do agente).
  "distribution:view",
  // Navegação (sidebar principal) — MEMBER NÃO vê automations/distribution/logs
  // (restrição que antes ficava hardcoded em `allowedRoles` no catálogo do front).
  "nav:dashboard", "nav:pipeline", "nav:contacts", "nav:companies",
  "nav:inbox", "nav:activities", "nav:campaigns", "nav:widgets", "nav:calls",
  "nav:demands", "nav:team-chat",
  "demand:view", "demand:create", "demand:edit", "demand:move",
  "demand:comment", "demand:vote",
  "team_chat:view", "team_chat:send", "team_chat:create_room",
  "team_chat:work_item", "team_chat:forward",
];

export const PRESET_PERMISSIONS: Record<UserRole, readonly string[]> = {
  ADMIN: ADMIN_PERMISSIONS,
  MANAGER: MANAGER_PERMISSIONS,
  MEMBER: MEMBER_PERMISSIONS,
} as const;

export const PRESET_LABEL: Record<UserRole, string> = {
  ADMIN: "Administrador",
  MANAGER: "Gestor",
  MEMBER: "Operador",
};

export const PRESET_DESCRIPTION: Record<UserRole, string> = {
  ADMIN: "Acesso total à organização. Não removível.",
  MANAGER: "Pode gerenciar equipe, funis, automações e relatórios.",
  MEMBER: "Atende leads, gerencia próprios negócios e tarefas.",
};
