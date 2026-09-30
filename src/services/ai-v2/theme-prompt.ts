export const QUERY_TOOL_NAMES = ["search_products", "search_crm_records", "knowledge_search", "list_message_models"];

/**
 * Instruções do assunto. As ações liberadas vão na seção "Ações que você
 * pode fazer", com o formato de cada uma; as consultas, na de ferramentas.
 */
export function themePromptText(theme: { instructions: string; allowedTools: string[] }): string {
  return theme.instructions;
}
