import type { AgentOnlineStatus } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrNull } from "@/lib/request-context";
import { withSystemContext } from "@/lib/webhook-context";
import { getLogger } from "@/lib/logger";

const logger = getLogger("agent-presence");

/**
 * Registra uma transição de presença no histórico `agent_presence_logs`.
 *
 * Regra:
 *   1. Fecha qualquer bloco em aberto do agente (`endedAt IS NULL`) com `endedAt = now()`.
 *   2. Abre um novo bloco com o `status` alvo, `startedAt = now()`.
 *
 * Se `nextStatus` for igual ao status do bloco atualmente em aberto, **não** cria um
 * novo bloco (mantém o mesmo). Isso garante que pings/heartbeats consecutivos em
 * ONLINE não inflacionem o histórico.
 *
 * Idempotente: chamar duas vezes seguidas com o mesmo `nextStatus` não duplica linhas.
 *
 * Multi-tenancy: chamada por dois caminhos:
 *   1. Rota de ping (`/api/agents/me/ping`) — dentro de RequestContext do user.
 *   2. Presence reaper (setInterval global) — SEM RequestContext.
 *
 * Para funcionar nos dois casos, descobrimos o `organizationId` do user via
 * `prismaBase` (cross-tenant) e embrulhamos em `withSystemContext` quando
 * estamos fora de ctx. Se ja houver ctx (caso 1), reaproveitamos.
 */
export async function recordPresenceTransition(params: {
  userId: string;
  nextStatus: AgentOnlineStatus;
  at?: Date;
}): Promise<void> {
  const { userId, nextStatus } = params;
  const at = params.at ?? new Date();

  try {
    const ctxOrg = getOrgIdOrNull();
    let orgId = ctxOrg;
    if (!orgId) {
      // Reaper / boot: descobre o orgId do user (cross-tenant via prismaBase)
      // e embrulha o resto em withSystemContext pra prisma scoped funcionar.
      const u = await prismaBase.user.findUnique({
        where: { id: userId },
        select: { organizationId: true },
      });
      orgId = u?.organizationId ?? null;
      if (!orgId) {
        // User sem org (super-admin EduIT) nao tem presenca por org. Skip.
        return;
      }
    }

    const run = async () => {
      // Usamos prismaBase aqui porque fizemos o ctx-aware lookup acima e
      // a transacao precisa rodar com orgId garantido — withSystemContext
      // ja seta o ctx, mas pra reduzir overhead da extension, prismaBase
      // + organizationId explicito e mais previsivel.
      const open = await prismaBase.agentPresenceLog.findFirst({
        where: { userId, organizationId: orgId, endedAt: null },
        orderBy: { startedAt: "desc" },
      });

      if (open && open.status === nextStatus) {
        return;
      }

      await prismaBase.$transaction(async (tx) => {
        if (open) {
          await tx.agentPresenceLog.update({
            where: { id: open.id },
            data: { endedAt: at },
          });
        }
        await tx.agentPresenceLog.create({
          data: {
            userId,
            organizationId: orgId,
            status: nextStatus,
            startedAt: at,
          },
        });
      });
    };

    if (ctxOrg) {
      await run();
    } else {
      await withSystemContext(orgId, run);
    }
  } catch (err) {
    // Migration ainda não aplicada em produção: registrar warning e seguir.
    // Não queremos que falha aqui bloqueie ping/status PUT.
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "[recordPresenceTransition] falhou (provável migration pendente)",
    );
  }
}

/**
 * Soma a duração (em milissegundos) em que cada agente esteve em cada status
 * dentro do intervalo `[from, to]`. Blocos abertos (endedAt NULL) são considerados
 * com fim em `min(to, now())`.
 *
 * Retorno: Map<userId, { online: number; away: number; offline: number }>.
 *
 * Multi-tenancy: usa `prismaBase` + `organizationId` explicito porque pode
 * ser chamado de relatorios super-admin (cross-org). O caller passa orgId
 * via `userIds` ja filtrados ou explicitamente.
 */
export async function computeActiveTimeByUser(params: {
  from: Date;
  to: Date;
  userIds?: string[];
  organizationId?: string;
}): Promise<Map<string, { online: number; away: number; offline: number }>> {
  const { from, to, userIds, organizationId } = params;
  const now = new Date();
  const effectiveTo = to > now ? now : to;

  const result = new Map<
    string,
    { online: number; away: number; offline: number }
  >();

  try {
    // Quando organizationId explicito vem, usamos prismaBase pra cross-org.
    // Quando nao vem, caimos no prisma scoped via getOrgIdOrNull do ctx.
    const orgId = organizationId ?? getOrgIdOrNull();
    if (!orgId) {
      // Super-admin sem org especifica: precisa passar `organizationId` no
      // params; nao queremos vazar dados global.
      return result;
    }

    const logs = await prismaBase.agentPresenceLog.findMany({
      where: {
        organizationId: orgId,
        ...(userIds && userIds.length > 0 ? { userId: { in: userIds } } : {}),
        OR: [{ endedAt: null }, { endedAt: { gte: from } }],
        startedAt: { lte: effectiveTo },
      },
      select: { userId: true, status: true, startedAt: true, endedAt: true },
    });

    for (const log of logs) {
      const start = log.startedAt > from ? log.startedAt : from;
      const end = log.endedAt && log.endedAt < effectiveTo ? log.endedAt : effectiveTo;
      const ms = Math.max(0, end.getTime() - start.getTime());
      if (ms === 0) continue;

      const agg = result.get(log.userId) ?? { online: 0, away: 0, offline: 0 };
      if (log.status === "ONLINE") agg.online += ms;
      else if (log.status === "AWAY") agg.away += ms;
      else agg.offline += ms;
      result.set(log.userId, agg);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "[computeActiveTimeByUser] falhou (provável migration pendente)",
    );
  }

  return result;
}
