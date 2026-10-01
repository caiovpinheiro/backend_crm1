/**
 * Regras de entrega SSE (testáveis sem Redis/DB).
 *
 * Atendimento (`new_message`, etc.): fan-out por organização.
 * Super-admin continua vendo eventos de atendimento (privilégio de plataforma).
 *
 * Team-chat privado (`team_chat_*`): audiência = participação efetiva na sala,
 * resolvida no publisher. `isSuperAdmin` NÃO bypassa membership.
 * Sem `audienceUserIds` → fail-closed (ninguém recebe).
 *
 * NÃO usar `data.memberIds` do payload como autorização — isso é contrato FE.
 */

export const SSE_ACCESS_REVOKED = "sse_access_revoked";

export type SseListenerCtx = {
  organizationId: string | null;
  userId: string | null;
  isSuperAdmin: boolean;
};

export type SseDeliveryEnvelope = {
  organizationId: string | null;
  audienceUserIds?: string[];
};

export function isPrivateTeamChatEvent(event: string): boolean {
  return event.startsWith("team_chat_");
}

export function teamChatAudience(
  memberUserIds: string[],
  extraUserIds?: string[],
): string[] {
  return [...new Set([...memberUserIds, ...(extraUserIds ?? [])])];
}

export function shouldDeliverSseEvent(
  listener: SseListenerCtx,
  event: string,
  envelope: SseDeliveryEnvelope,
): boolean {
  if (event === SSE_ACCESS_REVOKED) {
    if (!listener.userId) return false;
    return Boolean(envelope.audienceUserIds?.includes(listener.userId));
  }

  if (isPrivateTeamChatEvent(event)) {
    const audience = envelope.audienceUserIds;
    if (!audience || audience.length === 0) return false;
    if (!listener.userId) return false;
    return audience.includes(listener.userId);
  }

  if (listener.isSuperAdmin) return true;
  if (!listener.organizationId || !envelope.organizationId) return false;
  return listener.organizationId === envelope.organizationId;
}

export type SseRedisWire = {
  event: string;
  organizationId: string | null;
  data: unknown;
  audienceUserIds?: string[];
};

export function serializeSseRedisBody(wire: SseRedisWire): string {
  return JSON.stringify(wire);
}

export function parseSseRedisMessage(raw: string): SseRedisWire | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.event !== "string") return null;
    const audience = parsed.audienceUserIds;
    return {
      event: parsed.event,
      organizationId:
        typeof parsed.organizationId === "string" ? parsed.organizationId : null,
      data: parsed.data,
      audienceUserIds: Array.isArray(audience)
        ? audience.filter((id): id is string => typeof id === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}
