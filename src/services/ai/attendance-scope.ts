/**
 * Escopo de atendimento do agente: em QUAIS conversas ele pode entrar.
 *
 * O consultor define na tela (funil, etapa, tags do contato) e este
 * módulo decide antes de qualquer intercepto ou chamada ao LLM. Com o
 * escopo vazio nada muda — o agente atende tudo, como sempre.
 */
import { prisma } from "@/lib/prisma";
import {
  isUnrestrictedScope,
  listAllows,
  listBlocks,
  type AttendanceScope,
  type InboxPolicy,
} from "@/lib/ai-agents/steering";

export type ScopeVerdict =
  | { inScope: true }
  | { inScope: false; reason: string; scope: AttendanceScope };

/**
 * Avalia o escopo contra o deal aberto do contato e as tags dele.
 *
 * Ordem: bloqueio vence permissão. Sem deal aberto, restrição de
 * funil/etapa só é aplicada se `attendWithoutDeal` estiver desligado.
 */
export async function evaluateAttendanceScope(args: {
  contactId: string;
  policy: InboxPolicy;
}): Promise<ScopeVerdict> {
  const scope = args.policy.scope;
  if (isUnrestrictedScope(scope)) return { inScope: true };

  const restrictsDeal =
    scope.allowedPipelineIds.length > 0 ||
    scope.blockedPipelineIds.length > 0 ||
    scope.allowedStageIds.length > 0 ||
    scope.blockedStageIds.length > 0;

  const needsTags =
    scope.allowedContactTags.length > 0 || scope.blockedContactTags.length > 0;

  if (needsTags) {
    const tagRows = await prisma.tagOnContact.findMany({
      where: { contactId: args.contactId },
      select: { tag: { select: { name: true } } },
    });
    const tags = tagRows
      .map((t) => t.tag?.name?.trim())
      .filter((n): n is string => Boolean(n));

    const blocked = tags.find((t) => listBlocks(scope.blockedContactTags, t));
    if (blocked) {
      return {
        inScope: false,
        reason: `tag_blocked:${blocked}`,
        scope,
      };
    }
    if (
      scope.allowedContactTags.length > 0 &&
      !tags.some((t) => listAllows(scope.allowedContactTags, t))
    ) {
      return { inScope: false, reason: "tag_not_allowed", scope };
    }
  }

  if (restrictsDeal) {
    const deal = await prisma.deal.findFirst({
      where: { contactId: args.contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: {
        stageId: true,
        stage: { select: { pipelineId: true } },
      },
    });

    if (!deal) {
      return scope.attendWithoutDeal
        ? { inScope: true }
        : { inScope: false, reason: "no_open_deal", scope };
    }

    const pipelineId = deal.stage?.pipelineId ?? null;
    if (pipelineId && scope.blockedPipelineIds.includes(pipelineId)) {
      return { inScope: false, reason: "pipeline_blocked", scope };
    }
    if (
      scope.allowedPipelineIds.length > 0 &&
      (!pipelineId || !scope.allowedPipelineIds.includes(pipelineId))
    ) {
      return { inScope: false, reason: "pipeline_not_allowed", scope };
    }
    if (scope.blockedStageIds.includes(deal.stageId)) {
      return { inScope: false, reason: "stage_blocked", scope };
    }
    if (
      scope.allowedStageIds.length > 0 &&
      !scope.allowedStageIds.includes(deal.stageId)
    ) {
      return { inScope: false, reason: "stage_not_allowed", scope };
    }
  }

  return { inScope: true };
}
