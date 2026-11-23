/**
 * Escopos OAuth do MCP (somente leitura) e o mapa ferramenta → escopo →
 * permissão RBAC. Uma chamada de ferramenta exige TODOS:
 *   1. o escopo concedido na conexão (consentimento do usuário);
 *   2. o escopo liberado pela organização (`/settings/mcp`);
 *   3. a permissão RBAC atual do usuário (`can()`), mais os filtros de
 *      visibilidade/funil/canal das rotas equivalentes da UI.
 * O MCP nunca amplia o que o usuário já vê no CRM.
 */

export const MCP_SCOPES = [
  "leads:read",
  "conversations:read",
  "messages:read",
  "metrics:read",
  "team:read",
  "campaigns:read",
  // Recursos de 2026-11 — desligados por padrão (`MCP_DEFAULT_ORG_SCOPES`).
  "events:read",
  "queue:read",
  "custom_fields:read",
  "audio:read",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * Escopos que a org libera sem configurar nada. Os recursos novos
 * (eventos, fila, campos personalizados, transcrição de áudio) ficam de fora:
 * o admin liga um a um em /settings/mcp.
 */
export const MCP_DEFAULT_ORG_SCOPES: readonly McpScope[] = [
  "leads:read",
  "conversations:read",
  "messages:read",
  "metrics:read",
  "team:read",
  "campaigns:read",
];

export const MCP_SCOPE_INFO: Record<McpScope, { label: string; description: string }> = {
  "leads:read": {
    label: "Leads e negócios",
    description: "Consultar leads (negócios), detalhes e histórico.",
  },
  "conversations:read": {
    label: "Lista de conversas",
    description: "Consultar conversas da inbox (sem o conteúdo das mensagens).",
  },
  "messages:read": {
    label: "Mensagens das conversas",
    description: "Ler o conteúdo das mensagens das conversas que o usuário pode acessar.",
  },
  "metrics:read": {
    label: "Resultados e funil",
    description: "Vendas, conversões e métricas do funil comercial.",
  },
  "team:read": {
    label: "Desempenho da equipe",
    description: "Resultados por vendedor (gestores e administradores).",
  },
  "campaigns:read": {
    label: "Campanhas",
    description: "Campanhas e seus indicadores de envio, leitura e resposta.",
  },
  "events:read": {
    label: "Linha do tempo das conversas",
    description: "Atribuições, transferências, filas, IA/humano e encerramentos (com tabulação e quem encerrou).",
  },
  "queue:read": {
    label: "Situação das filas",
    description: "Por departamento: quantos esperam, espera mais antiga e atendentes online (sem dado pessoal).",
  },
  "custom_fields:read": {
    label: "Campos personalizados",
    description: "Só os campos que a organização liberar na lista desta tela.",
  },
  "audio:read": {
    label: "Transcrição de áudios",
    description: "Texto transcrito dos áudios das conversas, quando existir.",
  },
};

export type McpToolName =
  | "list_leads"
  | "get_lead"
  | "list_conversations"
  | "get_conversation_messages"
  | "get_sales_metrics"
  | "get_team_performance"
  | "get_campaign_results"
  | "get_pipeline_metrics"
  | "get_conversation_events"
  | "get_queue_status";

export const MCP_TOOL_REQUIREMENTS: Record<
  McpToolName,
  { scope: McpScope; permissions: string[] }
> = {
  list_leads: { scope: "leads:read", permissions: ["deal:view"] },
  get_lead: { scope: "leads:read", permissions: ["deal:view"] },
  list_conversations: { scope: "conversations:read", permissions: ["conversation:view"] },
  get_conversation_messages: { scope: "messages:read", permissions: ["conversation:view"] },
  get_sales_metrics: { scope: "metrics:read", permissions: ["report:view"] },
  get_team_performance: { scope: "team:read", permissions: ["report:view"] },
  get_campaign_results: { scope: "campaigns:read", permissions: ["campaign:view"] },
  get_pipeline_metrics: { scope: "metrics:read", permissions: ["report:view", "pipeline:view"] },
  get_conversation_events: { scope: "events:read", permissions: ["conversation:view"] },
  get_queue_status: { scope: "queue:read", permissions: ["conversation:view", "report:view"] },
};

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

/** Parse de `scope` (RFC 6749: separado por espaço). Ignora desconhecidos. */
export function parseScopeParam(raw: string | null | undefined): McpScope[] {
  if (!raw) return [];
  const out = new Set<McpScope>();
  for (const part of raw.split(/\s+/)) {
    if (isMcpScope(part)) out.add(part);
  }
  return [...out];
}

export function sanitizeScopes(values: unknown): McpScope[] {
  if (!Array.isArray(values)) return [];
  const out = new Set<McpScope>();
  for (const v of values) if (typeof v === "string" && isMcpScope(v)) out.add(v);
  return MCP_SCOPES.filter((s) => out.has(s));
}

export function intersectScopes(a: readonly string[], b: readonly string[]): McpScope[] {
  const setB = new Set(b);
  return MCP_SCOPES.filter((s) => a.includes(s) && setB.has(s));
}

/**
 * Operador no MCP: quem não é admin (kill switch do authz ou papel legado)
 * nem gestor. Só vê os negócios em que é o responsável e as conversas dele.
 */
export function isMcpOwnScopeOnly(args: { role: string; isAdmin: boolean }): boolean {
  if (args.isAdmin) return false;
  return args.role !== "ADMIN" && args.role !== "MANAGER";
}
