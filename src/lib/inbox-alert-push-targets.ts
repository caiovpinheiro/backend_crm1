/**
 * Quem recebe o Web Push/FCM de uma mensagem recebida: a coluna "Windows"
 * (`native`) da config de alertas do inbox (`inbox-alert-config.ts`),
 * com o mesmo público do alerta in-page.
 *
 * - `mine`: responsável da conversa (sempre pode vê-la).
 * - `queue` / `others`: além da config, passa pelo mesmo gate de
 *   visibilidade do card do SSE — ninguém recebe push de conversa que não
 *   pode listar.
 *
 * Substitui o alvo antigo (responsável, dono do contato e, sem dono, até
 * 10 admins/gerentes).
 */

import {
  resolveInboxAlertConfig,
  type InboxAlertKind,
  type OrgInboxAlertConfigs,
} from "@/lib/inbox-alert-config";

export type PushConversation = {
  assignedToId: string | null;
  assignedToType: string | null;
  departmentId: string | null;
};

export function inboxAlertKindFor(
  conversation: PushConversation,
  userId: string,
  memberDepartmentIds: readonly string[],
): InboxAlertKind {
  if (conversation.assignedToId && conversation.assignedToId === userId) return "mine";
  const isAi = String(conversation.assignedToType ?? "").toUpperCase() === "AI";
  if (
    !isAi &&
    !conversation.assignedToId &&
    conversation.departmentId &&
    memberDepartmentIds.includes(conversation.departmentId)
  ) {
    return "queue";
  }
  return "others";
}

/**
 * Candidatos pela config (sem visibilidade). `needsVisibility` marca quem
 * ainda passa pelo gate (tudo menos `mine`).
 */
export function inboxPushCandidates(input: {
  conversation: PushConversation;
  userIds: readonly string[];
  departmentsByUser: ReadonlyMap<string, readonly string[]>;
  configs: OrgInboxAlertConfigs;
}): { userId: string; needsVisibility: boolean }[] {
  const out: { userId: string; needsVisibility: boolean }[] = [];
  for (const userId of input.userIds) {
    const depts = input.departmentsByUser.get(userId) ?? [];
    const kind = inboxAlertKindFor(input.conversation, userId, depts);
    const cfg = resolveInboxAlertConfig(input.configs, userId, depts);
    if (!cfg[kind].native) continue;
    out.push({ userId, needsVisibility: kind !== "mine" });
  }
  return out;
}
