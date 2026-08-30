/**
 * Bloco Agora do Painel de Atendimentos. Ignora o seletor de período.
 */

import { analyticsClient } from "@/lib/analytics";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { loadPainelHours, loadPainelSlaMinutes } from "@/services/painel-hours";
import {
  waitMs,
  type ClockMode,
} from "@/services/painel-period";

export type PainelAgora = {
  asOf: string;
  awaitingReply: number;
  inService: number;
  longestWait: {
    ms: number;
    contactName: string | null;
    agentName: string | null;
    conversationId: string | null;
    overSla: boolean;
    slaMinutes: number;
  };
  agents: { online: number; total: number };
};

export async function getPainelAgora(
  clock: ClockMode = "business",
): Promise<PainelAgora> {
  const orgId = getOrgIdOrThrow();
  const now = new Date();

  const slaMinutes = await loadPainelSlaMinutes();
  const bh = await loadPainelHours();

  const [
    awaitingReply,
    inService,
    longest,
    agentsOnline,
    agentsTotal,
  ] = await Promise.all([
    analyticsClient().conversation.count({
      where: {
        status: { not: "RESOLVED" },
        closedAt: null,
        lastMessageDirection: "in",
        hasError: false,
      },
    }),
    analyticsClient().conversation.count({
      where: {
        status: { not: "RESOLVED" },
        closedAt: null,
        assignedToId: { not: null },
        lastMessageDirection: "out",
        hasError: false,
      },
    }),
    analyticsClient().conversation.findFirst({
      where: {
        status: { not: "RESOLVED" },
        closedAt: null,
        lastMessageDirection: "in",
        lastInboundAt: { not: null },
        hasError: false,
      },
      orderBy: { lastInboundAt: "asc" },
      select: {
        id: true,
        lastInboundAt: true,
        contact: { select: { name: true } },
        assignedTo: { select: { name: true } },
      },
    }),
    analyticsClient().agentStatus.count({
      where: {
        status: "ONLINE",
        user: { type: "HUMAN", organizationId: orgId },
      },
    }),
    analyticsClient().user.count({
      where: { organizationId: orgId, type: "HUMAN", isSuperAdmin: false },
    }),
  ]);

  let longestWait: PainelAgora["longestWait"] = {
    ms: 0,
    contactName: null,
    agentName: null,
    conversationId: null,
    overSla: false,
    slaMinutes,
  };
  if (longest?.lastInboundAt) {
    const ms = waitMs(longest.lastInboundAt, now, clock, bh);
    longestWait = {
      ms,
      contactName: longest.contact.name,
      agentName: longest.assignedTo?.name ?? null,
      conversationId: longest.id,
      overSla: ms > slaMinutes * 60_000,
      slaMinutes,
    };
  }

  return {
    asOf: now.toISOString(),
    awaitingReply,
    inService,
    longestWait,
    agents: { online: agentsOnline, total: agentsTotal },
  };
}
