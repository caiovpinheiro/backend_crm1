/**
 * Scheduled Messages Worker — poll in-process que processa agendamentos
 * vencidos a cada `INTERVAL_MS`. Bootado junto com o sse-bus (mesmo
 * padrão do `presence-reaper`), opt-in via env `SCHEDULED_MESSAGES_WORKER=1`
 * para evitar que TODAS as réplicas processem o mesmo backlog.
 *
 * Fluxo de um agendamento pendente (scheduledAt <= now):
 *
 *  1. Reserva atômica PENDING → SENDING (`updateMany` com count === 1)
 *     antes de qualquer chamada externa. count === 0: outro worker já
 *     reservou. SENDING parado além do lease volta a PENDING para o
 *     retry implícito de crash.
 *  2. Decide modo de envio:
 *       • Canal WhatsApp Meta + sessão 24h expirada → template fallback
 *         (exigido ao criar; se ausente, FAILED).
 *       • Canal WhatsApp (Meta ou Baileys) → texto livre via sendWhatsAppText.
 *       • Outros canais → FAILED com razão clara.
 *  3. Cria a Message no banco para espelhar no inbox e chama API do canal.
 *  4. markAsSent / markAsFailed.
 *
 * Mensagens com anexo ainda não são enviadas nesta fase (texto only) —
 * o campo mediaUrl é persistido mas o worker ignora; upgrade futuro
 * buscará o binário e chamará o endpoint de media do canal.
 */

import {
  touchChatLastMessageAt,
  touchConversationLastMessageAt,
} from "@/lib/conversation-last-message";
import { metaGraphFetchWorstCaseMs } from "@/lib/meta-whatsapp/client";
import { TEMPLATE_DEFINITION_LISTING_PAGE_CAP } from "@/lib/meta-whatsapp/enrich-template-flow";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
// prismaBase para check de concorrencia cross-org (antes de entrar no
// withSystemContext da org do item).
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { metaClientFromConfig, metaWhatsApp } from "@/lib/meta-whatsapp/client";
import { enrichTemplateComponentsForFlowSend } from "@/lib/meta-whatsapp/enrich-template-flow";
import { scheduledMessageBaileysJobId } from "@/lib/queue";
import { sendWhatsAppText } from "@/lib/send-whatsapp";
import { buildOutboundTemplateMessageContent } from "@/lib/whatsapp-outbound-template-label";
import {
  listDueScheduledMessages,
  markAsFailed,
  markAsSent,
} from "@/services/scheduled-messages";
import { ScheduledMessageStatus } from "@prisma/client";
import { getLogger } from "@/lib/logger";
import { scheduleBackgroundTimeout, scheduleBackgroundInterval } from "@/lib/background-timers";

const log = getLogger("scheduled-messages-worker");

const INTERVAL_MS = Number(process.env.SCHEDULED_MESSAGES_INTERVAL_MS) || 30_000;
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Chamadas Graph no pior caminho de `dispatchOne` (`sendViaMetaTemplate`):
 * GET do template por id + até `TEMPLATE_DEFINITION_LISTING_PAGE_CAP` páginas
 * de listagem + `sendTemplate`. `sendWhatsAppText` → `sendText` é uma
 * `graphFetch` só; o lease cobre o caminho mais longo.
 *
 * Cada `graphFetch` espera no máximo `GRAPH_TIMEOUT_MS` (20s) ×
 * `META_GRAPH_MAX_ATTEMPTS` (default 3), mais o backoff linear entre
 * tentativas (teto 100% de 1s × attempt). A listagem para no primeiro throw,
 * mas uma página que falha duas vezes e sucede na terceira consome o pior
 * caso inteiro — e isso pode repetir nas 40 páginas.
 *
 * `SCHEDULED_MESSAGE_SENDING_LEASE_MS`, se for maior que esse piso, substitui
 * o default. Valor menor é ignorado: o lease não pode vencer enquanto a
 * tentativa ainda cabe no timeout do provider.
 *
 * Residual: crash depois do aceite da Meta e antes de gravar SENT pode
 * reenviar quando o lease expira. A Cloud API deste envio não recebe
 * idempotency key.
 *
 * Baileys não aumenta o lease. `sendWhatsAppText` só faz `queue.add` na fila
 * `baileys-outbound` (o consumer em `outbound-consumer.ts` é quem fala com o
 * socket). O agendamento manda `jobId` `scheduled-message-<id>` (BullMQ 5
 * não aceita `:`). O job concluído fica no Redis por 2× este lease
 * (`removeOnComplete.age`), então o recovery não recria o id depois que
 * `removeOnComplete: true` teria apagado o job e antes de gravar `SENT`.
 */
const TEMPLATE_DISPATCH_GRAPH_CALLS = 1 + TEMPLATE_DEFINITION_LISTING_PAGE_CAP + 1;

export function scheduledDispatchExternalWorstCaseMs(): number {
  return TEMPLATE_DISPATCH_GRAPH_CALLS * metaGraphFetchWorstCaseMs();
}

export function scheduledMessageSendingLeaseMs(): number {
  const worst = scheduledDispatchExternalWorstCaseMs();
  const margin = Math.max(30_000, Math.ceil(worst * 0.1));
  const floor = worst + margin;
  const raw = Number(process.env.SCHEDULED_MESSAGE_SENDING_LEASE_MS ?? "");
  if (Number.isFinite(raw) && raw >= floor) return Math.floor(raw);
  return floor;
}

/** PENDING → SENDING. Só uma instância recebe count === 1. */
export async function claimScheduledMessage(id: string): Promise<boolean> {
  const result = await prismaBase.scheduledMessage.updateMany({
    where: { id, status: ScheduledMessageStatus.PENDING },
    data: { status: ScheduledMessageStatus.SENDING },
  });
  return result.count === 1;
}

/**
 * SENDING cujo `updatedAt` é mais velho que o lease volta a PENDING.
 * O próximo claim é de novo atômico. Não marca FAILED: o retry de crash
 * (ficar PENDING e ser pego no tick) continua valendo.
 */
export async function reclaimStaleSendingScheduledMessages(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - scheduledMessageSendingLeaseMs());
  const result = await prismaBase.scheduledMessage.updateMany({
    where: {
      status: ScheduledMessageStatus.SENDING,
      updatedAt: { lt: cutoff },
    },
    data: { status: ScheduledMessageStatus.PENDING },
  });
  return result.count;
}

let started = false;

export function startScheduledMessagesWorker() {
  if (started) return;
  // Permite desligar o worker em réplicas específicas (ex.: rodar só em
  // uma instância dedicada).
  if (process.env.SCHEDULED_MESSAGES_WORKER === "0") {
    log.info("[scheduled-messages] worker desativado via env");
    return;
  }
  started = true;

  const tick = async () => {
    try {
      await tickOnce();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[scheduled-messages] tick falhou",
      );
    }
  };

  // Primeiro tick só depois de 15s (dá tempo do servidor estabilizar
  // e da migration deploy, se recém-subiu).
  scheduleBackgroundTimeout(() => {
    void tick();
    scheduleBackgroundInterval(() => void tick(), INTERVAL_MS);
  }, 15_000);

  log.info({ tickMs: INTERVAL_MS }, "[scheduled-messages] worker iniciado");
}

export async function tickOnce() {
  await reclaimStaleSendingScheduledMessages().catch((err) => {
    log.warn({ err }, "[scheduled-messages] reclaim de SENDING falhou");
  });

  const due = await listDueScheduledMessages(25);
  if (due.length === 0) return { processed: 0 };

  let sent = 0;
  let failed = 0;

  for (const item of due) {
    const claimed = await claimScheduledMessage(item.id);
    if (!claimed) continue;

    const orgId = item.conversation?.organizationId;
    if (!orgId) {
      // ScheduledMessage orfao (conversa removida) — nao conseguimos
      // montar contexto. markAsFailed precisa de org tambem; usamos
      // prismaBase direto para registrar a falha sem scope. Só a partir
      // de SENDING, para não atropelar outro worker.
      await prismaBase.scheduledMessage
        .updateMany({
          where: { id: item.id, status: ScheduledMessageStatus.SENDING },
          data: {
            status: ScheduledMessageStatus.FAILED,
            failedAt: new Date(),
            failureReason: "Conversa removida antes do envio",
          },
        })
        .catch(() => {});
      failed++;
      continue;
    }

    try {
      // Toda a pipeline de dispatch acessa models scoped (Message,
      // Conversation, Contact, Channel, etc.) — precisa do contexto
      // da org do item para o extension de org-scope injetar filtros.
      await withSystemContext(orgId, () => dispatchOne(item));
      sent++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ id: item.id, err: msg }, "[scheduled-messages] dispatch falhou");
      await withSystemContext(orgId, () => markAsFailed(item.id, msg)).catch(
        () => {},
      );
    }
  }

  if (sent > 0 || failed > 0) {
    log.info({ enviadas: sent, falhas: failed }, "[scheduled-messages] tick concluído");
  }
  return { processed: due.length, sent, failed };
}

type DueItem = Awaited<ReturnType<typeof listDueScheduledMessages>>[number];

async function dispatchOne(item: DueItem) {
  const conv = item.conversation;
  if (!conv) {
    await markAsFailed(item.id, "Conversa removida antes do envio");
    return;
  }

  const channelLower = conv.channel?.toLowerCase() ?? "";
  const isWhatsApp =
    channelLower === "whatsapp" ||
    channelLower === "whatsapp_meta" ||
    channelLower === "meta_whatsapp";

  if (!isWhatsApp) {
    await markAsFailed(
      item.id,
      `Canal "${conv.channel ?? "desconhecido"}" ainda não suportado para envio agendado`,
    );
    return;
  }

  // Busca provider do canal para decidir Meta vs Baileys.
  const channelRef = conv.channelId
    ? await prisma.channel.findUnique({
        where: { id: conv.channelId },
        select: { id: true, provider: true, config: true },
      })
    : null;

  const isBaileys = channelRef?.provider === "BAILEYS_MD";

  // Sessão 24h: só aplica a canais Meta. Baileys mantém chat ativo sem
  // essa janela, então não precisa de template fallback.
  let mustUseTemplate = false;
  if (!isBaileys) {
    const lastInboundAt = conv.lastInboundAt ?? null;
    const sessionActive =
      lastInboundAt !== null &&
      Date.now() - new Date(lastInboundAt).getTime() < SESSION_WINDOW_MS;
    mustUseTemplate = !sessionActive;
  }

  const senderName = item.createdBy?.name ?? "Agente (agendado)";

  if (mustUseTemplate) {
    if (!item.fallbackTemplateName) {
      await markAsFailed(
        item.id,
        "Sessão de 24h expirada e nenhum template fallback configurado",
      );
      return;
    }
    await sendViaMetaTemplate(item, conv, channelRef, senderName);
  } else if (isBaileys || channelRef) {
    await sendViaText(item, channelRef, senderName);
  } else {
    // Fallback: canal WhatsApp sem Channel configurado → tenta Meta global.
    await sendViaText(item, null, senderName);
  }

  await markAsSent(item.id, { sentMessageId: null });
}

async function sendViaText(
  item: DueItem,
  channelRef: { id: string; provider: string; config: unknown } | null,
  senderName: string,
) {
  const conv = item.conversation!;
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      content: item.content,
      direction: "out",
      messageType: "text",
      senderName,
    }),
  });

  const result = await sendWhatsAppText({
    conversationId: conv.id,
    contactId: conv.contactId,
    channelRef: channelRef
      ? { id: channelRef.id, provider: channelRef.provider }
      : null,
    content: item.content,
    messageId: saved.id,
    waJid: conv.waJid,
    baileysJobId:
      channelRef?.provider === "BAILEYS_MD"
        ? scheduledMessageBaileysJobId(item.id)
        : undefined,
  });

  if (result.failed) {
    // Atualiza a Message para refletir falha antes de propagar o erro.
    await prisma.message
      .update({
        where: { id: saved.id },
        data: { sendStatus: "failed", sendError: result.error ?? "send failed" },
      })
      .catch(() => {});
    // A bolha falhada fica no chat (e na prévia do card): mesma ordem.
    await touchConversationLastMessageAt({
      conversationId: conv.id,
      at: saved.createdAt,
    }).catch(() => {});
    throw new Error(result.error ?? "Envio WhatsApp falhou");
  }

  await prisma.conversation
    .update({
      where: { id: conv.id },
      data: {
        lastMessageDirection: "out",
        hasAgentReply: true,
        hasError: false,
      },
    })
    .catch(() => {});
  await touchChatLastMessageAt({ conversationId: conv.id, message: saved }).catch(() => {});

  // Só grava se esta instância ainda é a dona do SENDING.
  await prisma.scheduledMessage
    .updateMany({
      where: { id: item.id, status: ScheduledMessageStatus.SENDING },
      data: { sentMessageId: saved.id },
    })
    .catch(() => {});
}

async function sendViaMetaTemplate(
  item: DueItem,
  conv: NonNullable<DueItem["conversation"]>,
  channelRef: { id: string; provider: string; config: unknown } | null,
  senderName: string,
) {
  const client = channelRef
    ? metaClientFromConfig(channelRef.config as Record<string, unknown> | null | undefined)
    : metaWhatsApp;

  if (!client.configured) {
    throw new Error("Meta WhatsApp API não configurada para enviar template");
  }

  const contact = await prisma.contact.findUnique({
    where: { id: conv.contactId },
    select: { phone: true, whatsappBsuid: true },
  });
  const digits = contact?.phone?.replace(/\D/g, "") ?? "";
  const to = digits.length >= 8 ? digits : undefined;
  const recipient = contact?.whatsappBsuid?.trim() || undefined;
  if (!to && !recipient) {
    throw new Error("Contato sem telefone nem BSUID WhatsApp");
  }

  const templateName = item.fallbackTemplateName!;
  const languageCode = item.fallbackTemplateLanguage ?? "pt_BR";
  const components =
    item.fallbackTemplateParams && typeof item.fallbackTemplateParams === "object"
      ? (item.fallbackTemplateParams as { components?: unknown[] }).components ??
        (Array.isArray(item.fallbackTemplateParams) ? (item.fallbackTemplateParams as unknown[]) : undefined)
      : undefined;

  let templateGraphId: string | null = null;
  // Capturar `id` aqui (única query — antes eram 2) para vincular a
  // mensagem outbound ao template config via `templateConfigId`. Sem isso,
  // respostas de Flow enviadas via fallback agendado seriam roteadas para
  // o flow errado pelo resolver de Flow inbound.
  let templateConfigId: string | null = null;
  let templateCategory: string | null = null;
  try {
    const tc = await prisma.whatsAppTemplateConfig.findFirst({
      where: { metaTemplateName: templateName },
      select: { id: true, metaTemplateId: true, category: true },
    });
    templateGraphId = tc?.metaTemplateId?.trim() || null;
    templateConfigId = tc?.id ?? null;
    templateCategory = tc?.category ?? null;
  } catch {
    /* ignore */
  }

  const enrichResult = await enrichTemplateComponentsForFlowSend(client, {
    templateName,
    languageCode,
    components: components as unknown[] | undefined,
    templateGraphId,
  });

  const result = await client.sendTemplate(
    to,
    templateName,
    languageCode,
    enrichResult.components,
    recipient,
  );
  const externalId = result.messages?.[0]?.id ?? null;

  // `item.content` é o texto que o usuário digitou ao agendar — guardamos
  // como bodyPreview para o label da mensagem no inbox ficar significativo
  // ("Template: nome — 'Olá, sua consulta é amanhã...' ") em vez de só o nome.
  const messageContent = buildOutboundTemplateMessageContent(
    templateName,
    "generic",
    templateCategory,
    item.content,
  );

  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: conv.id,
      content: messageContent,
      direction: "out",
      messageType: "template",
      senderName,
      ...(externalId ? { externalId } : {}),
      ...(typeof enrichResult.flowToken === "string" && enrichResult.flowToken.trim()
        ? { flowToken: enrichResult.flowToken.trim() }
        : {}),
      ...(templateConfigId ? { templateConfigId } : {}),
    }),
  });

  await prisma.conversation
    .update({
      where: { id: conv.id },
      data: {
        lastMessageDirection: "out",
        hasAgentReply: true,
        hasError: false,
      },
    })
    .catch(() => {});
  await touchChatLastMessageAt({ conversationId: conv.id, message: saved }).catch(() => {});

  await prisma.scheduledMessage
    .updateMany({
      where: { id: item.id, status: ScheduledMessageStatus.SENDING },
      data: { sentMessageId: saved.id },
    })
    .catch(() => {});
}
