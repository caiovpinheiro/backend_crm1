/**
 * Where de AgentPermission: a tabela TEM organizationId (não é global).
 * userId é unique global, mas a consulta nunca deve omitir a org do
 * usuário já autenticado/validado — defesa em profundidade contra raw SQL.
 */
export function agentPermissionWhere(
  userId: string,
  organizationId: string | null | undefined,
): { userId: string; organizationId: string } {
  return {
    userId,
    organizationId: organizationId ?? "__none__",
  };
}
