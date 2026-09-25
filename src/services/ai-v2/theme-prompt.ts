export const QUERY_TOOL_NAMES = ["search_products", "search_crm_records", "knowledge_search", "list_message_models"];

/**
 * Instruções do assunto e as ações que ele libera. As tools de consulta vão
 * na seção de ferramentas: listar tudo como "ferramentas permitidas" levava
 * o modelo a tratar ações (handoff, ask_with_options) como tools.
 */
export function themePromptText(theme: { instructions: string; allowedTools: string[] }): string {
  const actions = theme.allowedTools.filter((t) => !QUERY_TOOL_NAMES.includes(t));
  return actions.length > 0
    ? `${theme.instructions}\nAções que você pode devolver em actions neste assunto: ${actions.join(", ")}.`
    : theme.instructions;
}
