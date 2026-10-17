/**
 * "Tem alguém para atender agora?" do widget (`GET /config` → `online`).
 *
 * online = dentro do horário comercial (sem horário = sempre) **e** existe
 * ao menos um humano da org com presença fresca no CRM (sessão aberta em
 * `system_usage_sessions` com heartbeat dentro de `SYSTEM_PRESENCE_STALE_MS`,
 * o mesmo critério do painel de presença). Agentes de IA não batem ping,
 * então não contam.
 *
 * Simplificação (v1): não filtra por permissão de canal (`scope-grants`) —
 * qualquer humano online da org conta. Cache de 30 s por org.
 */
import { cache } from "@/lib/cache";
import { getLogger } from "@/lib/logger";
// prismaBase: chamada pública; a org vem do canal (sem RequestContext).
import { prismaBase } from "@/lib/prisma-base";
import { isWithinBusinessHours, type WebchatChannelConfig } from "@/lib/webchat/config";
import { SYSTEM_PRESENCE_STALE_MS } from "@/services/system-presence";

const log = getLogger("webchat-online");
const AGENTS_ONLINE_TTL_SEC = 30;

export async function anyAgentOnline(organizationId: string): Promise<boolean> {
  const key = `webchat:agents_online:${organizationId}`;
  try {
    const cached = await cache.get<boolean>(key);
    if (typeof cached === "boolean") return cached;
  } catch {
    /* sem cache: consulta */
  }
  let online = false;
  try {
    const row = await prismaBase.systemUsageSession.findFirst({
      where: {
        organizationId,
        endedAt: null,
        lastHeartbeatAt: { gte: new Date(Date.now() - SYSTEM_PRESENCE_STALE_MS) },
      },
      select: { userId: true },
    });
    online = Boolean(row);
  } catch (err) {
    log.warn({ err, organizationId }, "presença indisponível — webchat responde offline");
    return false;
  }
  await cache.set(key, online, AGENTS_ONLINE_TTL_SEC).catch(() => {});
  return online;
}

export async function isWebchatOnline(
  organizationId: string,
  config: WebchatChannelConfig,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isWithinBusinessHours(config.businessHours, now)) return false;
  return anyAgentOnline(organizationId);
}
