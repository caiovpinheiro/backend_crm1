
/**
 * Marca como RESOLVED as pendências cuja conversa NÃO precisa mais ser
 * distribuída. Continua ativa quando:
 *
 *   - OPEN sem responsável (`ABERTA_SEM_RESPONSAVEL` / assignedToId null), OU
 *   - OPEN ainda com **IA** (handoff noturno: `NO_ELIGIBLE_RESPONSIBLE` →
 *     enfileira + IA reassumiu para continuar falando; a fila deve drenar
 *     quando um humano ficar elegível — ver `pendingOwnedByAi` abaixo).
 *
 * Resolve (cleanup) quando:
 *
 *   - Conversa encerrada (status != OPEN)
 *   - Conversa OPEN já com **humano** (distribuída por outro caminho)
 *   - Conversa deletada
 *
 * Bug histórico (ago/2026): tratar qualquer assignee ≠ null como órfã
 * cancelava a fila no mesmo segundo em que a IA reassumia → centenas de
 * alunos ficavam na aba Automação “para sempre” após expediente.
 *
 * `resolvedUserId=null` marca que foi cleanup, não distribuição real.
 */
async function cancelStalePendingOrphans(orgId: string): Promise<number> {
  const stale = await prisma.distributionPending.findMany({
    where: {
      organizationId: orgId,
      status: "PENDING",
      conversationId: { not: null },
    },
    select: { id: true, conversationId: true, triggerSource: true },
  });
  if (stale.length === 0) return 0;

  const convIds = stale
    .map((p) => p.conversationId)
    .filter((id): id is string => Boolean(id));

  const stillActive = await prisma.conversation.findMany({
    where: {
      id: { in: convIds },
      ...activeInboxQueueGuardWhere(),
      OR: [
        { assignedToId: null },
        // Handoff fora do expediente: IA segura o chat até haver elegível.
        { assignedTo: { type: "AI" } },
      ],
    },
    select: { id: true },
  });
  const activeSet = new Set(stillActive.map((c) => c.id));

  const toResolve = stale
    .filter((p) => {
      if (!p.conversationId || !activeSet.has(p.conversationId)) return true;
      return false;
    })
    .map((p) => p.id);
  if (toResolve.length === 0) return 0;

  const res = await prisma.distributionPending.updateMany({
    where: { id: { in: toResolve } },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });
  return res.count;
}

/**
 * Remove da fila de espera (lista + DistributionPending) conversas OPEN sem
 * responsável em que o aluno nunca respondeu — tipicamente calouros que só
 * receberam template de bem-vindo. Chamada no GET da fila para limpar o
 * dashboard imediatamente, sem depender do cron de drenagem.
 */
export async function purgeUnansweredFromPendingQueue(): Promise<number> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return 0;

  const unanswered = await prisma.conversation.findMany({
    where: {
      ...activeInboxQueueGuardWhere(),
      assignedToId: null,
      lastInboundAt: null,
    },
    select: { id: true, contactId: true },
    take: 2000,
  });
  if (unanswered.length === 0) return 0;

  const convIds = unanswered.map((c) => c.id);
  const contactIds = unanswered
    .map((c) => c.contactId)
    .filter((id): id is string => Boolean(id));

  // Não purga redistribuição MANUAL — operador mandou p/ fila de propósito.
  const res = await prisma.distributionPending.updateMany({
    where: {
      organizationId: orgId,
      status: "PENDING",
      NOT: { triggerSource: "MANUAL" },
      OR: [
        { conversationId: { in: convIds } },
        ...(contactIds.length > 0
          ? [{ contactId: { in: contactIds }, conversationId: null }]
          : []),
      ],
    },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });

  if (res.count > 0) {
    debugInfo(
      "[distribution] purgeUnansweredFromPendingQueue",
      () => JSON.stringify({ orgId, conversations: unanswered.length, resolved: res.count }),
    );
  }
  return res.count;
}
