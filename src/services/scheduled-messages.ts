/**
 * Scheduled Messages — CRUD e helpers para envio/cancelamento programado de
 * mensagens em conversas.
 *
 * Regras de negócio centralizadas aqui para reuso entre API routes, worker
 * de dispatch e hooks de auto-cancelamento (inbound/outbound):
 *
 *  - `createScheduledMessage`   → validações de conteúdo mínimo, scheduledAt
 *    no futuro e canal suportado. Template fallback é OPCIONAL mesmo em
 *    canais Meta: se a sessão de 24h expirar no horário do envio e não
 *    houver template, o worker marca o agendamento como FAILED com
 *    mensagem clara (operador aceitou o risco conscientemente).
 *  - `cancelPendingForConversation` → helper idempotente chamado sempre que
 *    chega uma mensagem nova (inbound ou outbound) na conversa. Cancela
 *    todos os pendentes com a razão apropriada.
 *  - `listDueScheduledMessages` → usado pelo worker cron para buscar o que
 *    deve ser enviado agora.
 *
 * O dispatch efetivo (envio pela API do canal + criação da Message final)
 * fica no worker para poder lidar com retries sem amarrar a transação de
 * criação a I/O externo.
 */

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
// prismaBase (sem scope) usado apenas por helpers de worker cross-tenant.
import { prismaBase } from "@/lib/prisma-base";
import { ScheduledMessageStatus } from "@prisma/client";
import { publishScheduledMessageUpdated } from "@/lib/realtime-events";
import { createDealEvent } from "@/services/deals";

type ScheduledMessageEventType =
  | "SCHEDULED_MESSAGE_CREATED"
  | "SCHEDULED_MESSAGE_SENT"
  | "SCHEDULED_MESSAGE_CANCELLED"
  | "SCHEDULED_MESSAGE_FAILED";

/**
 * Log de eventos de agendamento nos deals abertos do contato da conversa.
 * Silencioso: qualquer erro é engolido (não queremos quebrar o envio/
 * cancelamento por causa de logging auxiliar).
 */
async function logScheduledMessageEventOnDeals(params: {
  conversationId: string;
  userId: string | null;
  type: ScheduledMessageEventType;
  meta: Record<string, unknown>;
}) {
  try {
    const conv = await prisma.conversation.findUnique({
      where: { id: params.conversationId },
      select: { contactId: true, channel: true },
    });
    if (!conv?.contactId) return;
    const deals = await prisma.deal.findMany({
      where: { contactId: conv.contactId, status: "OPEN" },
      select: { id: true },
    });
    if (deals.length === 0) return;
    const meta = {
      conversationId: params.conversationId,
      channel: conv.channel,
      ...params.meta,
    };
    await Promise.all(
      deals.map((d) =>
        createDealEvent(d.id, params.userId, params.type, meta),
      ),
    );
  } catch {
    /* no-op */
  }
}

export type ScheduledMessageCancelReason =
  | "client_reply"
  | "agent_reply"
  | "manual"
  | "conversation_closed";

export type CreateScheduledMessageInput = {
  conversationId: string;
  createdById: string;
  content: string;
  scheduledAt: Date;
  media?: {
    url: string;
    type?: string | null;
    name?: string | null;
  } | null;
  fallbackTemplate?: {
    name: string;
    params?: Record<string, unknown> | null;
    language?: string | null;
  } | null;
};

export class ScheduledMessageValidationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "empty_content"
      | "past_schedule"
      | "conversation_not_found"
      | "fallback_template_required"
      | "channel_not_supported",
  ) {
    super(message);
    this.name = "ScheduledMessageValidationError";
  }
}

/** Canais em que a regra de sessão 24h existe (exige template fallback). */
const META_CHANNELS = new Set(["whatsapp", "whatsapp_meta", "meta_whatsapp"]);

function isMetaChannel(channel: string | null | undefined): boolean {
  if (!channel) return false;
  return META_CHANNELS.has(channel.toLowerCase());
}

/**
 * Cria um agendamento pendente. Lança `ScheduledMessageValidationError` em
 * qualquer regra violada — o caller (API route) converte em 400.
 *
 * Observação: se `scheduledAt` for <= now(), o agendamento é aceito e será
 * enviado no próximo tick do worker (usuário explicitamente optou por
 * "sem mínimo de delay").
 */
export async function createScheduledMessage(input: CreateScheduledMessageInput) {
  const content = input.content?.trim() ?? "";
  const hasMedia = !!input.media?.url;
  if (!content && !hasMedia) {
    throw new ScheduledMessageValidationError(
      "Conteúdo ou anexo são obrigatórios",
      "empty_content",
    );
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: { id: true, channel: true, status: true },
  });
  if (!conversation) {
    throw new ScheduledMessageValidationError(
      "Conversa não encontrada",
      "conversation_not_found",
    );
  }

  // Regra da Meta: em canais WhatsApp Cloud API a sessão de 24h pode ter
  // expirado no momento do envio. O template fallback é o único caminho
  // garantido de entrega nesse cenário — por isso oferecemos opção no
  // formulário, mas NÃO é obrigatório: alguns agendamentos são de curto
  // prazo (próximos minutos) ou seguem outra conversa ativa, onde o
  // operador aceita o risco de a sessão expirar. Nesses casos o worker
  // marca o item como FAILED com mensagem clara no histórico.

  const created = await prisma.scheduledMessage.create({
    data: withOrgFromCtx({
      conversationId: input.conversationId,
      createdById: input.createdById,
      content,
      scheduledAt: input.scheduledAt,
      mediaUrl: input.media?.url ?? null,
      mediaType: input.media?.type ?? null,
      mediaName: input.media?.name ?? null,
      fallbackTemplateName: input.fallbackTemplate?.name ?? null,
      // Prisma espera JSON válido; passamos null explicitamente quando não tem.
      fallbackTemplateParams:
        input.fallbackTemplate?.params === undefined || input.fallbackTemplate?.params === null
          ? undefined
          : (input.fallbackTemplate.params as object),
      fallbackTemplateLanguage: input.fallbackTemplate?.language ?? null,
      status: ScheduledMessageStatus.PENDING,
    }),
  });

  // Banner de agendados das outras abas/agentes (SSE; sem isso só o poll
  // de 60s mostrava o item novo).
  publishScheduledMessageUpdated({
    organizationId: created.organizationId,
    conversationId: input.conversationId,
    scheduledMessageId: created.id,
    status: "PENDING",
  });

  await logScheduledMessageEventOnDeals({
    conversationId: input.conversationId,
    userId: input.createdById,
    type: "SCHEDULED_MESSAGE_CREATED",
    meta: {
      scheduledMessageId: created.id,
      scheduledAt: input.scheduledAt.toISOString(),
      preview: content.slice(0, 120),
      hasMedia: !!input.media?.url,
      hasFallbackTemplate: !!input.fallbackTemplate?.name,
    },
  });

  return created;
}

export async function listPendingByConversation(conversationId: string) {
  return prisma.scheduledMessage.findMany({
    where: { conversationId, status: ScheduledMessageStatus.PENDING },
    orderBy: { scheduledAt: "asc" },
    include: {
      createdBy: { select: { id: true, name: true, avatarUrl: true } },
    },
  });
}

export async function getScheduledMessage(id: string) {
  return prisma.scheduledMessage.findUnique({
    where: { id },
    include: {
      conversation: {
        select: {
          id: true,
          channel: true,
          status: true,
          channelId: true,
          contactId: true,
          waJid: true,
          lastInboundAt: true,
          hasAgentReply: true,
        },
      },
      createdBy: { select: { id: true, name: true } },
    },
  });
}

/**
 * Cancela todos os agendamentos PENDING de uma conversa. Chamado por:
 *  - Webhooks de inbound   (reason: "client_reply")
 *  - API de envio outbound (reason: "agent_reply")
 *  - UI de cancelar manual (reason: "manual") — nesse caso a UI chama a
 *    versão mais específica `cancelScheduledMessage` abaixo.
 *  - Ao fechar/resolver conversa (reason: "conversation_closed")
 *
 * Idempotente e silencioso: não lança se não houver pendentes.
 */
export async function cancelPendingForConversation(
  conversationId: string,
  reason: ScheduledMessageCancelReason,
  cancelledById: string | null = null,
) {
  const now = new Date();
  // Lê os IDs antes pra gerar eventos detalhados por agendamento cancelado.
  // Se ninguém pendente, short-circuit (evita UPDATE desnecessário).
  const pendingIds = await prisma.scheduledMessage.findMany({
    where: { conversationId, status: ScheduledMessageStatus.PENDING },
    select: { id: true, organizationId: true },
  });
  if (pendingIds.length === 0) return 0;

  const result = await prisma.scheduledMessage.updateMany({
    where: {
      conversationId,
      status: ScheduledMessageStatus.PENDING,
    },
    data: {
      status: ScheduledMessageStatus.CANCELLED,
      cancelledAt: now,
      cancelReason: reason,
      cancelledById,
    },
  });

  if (result.count > 0) {
    // Um evento por conversa (não por item): o cliente só invalida a lista.
    publishScheduledMessageUpdated({
      organizationId: pendingIds[0]?.organizationId,
      conversationId,
      scheduledMessageId: pendingIds.length === 1 ? pendingIds[0].id : null,
      status: "CANCELLED",
    });
  }

  // Um evento por agendamento cancelado — assim o histórico do deal mostra
  // exatamente o que foi abortado, útil pra auditoria.
  await Promise.all(
    pendingIds.map((sm) =>
      logScheduledMessageEventOnDeals({
        conversationId,
        userId: cancelledById,
        type: "SCHEDULED_MESSAGE_CANCELLED",
        meta: { scheduledMessageId: sm.id, reason },
      }),
    ),
  );

  return result.count;
}

/** Cancelamento manual de um agendamento específico pelo usuário na UI. */
export async function cancelScheduledMessage(
  id: string,
  cancelledById: string,
) {
  const existing = await prisma.scheduledMessage.findUnique({
    where: { id },
    select: { id: true, status: true, conversationId: true },
  });
  if (!existing) return null;
  if (existing.status !== ScheduledMessageStatus.PENDING) return existing;

  const updated = await prisma.scheduledMessage.update({
    where: { id },
    data: {
      status: ScheduledMessageStatus.CANCELLED,
      cancelledAt: new Date(),
      cancelReason: "manual",
      cancelledById,
    },
  });

  publishScheduledMessageUpdated({
    organizationId: updated.organizationId,
    conversationId: existing.conversationId,
    scheduledMessageId: id,
    status: "CANCELLED",
  });

  await logScheduledMessageEventOnDeals({
    conversationId: existing.conversationId,
    userId: cancelledById,
    type: "SCHEDULED_MESSAGE_CANCELLED",
    meta: { scheduledMessageId: id, reason: "manual" },
  });

  return updated;
}

/**
 * Worker helper: busca agendamentos vencidos prontos para envio.
 * Limit protege contra backlog gigante emperrar um tick.
 *
 * IMPORTANTE: usa `prismaBase` (sem org-scope) porque o worker roda
 * cross-tenant — precisa achar agendamentos de TODAS as orgs e despachar
 * cada um dentro de `withSystemContext(organizationId)`.
 * O `organizationId` vem no select para o caller poder montar o contexto.
 */
export async function listDueScheduledMessages(limit = 25) {
  return prismaBase.scheduledMessage.findMany({
    where: {
      status: ScheduledMessageStatus.PENDING,
      scheduledAt: { lte: new Date() },
    },
    orderBy: { scheduledAt: "asc" },
    take: limit,
    include: {
      conversation: {
        select: {
          id: true,
          channel: true,
          channelId: true,
          contactId: true,
          status: true,
          waJid: true,
          lastInboundAt: true,
          hasAgentReply: true,
          organizationId: true,
        },
      },
      createdBy: { select: { id: true, name: true } },
    },
  });
}

export async function markAsSent(
  id: string,
  data: { sentMessageId?: string | null },
) {
  const claimed = await prisma.scheduledMessage.updateMany({
    where: { id, status: ScheduledMessageStatus.SENDING },
    data: {
      status: ScheduledMessageStatus.SENT,
      sentAt: new Date(),
      sentMessageId: data.sentMessageId ?? null,
    },
  });
  if (claimed.count !== 1) return null;

  const updated = await prisma.scheduledMessage.findUnique({ where: { id } });
  if (!updated) return null;

  publishScheduledMessageUpdated({
    organizationId: updated.organizationId,
    conversationId: updated.conversationId,
    scheduledMessageId: id,
    status: "SENT",
  });

  await logScheduledMessageEventOnDeals({
    conversationId: updated.conversationId,
    // Autor do agendamento vira o "autor" do evento SENT (worker é quem de
    // fato envia, mas o responsável pela ação é quem agendou).
    userId: updated.createdById,
    type: "SCHEDULED_MESSAGE_SENT",
    meta: {
      scheduledMessageId: id,
      sentMessageId: data.sentMessageId ?? null,
      viaFallbackTemplate: !!updated.fallbackTemplateName && !updated.content,
    },
  });

  return updated;
}

export async function markAsFailed(id: string, reason: string) {
  const claimed = await prisma.scheduledMessage.updateMany({
    where: { id, status: ScheduledMessageStatus.SENDING },
    data: {
      status: ScheduledMessageStatus.FAILED,
      failedAt: new Date(),
      failureReason: reason.slice(0, 500),
    },
  });
  if (claimed.count !== 1) return null;

  const updated = await prisma.scheduledMessage.findUnique({ where: { id } });
  if (!updated) return null;

  // FAILED também sai da lista de pendentes — o banner precisa saber.
  publishScheduledMessageUpdated({
    organizationId: updated.organizationId,
    conversationId: updated.conversationId,
    scheduledMessageId: id,
    status: "FAILED",
  });

  await logScheduledMessageEventOnDeals({
    conversationId: updated.conversationId,
    userId: updated.createdById,
    type: "SCHEDULED_MESSAGE_FAILED",
    meta: {
      scheduledMessageId: id,
      reason: reason.slice(0, 500),
    },
  });

  return updated;
}

export { isMetaChannel };
