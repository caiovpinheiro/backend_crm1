/**
 * Gate do `card` do SSE por usuário.
 *
 * O fan-out do bus é por organização (`sse-bus.ts`), então todo agente
 * recebia o `card` (contato, prévia, responsável) de TODA conversa da org.
 * O inbox usa esse snapshot para inserir o ticket na lista sem GET, e o
 * card de uma conversa de outro agente aparecia na lista de quem não podia
 * abri-la — clique = 404 de `requireConversationAccess`.
 *
 * Aqui montamos, UMA vez por conexão SSE, um predicado em memória sobre os
 * campos do card. Sem o card o cliente cai no caminho autoritativo
 * (`GET /api/conversations?ids=`), que já aplica a visibilidade completa.
 * Por isso o predicado é fail-closed: na dúvida, tira o card.
 *
 * Espelha `getVisibilityFilter` + `withInboxQueueVisibility`. O que NÃO dá
 * para avaliar em memória (pool compartilhado que depende dos deals do
 * contato) cai no fail-closed.
 */

import type { AppUserRole } from "@/lib/auth-types";
import { loadAuthzContext } from "@/lib/authz";
import { metrics } from "@/lib/metrics";
import { redactNewMessageForUnlisted } from "@/lib/sse-redact";
import {
  getDepartmentScopeForConversations,
  getVisibilityFilter,
  permissionsAllowKey,
} from "@/lib/visibility";

type SseCardShape = {
  assignedToId?: string | null;
  departmentId?: string | null;
  assignedTo?: { type?: string | null } | null;
};

export type InboxSseCardGate = (card: SseCardShape) => boolean;

/** Comportamento anterior — usado como fallback quando o gate falha. */
export const allowAllInboxSseCards: InboxSseCardGate = () => true;

export async function buildInboxSseCardGate(user: {
  id: string;
  role: AppUserRole;
  organizationId: string;
  isSuperAdmin: boolean;
}): Promise<InboxSseCardGate> {
  if (user.isSuperAdmin) return allowAllInboxSseCards;

  const [visibility, deptScope, authz] = await Promise.all([
    getVisibilityFilter({ id: user.id, role: user.role }),
    getDepartmentScopeForConversations({ id: user.id, role: user.role }),
    loadAuthzContext({
      userId: user.id,
      organizationId: user.organizationId,
      isSuperAdmin: false,
    }),
  ]);

  const perms: ReadonlySet<string> = authz.isAdmin
    ? new Set(["*"])
    : authz.permissions;
  const canSeeEntrada =
    permissionsAllowKey(perms, "inbox:tab:entrada") &&
    permissionsAllowKey(perms, "conversation:claim");
  const canSeeAutomacao = permissionsAllowKey(perms, "inbox:tab:automacao");
  // Fallback igual ao de `withInboxQueueVisibility`: roles gravadas antes da
  // aba existir não têm a chave nova mas já viam a fila do Agente IA.
  const canSeeAiQueue =
    permissionsAllowKey(perms, "inbox:tab:agente_ia") ||
    permissionsAllowKey(perms, "inbox:tab:entrada") ||
    permissionsAllowKey(perms, "inbox:tab:automacao");

  return (card) => {
    const assignedToId = card.assignedToId ?? null;
    // Conversa atribuída ao próprio agente é sempre visível — inclusive
    // fora do departamento dele (mesma regra do `where` do servidor).
    if (assignedToId && assignedToId === user.id) return true;

    if (deptScope && !(card.departmentId && deptScope.includes(card.departmentId))) {
      return false;
    }

    if (String(card.assignedTo?.type ?? "").toUpperCase() === "AI") {
      return visibility.canSeeAll || canSeeAiQueue;
    }

    if (assignedToId == null) {
      return (
        visibility.includeUnassigned &&
        (visibility.canSeeAll || canSeeEntrada || canSeeAutomacao)
      );
    }

    // Atribuída a outro humano: só quem enxerga além das próprias.
    return visibility.canSeeAll;
  };
}

/**
 * Devolve `data` sem o `card` quando o gate recusa, marcado com
 * `cardOmitted: "hidden"`: o cliente não alerta (nem busca o card) — o
 * usuário não pode listar a conversa. Em `new_message` também sai o
 * conteúdo (`redactNewMessageForUnlisted`). `"budget"` vem do bus.
 */
export function stripHiddenInboxSseCard(
  data: unknown,
  gate: InboxSseCardGate,
  event?: string,
): unknown {
  if (!data || typeof data !== "object") return data;
  const rec = data as Record<string, unknown>;
  const card = rec.card;
  if (!card || typeof card !== "object") return data;
  if (gate(card as SseCardShape)) return data;
  const { card: _hidden, ...rest } = rec;
  if (rest.direction === "in") {
    metrics.sse.inboundWithoutCard.inc({ reason: "hidden" });
  }
  const hidden = { ...rest, cardOmitted: "hidden" };
  return event === "new_message" ? redactNewMessageForUnlisted(hidden) : hidden;
}
