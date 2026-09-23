import type { Prisma } from "@prisma/client";

import type { AuthzContext } from "@/lib/authz";
import { canViewPipeline, canViewStage } from "@/lib/authz";
import { prismaBase } from "@/lib/prisma-base";

export type FunnelScope = {
  denyPipelineIds: string[];
  denyStageIds: string[];
  /** Allow-list legado. `null` = sem allow-list. */
  allowStageIds: string[] | null;
};

/** `null` = o usuário não tem restrição de funil/etapa (ou é admin). */
export function funnelScopeOf(ctx: AuthzContext): FunnelScope | null {
  if (ctx.isSuperAdmin || ctx.isAdmin) return null;
  const denyPipelineIds = [...(ctx.pipelineDeny ?? [])];
  const denyStageIds = [...(ctx.stageDeny ?? [])];
  const allowStageIds = ctx.stageView ? [...ctx.stageView] : null;
  if (denyPipelineIds.length === 0 && denyStageIds.length === 0 && allowStageIds === null) {
    return null;
  }
  return { denyPipelineIds, denyStageIds, allowStageIds };
}

export function funnelDealWhere(ctx: AuthzContext): Prisma.DealWhereInput | null {
  const scope = funnelScopeOf(ctx);
  if (!scope) return null;
  const parts: Prisma.DealWhereInput[] = [];
  if (scope.denyPipelineIds.length > 0) {
    parts.push({ stage: { is: { pipelineId: { notIn: scope.denyPipelineIds } } } });
  }
  if (scope.denyStageIds.length > 0) {
    parts.push({ stageId: { notIn: scope.denyStageIds } });
  }
  if (scope.allowStageIds) {
    parts.push({ stageId: { in: scope.allowStageIds } });
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : { AND: parts };
}

/**
 * Conversa some quando o contato só tem negócios em funil/etapa bloqueados.
 * Contato sem negócio continua visível (não está preso a uma etapa).
 */
export function conversationFunnelWhere(
  ctx: AuthzContext,
): Prisma.ConversationWhereInput | null {
  const dealWhere = funnelDealWhere(ctx);
  if (!dealWhere) return null;
  return {
    OR: [
      { contact: { deals: { none: {} } } },
      { contact: { deals: { some: dealWhere } } },
    ],
  };
}

export function andDealWhere(
  base: Prisma.DealWhereInput | null | undefined,
  extra: Prisma.DealWhereInput | null,
): Prisma.DealWhereInput | undefined {
  if (!extra) return base && Object.keys(base).length > 0 ? base : undefined;
  if (!base || Object.keys(base).length === 0) return extra;
  return { AND: [base, extra] };
}

export function andConversationWhere(
  base: Prisma.ConversationWhereInput | null | undefined,
  extra: Prisma.ConversationWhereInput | null,
): Prisma.ConversationWhereInput | undefined {
  if (!extra) return base && Object.keys(base).length > 0 ? base : undefined;
  if (!base || Object.keys(base).length === 0) return extra;
  return { AND: [base, extra] };
}

/** Ids de etapa pedidos pelo cliente, já sem as bloqueadas. */
export function visibleStageIds(ctx: AuthzContext, ids: string[]): string[] {
  return ids.filter((id) => canViewStage(ctx, id));
}

export async function filterDealIdsByFunnel(
  organizationId: string,
  dealIds: string[],
  ctx: AuthzContext,
): Promise<string[]> {
  const where = funnelDealWhere(ctx);
  if (!where || dealIds.length === 0) return dealIds;
  const rows = await prismaBase.deal.findMany({
    where: { organizationId, id: { in: dealIds }, AND: [where] },
    select: { id: true },
  });
  const ok = new Set(rows.map((r) => r.id));
  return dealIds.filter((id) => ok.has(id));
}

/**
 * true quando a conversa está presa só a negócios de funil/etapa bloqueados.
 * Usa prismaBase: o stream SSE não abre RequestContext.
 */
export async function conversationBlockedByFunnel(
  organizationId: string,
  conversationId: string,
  ctx: AuthzContext,
): Promise<boolean> {
  if (!funnelScopeOf(ctx)) return false;
  const conv = await prismaBase.conversation.findFirst({
    where: { id: conversationId, organizationId },
    select: {
      contact: {
        select: {
          deals: {
            select: { stageId: true, stage: { select: { pipelineId: true } } },
          },
        },
      },
    },
  });
  const deals = conv?.contact?.deals ?? [];
  if (deals.length === 0) return false;
  return !deals.some(
    (d) => canViewStage(ctx, d.stageId) && canViewPipeline(ctx, d.stage.pipelineId),
  );
}
