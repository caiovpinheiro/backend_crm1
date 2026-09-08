/**
 * Catalogo canonico de permissions (Fase 1 — Authz Foundation).
 *
 * Granularidade: por <resource>:<action>. As actions sao verbos curtos
 * e estaveis (view/create/edit/delete + actions de dominio). Adicionar
 * um item aqui automaticamente:
 *   1. Aparece no UI da matriz Role x Permission (/settings/permissions).
 *   2. Pode ser usado em `can()` no codigo.
 *   3. Validado nas mutations de Role (rejeitamos chaves desconhecidas).
 *
 * REGRAS DE OURO:
 *   - Toda nova feature CRIA permissions aqui ANTES de checar via `can()`.
 *   - NAO quebrar chaves existentes (so deprecar). Renomear = adicionar
 *     nova chave + remover apos rollout.
 *   - Wildcards "*" e "<resource>:*" tem semantica especial em `can()` —
 *     nao listar como string aqui.
 *
 * Convencoes de naming:
 *   resource: snake_case singular (ex.: "ai_agent", nao "ai_agents")
 *   action: snake_case verbo (ex.: "view", "claim", "reassign_others")
 */

/**
 * Definicao de um resource. `actions` e a lista das acoes permitidas
 * naquele recurso. `label` e descritivo pra UI; `description` e tooltip.
 */
export interface ResourceDef {
  resource: string;
  label: string;
  description?: string;
  actions: ActionDef[];
}

export interface ActionDef {
  action: string;
  label: string;
  description?: string;
  /** Se true, exige que o admin reflita duas vezes antes de conceder. */
  destructive?: boolean;
}

export const PERMISSION_CATALOG: ResourceDef[] = [
  {
    resource: "pipeline",
    label: "Funis",
    description: "Pipelines de vendas e etapas (kanban, lista).",
    actions: [
      { action: "view", label: "Visualizar funis" },
      { action: "create", label: "Criar funil" },
      { action: "edit", label: "Editar funil" },
      { action: "delete", label: "Excluir funil", destructive: true },
      { action: "manage_stages", label: "Gerenciar etapas (criar/editar/excluir)" },
    ],
  },
  {
    resource: "contact",
    label: "Contatos",
    actions: [
      { action: "view", label: "Visualizar contatos" },
      { action: "create", label: "Criar contato" },
      { action: "edit", label: "Editar contato" },
      { action: "delete", label: "Excluir contato", destructive: true },
      { action: "export", label: "Exportar contatos" },
      { action: "import", label: "Importar contatos" },
      { action: "merge", label: "Mesclar contatos duplicados" },
      { action: "bulk_edit", label: "Editar em lote" },
    ],
  },
  {
    resource: "company",
    label: "Empresas",
    actions: [
      { action: "view", label: "Visualizar empresas" },
      { action: "create", label: "Criar empresa" },
      { action: "edit", label: "Editar empresa" },
      { action: "delete", label: "Excluir empresa", destructive: true },
    ],
  },
  {
    resource: "deal",
    label: "Negócios",
    actions: [
      { action: "view", label: "Visualizar negócios" },
      { action: "create", label: "Criar negócio" },
      { action: "edit", label: "Editar negócio" },
      { action: "delete", label: "Excluir negócio", destructive: true },
      { action: "transfer_owner", label: "Transferir responsável (de outro agente)" },
      { action: "change_stage", label: "Mover entre etapas" },
      { action: "set_won", label: "Marcar como ganho" },
      { action: "set_lost", label: "Marcar como perdido" },
    ],
  },
  {
    resource: "conversation",
    label: "Inbox / Conversas",
    actions: [
      { action: "view", label: "Visualizar conversas" },
      { action: "claim", label: "Assumir conversa livre da fila" },
      { action: "transfer", label: "Transferir conversa (própria ou livre) para agente/departamento" },
      { action: "reassign_others", label: "Reatribuir conversa de outro agente" },
      { action: "resolve", label: "Resolver / reabrir conversa" },
      { action: "delete_messages", label: "Excluir mensagens", destructive: true },
      { action: "send_template", label: "Enviar template WhatsApp" },
      { action: "transfer_channel", label: "Transferir entre canais" },
    ],
  },
  {
    resource: "inbox",
    label: "Filas da Inbox",
    description:
      "Controla quais abas/filas da Inbox o papel enxerga. Entrada (pool livre) também exige conversation:claim. Substitui o legado sharedInbox para operadores (MEMBER).",
    actions: [
      { action: "tab:todos", label: "Todas" },
      { action: "tab:entrada", label: "Entrada (fila livre)" },
      { action: "tab:esperando", label: "Aguardando" },
      { action: "tab:respondidas", label: "Respondidas" },
      { action: "tab:ligar", label: "Ligar (permissão de voz)" },
      { action: "tab:agente_ia", label: "Agente IA" },
      { action: "tab:automacao", label: "Automação" },
      { action: "tab:resolvidos", label: "Resolvido" },
      { action: "tab:finalizados", label: "Encerradas" },
      { action: "tab:erro", label: "Erro" },
    ],
  },
  {
    resource: "automation",
    label: "Automações (Salesbot, fluxos)",
    actions: [
      { action: "view", label: "Visualizar automações" },
      { action: "create", label: "Criar automação" },
      { action: "edit", label: "Editar automação" },
      { action: "publish", label: "Ativar/desativar automação em produção" },
      { action: "delete", label: "Excluir automação", destructive: true },
    ],
  },
  {
    resource: "distribution",
    label: "Distribuição de Leads",
    description: "Módulo Distribuição Inteligente (widget smart_distribution).",
    actions: [
      { action: "view", label: "Visualizar distribuição" },
      { action: "manage", label: "Gerenciar responsáveis e regras de distribuição" },
      { action: "execute", label: "Executar distribuição manualmente" },
    ],
  },
  {
    resource: "ai_agent",
    label: "Agentes de IA",
    actions: [
      { action: "view", label: "Visualizar agentes IA" },
      { action: "create", label: "Criar agente IA" },
      { action: "edit", label: "Editar prompt / ferramentas / conhecimento" },
      { action: "delete", label: "Excluir agente IA", destructive: true },
    ],
  },
  {
    resource: "campaign",
    label: "Campanhas",
    actions: [
      { action: "view", label: "Visualizar campanhas" },
      { action: "create", label: "Criar campanha" },
      { action: "edit", label: "Editar campanha" },
      { action: "send", label: "Disparar campanha" },
      { action: "cancel", label: "Cancelar campanha em execução" },
    ],
  },
  {
    resource: "task",
    label: "Tarefas / Atividades",
    actions: [
      { action: "view", label: "Visualizar tarefas" },
      { action: "create", label: "Criar tarefa" },
      { action: "edit", label: "Editar tarefa" },
      { action: "delete", label: "Excluir tarefa", destructive: true },
      { action: "complete_others", label: "Concluir tarefas de outros agentes" },
    ],
  },
  {
    resource: "report",
    label: "Relatórios",
    actions: [
      { action: "view", label: "Visualizar relatórios" },
      { action: "export", label: "Exportar relatórios" },
    ],
  },
  {
    resource: "tag",
    label: "Tags",
    actions: [
      { action: "view", label: "Visualizar tags" },
      { action: "create", label: "Criar tag" },
      { action: "edit", label: "Editar tag" },
      { action: "delete", label: "Excluir tag", destructive: true },
    ],
  },
  {
    resource: "segment",
    label: "Segmentos",
    actions: [
      { action: "view", label: "Visualizar segmentos" },
      { action: "create", label: "Criar segmento" },
      { action: "edit", label: "Editar segmento" },
      { action: "delete", label: "Excluir segmento", destructive: true },
    ],
  },
  {
    resource: "product",
    label: "Produtos",
    actions: [
      { action: "view", label: "Visualizar produtos" },
      { action: "create", label: "Criar produto" },
      { action: "edit", label: "Editar produto" },
      { action: "delete", label: "Excluir produto", destructive: true },
      { action: "manage_offers", label: "Gerenciar ofertas por unidade" },
      { action: "manage_stakeholders", label: "Gerenciar stakeholders do produto" },
    ],
  },
  {
    resource: "inventory",
    label: "Inventário / Alocação",
    description: "Saldo e movimentos do ledger (estoque, vagas, assentos).",
    actions: [
      { action: "view", label: "Visualizar saldo e extrato" },
      { action: "adjust", label: "Ajustar alocação (movimento manual)", destructive: true },
    ],
  },
  {
    resource: "catalog",
    label: "Catálogos (por capacidades)",
    description:
      "Catálogo Universal por Capacidades (PRD): agrupa produtos e capacidades.",
    actions: [
      { action: "view", label: "Visualizar catálogos" },
      { action: "create", label: "Criar catálogo" },
      { action: "edit_capabilities", label: "Ligar/desligar capacidades e editar config" },
      { action: "delete", label: "Excluir catálogo", destructive: true },
      { action: "save_as_template", label: "Salvar catálogo como template da org" },
    ],
  },
  {
    resource: "job_opening",
    label: "Vagas (recrutamento)",
    actions: [
      { action: "view", label: "Visualizar vagas" },
      { action: "manage", label: "Criar/editar vagas e funis" },
      { action: "close", label: "Fechar vaga", destructive: true },
    ],
  },
  {
    resource: "demand",
    label: "Demandas (roadmap interno)",
    description:
      "Boards de demandas, bugs, melhorias e solicitações do time (dev/suporte).",
    actions: [
      { action: "view", label: "Visualizar boards e cards" },
      { action: "create", label: "Criar demanda" },
      { action: "edit", label: "Editar demanda (título, tipo, prioridade, responsável)" },
      { action: "move", label: "Mover entre fases" },
      { action: "comment", label: "Comentar" },
      { action: "vote", label: "Votar / priorizar" },
      { action: "manage_board", label: "Criar e configurar boards e fases" },
    ],
  },
  {
    resource: "team_chat",
    label: "Chat interno",
    description:
      "Mensagens diretas e grupos entre colegas da organização (substitui o WhatsApp do time).",
    actions: [
      { action: "view", label: "Ver conversas e mensagens" },
      { action: "send", label: "Enviar mensagens" },
      { action: "create_room", label: "Abrir DM ou criar grupo" },
      { action: "work_item", label: "Criar e editar checklists, atas e reuniões" },
      { action: "forward", label: "Encaminhar mensagem com anotação" },
    ],
  },
  {
    resource: "org_unit",
    label: "Unidades (filiais)",
    description: "Filiais/CNPJs do tenant para ofertas e pools por unidade.",
    actions: [
      { action: "view", label: "Visualizar unidades" },
      { action: "manage", label: "Criar/editar unidades" },
    ],
  },
  {
    resource: "channel",
    label: "Canais (WhatsApp, etc.)",
    actions: [
      { action: "view", label: "Visualizar canais" },
      { action: "create", label: "Conectar novo canal" },
      { action: "edit", label: "Editar canal" },
      { action: "delete", label: "Desconectar canal", destructive: true },
    ],
  },
  {
    resource: "template",
    label: "Templates de Mensagem",
    actions: [
      { action: "view", label: "Visualizar templates" },
      { action: "create", label: "Criar template" },
      { action: "edit", label: "Editar template" },
      { action: "delete", label: "Excluir template", destructive: true },
      { action: "submit_meta", label: "Submeter aprovação Meta/WhatsApp" },
    ],
  },
  {
    resource: "settings",
    label: "Configurações",
    description: "Áreas administrativas. Use sparingly.",
    actions: [
      { action: "billing", label: "Faturamento e plano" },
      { action: "team", label: "Equipe (usuários e convites)" },
      { action: "permissions", label: "Permissões e funções" },
      { action: "branding", label: "Identidade visual" },
      { action: "channels", label: "Configurar canais" },
      { action: "webhooks", label: "Webhooks" },
      { action: "api_tokens", label: "Tokens de API" },
      { action: "custom_fields", label: "Campos personalizados" },
      { action: "integrations", label: "Integrações externas (Kommo, etc.)" },
      { action: "lgpd", label: "Privacidade / LGPD" },
      { action: "groups", label: "Grupos e filas (Fase 3)" },
      { action: "security", label: "Segurança / RBAC avançado" },
    ],
  },
  {
    resource: "nav",
    label: "Navegação (sidebar principal)",
    description:
      "Controla quais ícones da sidebar principal cada role enxerga. Espelha o catálogo do frontend em `src/lib/sidebar-catalog.ts` — a `action` aqui é a `key` do item no catálogo. Item sem a permission correspondente fica oculto da sidebar (fail-closed). ADMIN bypass via `*`.",
    actions: [
      { action: "dashboard",    label: "Dashboard" },
      { action: "pipeline",     label: "Pipeline (funil)" },
      { action: "contacts",     label: "Contatos" },
      { action: "companies",    label: "Empresas" },
      { action: "inbox",        label: "Inbox (conversas)" },
      { action: "activities",   label: "Atividades" },
      { action: "automations",  label: "Automações" },
      { action: "campaigns",    label: "Campanhas" },
      { action: "distribution", label: "Distribuição de leads" },
      { action: "logs",         label: "Logs" },
      { action: "widgets",      label: "Widgets" },
      { action: "calls",        label: "Chamadas (histórico)" },
      { action: "demands",      label: "Demandas (roadmap)" },
      { action: "team-chat",    label: "Chat interno" },
    ],
  },
];

/**
 * Cria a versao flat ("resource:action") do catalogo. Usada pra
 * validacao de Role.permissions e pra gerar o tipo PermissionKey.
 */
export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSION_CATALOG.flatMap(
  (r) => r.actions.map((a) => `${r.resource}:${a.action}`),
);

const ALL_PERMISSION_KEYS_SET = new Set(ALL_PERMISSION_KEYS);

/**
 * Type-narrow pra `string` -> `PermissionKey` (string com forma valida).
 * NAO usamos union literal type pq a lista e dinamica e o catalogo cresce
 * com o produto. Em compile-time, `PermissionKey = string` (semantica).
 */
export type PermissionKey = string;

/**
 * Valida se uma chave bate com o catalogo OU eh um wildcard.
 * Wildcards aceitos:
 *   "*"             -> todas as permissions
 *   "<resource>:*"  -> todas as actions de um resource
 */
export function isValidPermissionKey(key: string): boolean {
  if (key === "*") return true;
  if (key.endsWith(":*")) {
    const resource = key.slice(0, -2);
    return PERMISSION_CATALOG.some((r) => r.resource === resource);
  }
  return ALL_PERMISSION_KEYS_SET.has(key);
}

/**
 * Filtra um array de permissions, removendo chaves invalidas. Util ao
 * salvar Role.permissions vinda do client (defesa em profundidade alem
 * da validacao Zod).
 */
export function sanitizePermissions(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!isValidPermissionKey(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * Lookup de label legivel de uma permission key. Usado em UI/audit.
 */
export function describePermission(key: string): string {
  if (key === "*") return "Acesso total";
  if (key.endsWith(":*")) {
    const resource = key.slice(0, -2);
    const r = PERMISSION_CATALOG.find((x) => x.resource === resource);
    return r ? `Tudo em ${r.label}` : key;
  }
  const colon = key.indexOf(":");
  if (colon <= 0) return key;
  const resource = key.slice(0, colon);
  const action = key.slice(colon + 1);
  const r = PERMISSION_CATALOG.find((x) => x.resource === resource);
  if (!r) return key;
  const a = r.actions.find((x) => x.action === action);
  return a ? `${r.label} — ${a.label}` : key;
}
