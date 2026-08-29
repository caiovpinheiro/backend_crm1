/**
 * Redistribui a fila de um consultor (conversas OPEN aguardando resposta)
 * para outros responsáveis — igualmente entre online/elegíveis ou para
 * destinatários escolhidos (round-robin).
 */

import type { Prisma } from "@prisma/client";

import {
  countableReplyWhere,
  countAgentReplyAsAnswered,
  noCountableReplyWhere,
} from "@/lib/conversation-reply-marking";
import { withActiveInboxQueueGuard } from "@/lib/inbox-queue-membership";
import { prisma } from "@/lib/prisma";
import { assignConversationAssignedTo } from "@/services/conversations";
import { scheduleProcessPendingDistributionQueue } from "./pending";
import { getDistributionResponsibles } from "./responsibles";

export type RedistributeQueueScope = "all" | "entrada" | "aguardando";
/** equal = online; specific = escolhidos; to_pending = Fila de espera (sem responsável). */
export type RedistributeMode = "equal" | "specific" | "to_pending";

export type RedistributeInput = {
  sourceUserId: string;
  mode: RedistributeMode;
  /** Obrigatório quando mode=specific. */
  recipientUserIds?: string[];
  /** Qual fatia da fila redistribuir. Default: all. */
  queueScope?: RedistributeQueueScope;
  actor: {
    id: string;
    role: "ADMIN" | "MANAGER" | "MEMBER";
  };
};

export type RedistributeResult = {
  moved: number;
  skipped: number;
  total: number;
  recipients: { userId: string; name: string | null; received: number }[];
};

async function queueWhere(
  sourceUserId: string,
  scope: RedistributeQueueScope,
): Promise<Prisma.ConversationWhereInput> {
  const countAgent = await countAgentReplyAsAnswered();
  const assigned = { assignedToId: sourceUserId, hasError: false };
  if (scope === "entrada") {
    return withActiveInboxQueueGuard({
      ...assigned,
      ...noCountableReplyWhere(countAgent),
    });
  }
  if (scope === "aguardando") {
    return withActiveInboxQueueGuard({
      ...assigned,
      AND: [countableReplyWhere(countAgent)],
      lastMessageDirection: "in",
    });
  }
  return withActiveInboxQueueGuard({
    ...assigned,
    OR: [
      noCountableReplyWhere(countAgent),
      {
        AND: [countableReplyWhere(countAgent), { lastMessageDirection: "in" }],
      },
    ],
  });
}

export async function redistributeResponsibleQueue(
  input: RedistributeInput,
): Promise<RedistributeResult> {
  const scope = input.queueScope ?? "all";
  const source = await prisma.user.findUnique({
    where: { id: input.sourceUserId },
    select: { id: true, name: true },
  });
  if (!source) {
    throw Object.assign(new Error("Responsável de origem não encontrado."), {
      code: "SOURCE_NOT_FOUND",
      status: 404,
    });
  }

  const conversations = await prisma.conversation.findMany({
    where: await queueWhere(input.sourceUserId, scope),
    select: { id: true },
    orderBy: { updatedAt: "asc" },
  });

  if (conversations.length === 0) {
    return { moved: 0, skipped: 0, total: 0, recipients: [] };
  }

  // Sem responsável → entra na Fila de espera; processPending drena quando
  // houver elegível (online / capacidade / cron / botão).
  if (input.mode === "to_pending") {
    let moved = 0;
    let skipped = 0;
    for (const conv of conversations) {
      const result = await assignConversationAssignedTo(conv.id, null, {
        id: input.actor.id,
        role: input.actor.role,
        canReassignOthers: true,
      });
      if (result.ok) moved += 1;
      else skipped += 1;
    }
    if (moved > 0) {
      scheduleProcessPendingDistributionQueue({
        trigger: "new_item",
        delayMs: 500,
      });
    }
    return {
      moved,
      skipped,
      total: conversations.length,
      recipients: [
        {
          userId: "",
          name: "Fila de espera",
          received: moved,
        },
      ],
    };
  }

  const all = await getDistributionResponsibles();
  let recipients = all.filter((r) => r.userId !== input.sourceUserId);

  if (input.mode === "equal") {
    // Preferência: elegíveis ONLINE. Fallback: ONLINE participando e não pausados.
    const eligibleOnline = recipients.filter(
      (r) => r.eligible && r.status === "ONLINE",
    );
    const onlineActive = recipients.filter(
      (r) =>
        r.participates &&
        !r.paused &&
        r.status === "ONLINE",
    );
    recipients = eligibleOnline.length > 0 ? eligibleOnline : onlineActive;
    if (recipients.length === 0) {
      throw Object.assign(
        new Error(
          "Nenhum consultor ONLINE elegível para receber a redistribuição. Use a opção “Fila de espera”.",
        ),
        { code: "NO_RECIPIENTS", status: 400 },
      );
    }
  } else {
    const ids = Array.from(
      new Set((input.recipientUserIds ?? []).filter(Boolean)),
    ).filter((id) => id !== input.sourceUserId);
    if (ids.length === 0) {
      throw Object.assign(
        new Error("Selecione ao menos um consultor destinatário."),
        { code: "NO_RECIPIENTS", status: 400 },
      );
    }
    const byId = new Map(all.map((r) => [r.userId, r]));
    const picked = ids.map((id) => byId.get(id)).filter(Boolean);
    if (picked.length !== ids.length) {
      throw Object.assign(
        new Error("Um ou mais destinatários são inválidos."),
        { code: "INVALID_RECIPIENTS", status: 400 },
      );
    }
    // Só elegíveis (ONLINE + horário + capacidade) — evita redistribuir
    // para quem está Offline/indisponível e continuar recebendo lead.
    const eligiblePicked = (picked as typeof recipients).filter(
      (r) => r.eligible,
    );
    if (eligiblePicked.length === 0) {
      throw Object.assign(
        new Error(
          "Nenhum dos destinatários selecionados está elegível (online e no horário). Escolha consultores disponíveis ou use a fila de espera.",
        ),
        { code: "NO_RECIPIENTS", status: 400 },
      );
    }
    recipients = eligiblePicked;
  }

  const received = new Map<string, number>();
  for (const r of recipients) received.set(r.userId, 0);

  let moved = 0;
  let skipped = 0;
  let cursor = 0;

  for (const conv of conversations) {
    const target = recipients[cursor % recipients.length]!;
    cursor += 1;
    const result = await assignConversationAssignedTo(conv.id, target.userId, {
      id: input.actor.id,
      role: input.actor.role,
      canReassignOthers: true,
    });
    if (result.ok) {
      moved += 1;
      received.set(target.userId, (received.get(target.userId) ?? 0) + 1);
    } else {
      skipped += 1;
    }
  }

  return {
    moved,
    skipped,
    total: conversations.length,
    recipients: recipients.map((r) => ({
      userId: r.userId,
      name: r.name,
      received: received.get(r.userId) ?? 0,
    })),
  };
}
