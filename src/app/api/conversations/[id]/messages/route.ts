import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { userOrgFilter } from "@/lib/auth-helpers";
import { debugLog } from "@/lib/debug-log";
import type { AppUserRole } from "@/lib/auth-types";
import {
  canDoChannelAction,
  requireChannelScope,
} from "@/lib/authz/resource-policy";
import { getContactChannelSession, getConversationSession } from "@/lib/channel-session";
import { getContactWhatsAppTargets } from "@/lib/contact-whatsapp-target";
import { requireConversationAccess } from "@/lib/conversation-access";
import { resolveOutboundChannel } from "@/lib/outbound-channel";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { metaWhatsApp, metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { withRateLimit } from "@/lib/rate-limit";
import { sendWhatsAppText, isBaileysChannel } from "@/lib/send-whatsapp";
import {
  platformFromConversationChannel,
  sendMessengerOrInstagramText,
} from "@/lib/send-meta-messaging";
import { sseBus } from "@/lib/sse-bus";
import { getConversationLite, reopenResolvedAsNewTicket } from "@/services/conversations";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
import { cancelActiveContextsForContact } from "@/services/automation-context";
import { cancelPendingForConversation } from "@/services/scheduled-messages";
import { cancelAiReplyDebounce } from "@/services/ai/inbound-debounce";
import { logEvent } from "@/services/activity-log";
import {
  enrichEventMessageActors,
  resolveLifecycleEventActor,
} from "@/services/conversation-event-actors";
import {
  buildOutboundTemplateMessageContent,
  extractLegacyBracketTemplateName,
} from "@/lib/whatsapp-outbound-template-label";

/** Após humano enviar: mata salesbot ativo do contato (best-effort). */
async function stopAutomationsAfterHumanReply(
  contactId: string | null | undefined,
): Promise<void> {
  if (!contactId) return;
  try {
    await cancelActiveContextsForContact(contactId);
  } catch (err) {
    console.warn("[automation] cancel after human reply:", err);
  }
}
type RouteContext = { params: Promise<{ id: string }> };

// ── DTO ──────────────────────────────────────

/**
 * Entrada individual do JSON `Message.reactions`. Formato gravado pelo
 * webhook Meta em `applyIncomingReaction` (lib/meta-webhook/handler.ts):
 * um item por reator (WhatsApp permite 1 reação por pessoa em canais 1:1).
 *
 *   emoji: emoji cru (💚, 👍, …)
 *   from:  wa_id / BSUID de quem reagiu (contato)
 *   at:    ISO timestamp da reação mais recente
 */
export type ReactionDto = { emoji: string; from: string; at?: string };

export type InboxMessageDto = {
  id: number | string;
  content: string;
  createdAt: string | null;
  direction: "in" | "out" | "system";
  messageType: string | number | undefined;
  isPrivate?: boolean;
  senderName?: string | null;
  /** User.id do agente humano no EVENT (legado "Agente" resolve por este id). */
  senderUserId?: string | null;
  /**
   * Autoria explícita da mensagem (`human` | `bot` | `system`). Setado
   * pelos serviços que criam mensagens (automation-executor, AI handler,
   * whatsapp-flow-response). Usado pela UI para renderizar a badge
   * "AUTOMAÇÃO" independentemente do texto de `senderName` — antes a
   * detecção dependia de `senderName === "Automação"` hardcoded, o que
   * impedia mostrar o NOME da automação que executou o passo.
   */
  authorType?: "human" | "bot" | "system";
  /**
   * Nome do agente que disparou a automação MANUALMENTE. Quando presente
   * (mensagem `out` de bot), o inbox exibe o selo "Manual" + o avatar do
   * agente ao lado do robô (colab). NULL para envios automáticos/reativos.
   */
  triggeredByName?: string | null;
  /**
   * URL da foto de perfil do agente que assinou a mensagem (resolvido
   * server-side via match de `senderName` com `User.name` no workspace).
   * Permite que o avatar exibido no balão out (chat-window) HERDE a
   * mesma identidade visual do perfil do usuário em `/settings/profile`,
   * sem depender de FK direta — `Message.senderId` ainda não existe no
   * schema; quando existir, troca esse lookup por relação direta.
   */
  senderImageUrl?: string | null;
  mediaUrl?: string | null;
  replyToId?: string | null;
  replyToPreview?: string | null;
  reactions?: ReactionDto[];
  sendStatus?: string;
  sendError?: string;
  /**
   * Status de entrega normalizado (estilo WhatsApp) — derivado de
   * `sendStatus`. Apenas mensagens `out` o exibem. Alimenta os ticks
   * (✓ / ✓✓ / ✓✓ azul) no balão do chat.
   */
  status?: "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED";
  /**
   * Conexão (Channel) por onde ESTA mensagem trafegou. Permite ao chat
   * distinguir, na mesma conversa, mensagens de contas distintas do mesmo
   * canal (ex.: dois WhatsApps da org). `null` = histórica/sem vínculo
   * (o frontend trata como "herda a conexão anterior", sem marcador).
   */
  channelId?: string | null;
  /** Mensagem favoritada pelo agente LOGADO (marcador pessoal — não é
   *  compartilhado entre agentes). Alimenta a estrela preenchida no
   *  menu contextual e no bubble. */
  favoritedByMe?: boolean;
};

/** Resumo de uma conexão (Channel) para exibir o canal na UI do inbox/contato. */
export type ConnectionRefDto = {
  id: string;
  name: string;
  type: string;
  phoneNumber: string | null;
};

/** Normaliza o `sendStatus` (string livre) para o enum de status do DTO. */
function mapSendStatus(s: string | null | undefined): InboxMessageDto["status"] {
  switch ((s ?? "").toLowerCase()) {
    case "pending":
      return "PENDING";
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    default:
      return undefined; // "draft" e outros — sem ticks.
  }
}

/** Abre `[Template: nome]` com o corpo salvo no config local (mensagens antigas). */
async function expandLegacyTemplateContents(contents: string[]): Promise<Map<string, string>> {
  const names = new Set<string>();
  for (const c of contents) {
    const n = extractLegacyBracketTemplateName(c);
    if (n) names.add(n);
  }
  if (names.size === 0) return new Map();
  const rows = await prisma.whatsAppTemplateConfig.findMany({
    where: { metaTemplateName: { in: [...names] } },
    select: { metaTemplateName: true, bodyPreview: true, category: true },
  });
  const byName = new Map(rows.map((r) => [r.metaTemplateName, r]));
  const out = new Map<string, string>();
  for (const c of contents) {
    const n = extractLegacyBracketTemplateName(c);
    if (!n) continue;
    const hit = byName.get(n);
    out.set(
      c,
      buildOutboundTemplateMessageContent(
        n,
        /call_permission/i.test(n) ? "call_permission" : "generic",
        hit?.category,
        hit?.bodyPreview?.trim() || null,
      ),
    );
  }
  return out;
}

const MSG_SELECT = {
  id: true, externalId: true, content: true, createdAt: true,
  direction: true, messageType: true, isPrivate: true, senderName: true,
  authorType: true, triggeredByName: true,
  mediaUrl: true, replyToId: true, replyToPreview: true, reactions: true,
  sendStatus: true, sendError: true, channelId: true,
} satisfies Prisma.MessageSelect;

type MsgRow = Prisma.MessageGetPayload<{ select: typeof MSG_SELECT }>;

/**
 * findMany de mensagens tolerante à ausência da coluna `triggeredByName`.
 * Em ambientes onde a migração `..._add_message_triggered_by_name` ainda não
 * rodou, selecionar a coluna faz o Prisma lançar P2022 e derruba TODO o GET
 * de mensagens — a conversa aparece VAZIA. Aqui, nesse caso, refazemos a
 * query sem o campo e devolvemos `triggeredByName: null`, mantendo o inbox
 * funcional até a migração ser aplicada.
 */
async function findMessagesSafe(args: {
  where: Prisma.MessageWhereInput;
  orderBy: Prisma.MessageOrderByWithRelationInput;
  take: number;
}): Promise<MsgRow[]> {
  try {
    return await prisma.message.findMany({ ...args, select: MSG_SELECT });
  } catch (e) {
    const code = (e as { code?: string })?.code;
    const message = e instanceof Error ? e.message : String(e);
    if (code === "P2022" || /triggeredByName/i.test(message)) {
      const { triggeredByName: _omit, ...safeSelect } = MSG_SELECT;
      const rows = await prisma.message.findMany({ ...args, select: safeSelect });
      return rows.map((r) => ({ ...r, triggeredByName: null })) as MsgRow[];
    }
    throw e;
  }
}

// ── GET ──────────────────────────────────────

export async function GET(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const { id } = await context.params;
    const accessUser = authResult.user as { id: string; role: AppUserRole };
    const denied = await requireConversationAccess({ user: accessUser }, id);
    if (denied) return denied;

    const conv = await getConversationLite(id);
    if (!conv) {
      return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
    }

    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const before = url.searchParams.get("before");
    const includeHistory = url.searchParams.get("history") === "1";

    const olderTicketsProbe =
      !includeHistory && !before && conv.contactId
        ? prisma.conversation.findFirst({
            where: {
              contactId: conv.contactId,
              id: { not: conv.id },
              ...(conv.channel ? { channel: conv.channel } : {}),
            },
            select: { id: true },
          })
        : Promise.resolve(null);

    // Cold path: 1ª página + probe barato (só pra saber se o prefetch/
    // scroll-up deve pedir history). history=1 sem `before` = 1 ticket.
    const [pinnedBundle, convSession, rowsDesc, olderTicket] = await Promise.all([
      (async (): Promise<{ pinnedNoteId: string | null; pinnedMessageIds: string[] }> => {
        try {
          const pins = await prisma.pinnedMessage.findMany({
            where: { conversationId: conv.id },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              expiresAt: true,
              message: { select: { id: true, externalId: true } },
            },
          });
          const now = new Date();
          const expiredIds = pins
            .filter((p) => p.expiresAt && p.expiresAt < now)
            .map((p) => p.id);
          if (expiredIds.length > 0) {
            void prisma.pinnedMessage
              .deleteMany({ where: { id: { in: expiredIds } } })
              .catch(() => undefined);
          }
          return {
            pinnedNoteId: conv.pinnedNoteId ?? null,
            pinnedMessageIds: pins
              .filter((p) => !(p.expiresAt && p.expiresAt < now))
              .map((p) => p.message.externalId ?? p.message.id),
          };
        } catch {
          return { pinnedNoteId: conv.pinnedNoteId ?? null, pinnedMessageIds: [] };
        }
      })(),
      getConversationSession(conv),
      includeHistory
        ? Promise.resolve([] as MsgRow[])
        : findMessagesSafe({
            where: {
              conversationId: conv.id,
              ...(before ? { createdAt: { lt: new Date(before) } } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: limit,
          }),
      olderTicketsProbe,
    ]);

    const hasMore = includeHistory ? false : rowsDesc.length === limit;
    let hasOlderTickets = !includeHistory && Boolean(olderTicket);
    const historyBudget = includeHistory
      ? Math.min(40, Math.max(8, Number(url.searchParams.get("budget") || limit) || 25))
      : null;
    const beforeDate = before ? new Date(before) : null;
    const pinnedNoteId = pinnedBundle.pinnedNoteId;
    const pinnedMessageIds = pinnedBundle.pinnedMessageIds;
    const lastInboundAt = convSession.lastInboundAt;
    const sessionActive = convSession.active;
    const sessionExpiresAt = convSession.expiresAt?.toISOString() ?? null;
    const rows = [...rowsDesc].reverse();

    debugLog(
      `[session] conv=${conv.id} lastInbound=${lastInboundAt?.toISOString() ?? "NULL"} active=${sessionActive}`
    );

    type HistoryTicket = {
      id: string;
      number: number;
      closedAt: Date | null;
      createdAt: Date | null;
      rows: (typeof rows)[number][];
    };
    let historyTickets: HistoryTicket[] = [];
    if (includeHistory && conv.contactId && conv.channel) {
      const viewingResolved = conv.status === "RESOLVED";
      const prevConvs = await prisma.conversation.findMany({
        where: {
          contactId: conv.contactId,
          channel: conv.channel,
          id: { not: conv.id },
          // Ticket RESOLVED: os encerrados ANTERIORES (não poluir a timeline
          // de um ticket antigo com tudo que veio depois) MAIS o ticket ativo
          // do contato/canal, se houver. O ticket ativo é a exceção porque a
          // mesma proteção do ramo aberto vale aqui: se o card saltou para um
          // id antigo, o chat recente continua visível. Sem ele, uma resposta
          // do cliente que entrou num ticket novo ficava invisível na
          // timeline enquanto aparecia no preview do card (que é por contato).
          // Só existe um não-RESOLVED por (org, contato, canal), então isso
          // acrescenta no máximo um ticket.
          //
          // Ticket aberto: todos os outros do contato/canal.
          ...(viewingResolved
            ? {
                OR: [
                  {
                    status: "RESOLVED" as const,
                    createdAt: { lt: conv.createdAt },
                  },
                  { status: { not: "RESOLVED" as const } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, number: true, closedAt: true, createdAt: true },
        // +1 no ramo RESOLVED para o ticket ativo não roubar a vaga de um dos
        // 5 encerrados anteriores que já apareciam antes desta mudança.
        take: 40,
      });
      let remaining = historyBudget ?? 25;
      const loaded: HistoryTicket[] = [];
      for (let i = 0; i < prevConvs.length; i++) {
        if (remaining <= 0) {
          hasOlderTickets = true;
          break;
        }
        const pc = prevConvs[i];
        const pRows = await findMessagesSafe({
          where: {
            conversationId: pc.id,
            ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: remaining,
        });
        if (pRows.length === 0) continue;
        if (pRows.length === remaining) hasOlderTickets = true;
        pRows.reverse();
        loaded.push({
          id: pc.id,
          number: pc.number,
          closedAt: pc.closedAt,
          createdAt: pc.createdAt,
          rows: pRows,
        });
        remaining -= pRows.length;
        // Sem `before` (prefetch ao abrir o card): só o ticket anterior
        // mais recente, capado pelo budget. Atravessar todos os tickets
        // até encher o budget virava dump (ex.: 8 tickets curtos).
        if (!beforeDate) {
          if (i < prevConvs.length - 1) hasOlderTickets = true;
          break;
        }
      }
      historyTickets = loaded.reverse();
    }

    const outSenderNames = Array.from(
      new Set(
        rows
          .filter((r) => r.direction === "out" && r.senderName)
          .map((r) => r.senderName!.trim())
          .filter(Boolean),
      ),
    );

    const referencedChannelIds = Array.from(
      new Set(
        [conv.channelId, ...rows.map((r) => r.channelId)].filter(
          (v): v is string => Boolean(v),
        ),
      ),
    );

    const [favRows, agents, channelRows, canReply] = await Promise.all([
      prisma.favoriteMessage
        .findMany({
          where: {
            userId: (authResult.user as { id: string }).id,
            messageId: { in: rows.map((r) => r.id) },
          },
          select: { messageId: true },
        })
        .catch(() => [] as { messageId: string }[]),
      outSenderNames.length > 0
        ? prisma.user.findMany({
            where: {
              OR: outSenderNames.map((name) => ({
                name: { equals: name, mode: "insensitive" as const },
              })),
              ...userOrgFilter({ user: authResult.user }),
            },
            select: { name: true, avatarUrl: true },
          })
        : Promise.resolve([] as { name: string; avatarUrl: string | null }[]),
      referencedChannelIds.length > 0
        ? prisma.channel.findMany({
            where: {
              id: { in: referencedChannelIds },
              ...userOrgFilter({ user: authResult.user }),
            },
            select: { id: true, name: true, type: true, phoneNumber: true },
          })
        : Promise.resolve(
            [] as {
              id: string;
              name: string;
              type: string;
              phoneNumber: string | null;
            }[],
          ),
      canDoChannelAction(accessUser, "send", conv.channelId),
    ]);

    const favoritedIds = new Set(favRows.map((f) => f.messageId));
    const senderAvatarMap = new Map<string, string | null>();
    for (const agent of agents) {
      senderAvatarMap.set(agent.name.toLowerCase(), agent.avatarUrl ?? null);
    }

    const templateContentMap = await expandLegacyTemplateContents([
      ...rows.map((r) => r.content),
      ...historyTickets.flatMap((t) => t.rows.map((r) => r.content)),
    ]);
    const openedContent = (raw: string) => templateContentMap.get(raw) ?? raw;

    const eventActors = await enrichEventMessageActors([
      {
        conversationId: conv.id,
        rows,
        contents: rows.map((r) => r.content),
      },
      ...historyTickets.map((t) => ({
        conversationId: t.id,
        rows: t.rows,
        contents: t.rows.map((r) => r.content),
      })),
    ]).catch(() => new Map<string, { senderName: string; senderUserId: string | null }>());

    const eventActorOf = (id: string, fallbackName: string | null) => {
      const hit = eventActors.get(id);
      return {
        senderName: hit?.senderName ?? fallbackName,
        senderUserId: hit?.senderUserId ?? null,
      };
    };

    const messages: InboxMessageDto[] = rows.map((r) => {
      const ev = eventActorOf(r.id, r.senderName);
      return {
      id: r.externalId ?? r.id,
      content: openedContent(r.content),
      createdAt: r.createdAt.toISOString(),
      direction: r.direction as InboxMessageDto["direction"],
      messageType: r.messageType,
      isPrivate: r.isPrivate || undefined,
      senderName: ev.senderName,
      senderUserId: ev.senderUserId,
      authorType: r.authorType as "human" | "bot" | "system",
      triggeredByName: r.triggeredByName ?? undefined,
      senderImageUrl:
        r.direction === "out" && ev.senderName
          ? senderAvatarMap.get(ev.senderName.trim().toLowerCase()) ?? null
          : null,
      mediaUrl: r.mediaUrl,
      replyToId: r.replyToId,
      replyToPreview: r.replyToPreview,
      reactions: Array.isArray(r.reactions) ? (r.reactions as ReactionDto[]) : [],
      sendStatus: r.sendStatus,
      sendError: r.sendError ?? undefined,
      status: r.direction === "out" ? mapSendStatus(r.sendStatus) : undefined,
      channelId: r.channelId ?? null,
      favoritedByMe: favoritedIds.has(r.id) || undefined,
    };
    });

    const channelsMap: Record<string, ConnectionRefDto> = {};
    for (const ch of channelRows) {
      channelsMap[ch.id] = {
        id: ch.id,
        name: ch.name,
        type: ch.type,
        phoneNumber: ch.phoneNumber ?? null,
      };
    }
    const currentChannel: ConnectionRefDto | null =
      (conv.channelId && channelsMap[conv.channelId]) || null;

    // Monta a linha do tempo completa: tickets anteriores (com separadores)
    // + mensagens do ticket atual.
    let finalMessages: InboxMessageDto[] = messages;
    if (historyTickets.length > 0) {
      const mapRows = (rr: typeof rows): InboxMessageDto[] =>
        rr.map((r) => ({
          id: r.externalId ?? r.id,
          content: openedContent(r.content),
          createdAt: r.createdAt.toISOString(),
          direction: r.direction as InboxMessageDto["direction"],
          messageType: r.messageType,
          isPrivate: r.isPrivate || undefined,
          senderName: eventActorOf(r.id, r.senderName).senderName,
          senderUserId: eventActorOf(r.id, r.senderName).senderUserId,
          authorType: r.authorType as "human" | "bot" | "system",
          triggeredByName: r.triggeredByName ?? undefined,
          mediaUrl: r.mediaUrl,
          replyToId: r.replyToId,
          replyToPreview: r.replyToPreview,
          reactions: Array.isArray(r.reactions) ? (r.reactions as ReactionDto[]) : [],
          sendStatus: r.sendStatus,
          sendError: r.sendError ?? undefined,
          status: r.direction === "out" ? mapSendStatus(r.sendStatus) : undefined,
          channelId: r.channelId ?? null,
        }));

      const ticketIds = [...historyTickets.map((t) => t.id), conv.id];
      const lifeEvents = await prisma.activityEvent
        .findMany({
          where: {
            conversationId: { in: ticketIds },
            type: { in: ["CONVERSATION_CREATED", "CONVERSATION_CLOSED"] },
          },
          select: {
            conversationId: true,
            type: true,
            actorUserId: true,
            actorLabel: true,
            actorType: true,
            actorUser: { select: { name: true, email: true, type: true } },
          },
          orderBy: { occurredAt: "asc" },
        })
        .catch(() => []);
      const createdByConv = new Map<string, (typeof lifeEvents)[number]>();
      const closedByConv = new Map<string, (typeof lifeEvents)[number]>();
      for (const ev of lifeEvents) {
        if (!ev.conversationId) continue;
        if (ev.type === "CONVERSATION_CREATED" && !createdByConv.has(ev.conversationId)) {
          createdByConv.set(ev.conversationId, ev);
        }
        if (ev.type === "CONVERSATION_CLOSED") {
          closedByConv.set(ev.conversationId, ev);
        }
      }

      const historical: InboxMessageDto[] = [];
      for (const ticket of historyTickets) {
        const opened = resolveLifecycleEventActor(createdByConv.get(ticket.id));
        const closed = resolveLifecycleEventActor(closedByConv.get(ticket.id));
        historical.push({
          id: `__ticket_sep_${ticket.id}`,
          content: JSON.stringify({
            number: ticket.number,
            closedAt: ticket.closedAt?.toISOString() ?? null,
            openedAt: ticket.createdAt?.toISOString() ?? null,
            openedByName: opened.name,
            openedByUserId: opened.userId,
            closedByName: closed.name,
            closedByUserId: closed.userId,
          }),
          createdAt: ticket.createdAt?.toISOString() ?? ticket.closedAt?.toISOString() ?? new Date(0).toISOString(),
          direction: "system",
          messageType: "ticket-separator",
        });
        historical.push(...mapRows(ticket.rows));
      }
      const opened = resolveLifecycleEventActor(createdByConv.get(conv.id));

      // Separador do ticket atual (só se houver histórico).
      historical.push({
        id: `__ticket_sep_${conv.id}`,
        content: JSON.stringify({
          number: conv.number,
          closedAt: null,
          isCurrent: true,
          openedAt: conv.createdAt?.toISOString?.() ?? null,
          openedByName: opened.name,
          openedByUserId: opened.userId,
        }),
        createdAt: conv.createdAt?.toISOString?.() ?? new Date().toISOString(),
        direction: "system",
        messageType: "ticket-separator",
      });
      finalMessages = [...historical, ...messages];
    }

    return NextResponse.json({
      messages: finalMessages,
      hasMore,
      hasOlderTickets,
      pinnedNoteId,
      pinnedMessageIds,
      channelProvider: conv.channelRef?.provider ?? null,
      channel: currentChannel,
      channels: channelsMap,
      canReply,
      session: {
        lastInboundAt: lastInboundAt?.toISOString() ?? null,
        active: sessionActive,
        expiresAt: sessionExpiresAt,
      },
    });
    });
  } catch (e: unknown) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Erro ao carregar mensagens.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}

// ── POST ─────────────────────────────────────

export async function POST(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    // Bearer/integração: teto de org isolado. Sessão já tem api.session
    // (600/user) — não misturar com o RPM da API de fora.
    if (authResult.viaToken) {
      const userOrgId =
        (authResult.user as { organizationId?: string | null }).organizationId ??
        null;
      const rl = await withRateLimit({
        route: "/api/conversations/:id/messages",
        profile: "api.default",
        scope: "org",
        id: userOrgId,
      });
      if (!rl.ok) return rl.response;
    }

    return await runWithApiUserContext(authResult.user, async () => {
    const { id } = await context.params;
    const accessUser = authResult.user as { id: string; role: AppUserRole };
    const denied = await requireConversationAccess({ user: accessUser }, id);
    if (denied) return denied;

    let conv = await getConversationLite(id);
    if (!conv) {
      return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    const content = typeof b.content === "string" ? b.content.trim() : "";
    if (!content) {
      return NextResponse.json({ message: "Mensagem vazia." }, { status: 400 });
    }

    const messageType =
      typeof b.messageType === "string" && b.messageType.length > 0
        ? b.messageType
        : "outgoing";
    const isPrivateNote = b.private === true || messageType === "note";

    // Regra "reabrir = novo id": responder numa conversa ENCERRADA reabre
    // como NOVO ticket. A mensagem entra no ticket novo; o id antigo fica
    // como historico. Notas internas NAO reabrem (sao anotacoes do ticket).
    let reopenedConversationId: string | null = null;
    if (!isPrivateNote && conv.status === "RESOLVED" && conv.contactId) {
      const reopened = await reopenResolvedAsNewTicket(conv.id);
      if (reopened.id !== conv.id) {
        const fresh = await getConversationLite(reopened.id);
        if (fresh) {
          reopenedConversationId = reopened.id;
          const previousConversationId = conv.id;
          if (reopened.created) {
            void logEvent({
              type: "CONVERSATION_CREATED",
              entityType: "CONVERSATION",
              entityId: fresh.id,
              entityLabel: null,
              conversationId: fresh.id,
              contactId: fresh.contactId,
              meta: { channel: fresh.channel, source: "reply_reopen", previousConversationId },
            });
            fireTrigger("conversation_created", {
              contactId: fresh.contactId ?? undefined,
              data: { channel: fresh.channel, source: "reply_reopen", previousConversationId },
            }).catch(() => { /* fire-and-forget */ });
          }
          conv = fresh;
        }
      }
    }

    // Override de canal vindo do composer (UI permite escolher por qual
    // WhatsApp enviar quando a org tem >1 conectado). Quando ausente ou
    // igual ao canal "atual" da conversa, comportamento legacy preservado.
    // Notas privadas ignoram override — são internas e não passam pelo canal.
    const requestedChannelId =
      typeof b.channelId === "string" ? b.channelId : null;

    // Escopo de canal: enviar mensagem exige permissão de "send" no canal
    // da conversa. Notas privadas são internas e não passam pelo canal.
    if (!isPrivateNote) {
      const sendDenied = await requireChannelScope(authResult.user, "send", conv.channelId);
      if (sendDenied) return sendDenied;
    }

    // Resolve o canal de envio (com override se válido). Vem ANTES do
    // `prisma.message.create` para que o snapshot `message.channelId` já
    // grave o canal certo.
    let outboundChannelRef = conv.channelRef;
    let outboundChannelId = conv.channelId;
    if (!isPrivateNote) {
      const resolved = await resolveOutboundChannel({
        conv: {
          channelId: conv.channelId,
          channelRef: conv.channelRef,
          organizationId: conv.organizationId,
        },
        user: authResult.user as {
          id: string;
          role?: string | null;
          organizationId: string | null;
          isSuperAdmin?: boolean;
        },
        requestedChannelId,
      });
      if (!resolved.ok) return resolved.response;
      outboundChannelRef = resolved.channelRef;
      outboundChannelId = resolved.channelId;

      // Bloqueio duro para envio HUMANO (sessão NextAuth) de texto livre
      // fora da janela de 24h em canal Meta Cloud API: a mensagem nem é
      // criada — nunca chega a falhar na Meta (131047). Com override de
      // canal, valida a janela NO canal de destino; sem override, usa o
      // lastInboundAt da conversa (mesmo critério do GET messages — roda
      // DEPOIS do "reabrir = novo ticket", com o estado fresco de `conv`).
      // Integrações (Bearer) e automações não levam 409: nelas o envio
      // fora da janela deve seguir pra Meta e marcar erro (sendStatus
      // failed / hasError). Templates usam a rota /template (não entram
      // aqui); notas privadas nem chegam neste bloco.
      if (
        !authResult.viaToken &&
        outboundChannelRef?.provider === "META_CLOUD_API"
      ) {
        const hasChannelOverride =
          !!requestedChannelId && requestedChannelId !== conv.channelId;
        const targetSession =
          hasChannelOverride && conv.contactId
            ? await getContactChannelSession(conv.contactId, outboundChannelRef.id)
            : await getConversationSession(conv);
        if (!targetSession.active) {
          return NextResponse.json(
            {
              message: "Sessão de 24h encerrada neste canal. Envie um template.",
              code: "SESSION_CLOSED",
            },
            { status: 409 },
          );
        }
      }
    }

    const senderName = authResult.user.name ?? authResult.user.email ?? "Agente";
    const replyRef = typeof b.replyToId === "string" ? b.replyToId.trim() : "";

    let replyToPreview: string | null = null;
    let replyParentInternalId: string | null = null;
    let replyContextWamid: string | null = null;
    if (replyRef) {
      const parent = await prisma.message.findFirst({
        where: {
          conversationId: conv.id,
          OR: [{ id: replyRef }, { externalId: replyRef }],
        },
        select: { id: true, content: true, externalId: true },
      });
      if (parent) {
        replyParentInternalId = parent.id;
        replyContextWamid = parent.externalId?.trim() || null;
        replyToPreview = parent.content.length > 120
          ? parent.content.slice(0, 117) + "…"
          : parent.content;
      }
    }

    if (isPrivateNote) {
      const saved = await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: conv.id,
          content,
          direction: "out",
          messageType: "note",
          isPrivate: true,
          senderName,
          replyToId: replyParentInternalId,
          replyToPreview,
        }),
      });

      // Activity Log: nota inserida pelo composer do Inbox. Antes deste
      // bloco o `return` abaixo curto-circuitava o `logEvent` que vem
      // depois (caminho de mensagem enviada), e a nota nao aparecia no
      // /logs. Resolvendo dealId via conversation->contact->open deal
      // para o feed conseguir filtrar pelo deal correspondente.
      void (async () => {
        const openDeal = conv.contactId
          ? await prisma.deal.findFirst({
              where: { contactId: conv.contactId, status: "OPEN" },
              select: { id: true },
              orderBy: { updatedAt: "desc" },
            }).catch(() => null)
          : null;

        // Persistir também na tabela `Note` — assim a nota escrita no chat
        // aparece no "histórico de notas" (aba Notas do deal/contato), que
        // lê `Note`, não `Message`. Sem isto a nota só existia como mensagem
        // interna e ficava invisível fora da conversa. Criamos direto via
        // prisma (sem createDealEvent) pra não duplicar o NOTE_ADDED que já
        // é logado logo abaixo.
        if (conv.contactId || openDeal?.id) {
          await prisma.note
            .create({
              data: withOrgFromCtx({
                content,
                contactId: conv.contactId ?? undefined,
                dealId: openDeal?.id ?? undefined,
                userId: authResult.user.id,
              }),
            })
            .catch(() => null);
        }

        await logEvent({
          type: "NOTE_ADDED",
          entityType: "MESSAGE",
          entityId: saved.id,
          entityLabel: senderName ?? "Nota interna",
          conversationId: conv.id,
          contactId: conv.contactId,
          dealId: openDeal?.id ?? null,
          meta: {
            preview: content.slice(0, 200),
            source: "inbox_composer",
            isPrivate: true,
          },
        });
      })();

      return NextResponse.json({
        message: {
          id: saved.id,
          content,
          createdAt: saved.createdAt.toISOString(),
          direction: "out",
          messageType: "note",
          isPrivate: true,
          senderName,
        } satisfies InboxMessageDto,
      }, { status: 201 });
    }

    // ── Send via Facebook Messenger / Instagram Direct ──
    // Branch antes do fluxo WhatsApp: canais IG/FB tem identificadores
    // (PSID/IGSID) e endpoints distintos e nao passam pelo getContactWhatsAppTargets.
    const messagingPlatform = platformFromConversationChannel(conv.channel);
    if (messagingPlatform) {
      const savedMsg = await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: conv.id,
          channelId: outboundChannelId ?? undefined,
          content,
          direction: "out",
          messageType: "text",
          senderName,
          replyToId: replyParentInternalId,
          replyToPreview,
        }),
      });

      const sendRes = await sendMessengerOrInstagramText({
        conversationId: conv.id,
        contactId: conv.contactId,
        channelRef: outboundChannelRef
          ? { id: outboundChannelRef.id, config: outboundChannelRef.config }
          : null,
        content,
        messageId: savedMsg.id,
        platform: messagingPlatform,
      });

      const channelLabel =
        messagingPlatform === "instagram" ? "Instagram" : "Messenger";

      try {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: {
            lastMessageDirection: "out",
            hasAgentReply: true,
            hasHumanReply: true,
            ...(sendRes.failed ? { hasError: true } : { hasError: false }),
          },
        });
      } catch { /* colunas opcionais */ }

      // Resposta do consultor libera vaga na fila (deixa de contar em
      // `getQueueCounts`) → drena a fila de espera sem esperar o cron.
      void import("@/services/distribution/pending")
        .then((m) =>
          m.scheduleProcessPendingDistributionQueue({
            trigger: "capacity_released",
            delayMs: 400,
          }),
        )
        .catch(() => {});

      void stopAutomationsAfterHumanReply(conv.contactId).then(() =>
        fireTrigger("message_sent", {
          contactId: conv.contactId,
          data: buildMessageTriggerData({
            channel: channelLabel,
            channelId: outboundChannelId,
            conversationId: conv.id,
            content,
          }),
        }).catch((err) => console.warn("[automation trigger] message_sent:", err)),
      );

      if (!sendRes.failed) {
        void logEvent({
          type: "MESSAGE_SENT",
          entityType: "MESSAGE",
          entityId: savedMsg.id,
          entityLabel: senderName ?? "Mensagem enviada",
          conversationId: conv.id,
          contactId: conv.contactId,
          meta: {
            preview: content.slice(0, 200),
            channel: channelLabel,
            via: "meta_messaging",
            externalId: sendRes.externalId,
          },
        });
      }

      try {
        sseBus.publish("new_message", {
          organizationId: conv.organizationId,
          conversationId: conv.id,
          contactId: conv.contactId,
          direction: "out",
          content,
          timestamp: savedMsg.createdAt,
        });
      } catch { /* best-effort */ }

      cancelPendingForConversation(conv.id, "agent_reply", authResult.user.id).catch(
        (err) =>
          console.warn(
            "[scheduled-messages] falha ao cancelar apos envio manual:",
            err,
          ),
      );

      return NextResponse.json(
        {
          message: {
            id: sendRes.externalId ?? savedMsg.id,
            content,
            createdAt: savedMsg.createdAt.toISOString(),
            direction: "out",
            messageType: "text",
            senderName,
            replyToId: replyParentInternalId,
            replyToPreview,
            status: sendRes.error ? "FAILED" : "SENT",
            channelId: outboundChannelId ?? null,
          } satisfies InboxMessageDto,
          conversationId: conv.id,
          ...(reopenedConversationId ? { reopenedConversationId } : {}),
          ...(sendRes.error ? { metaError: sendRes.error } : {}),
        },
        { status: 201 },
      );
    }

    // ── Send via WhatsApp (Meta Cloud API or Baileys) ──

    const useBaileys = isBaileysChannel(outboundChannelRef);

    const channelConfig = outboundChannelRef?.config as Record<string, unknown> | null | undefined;
    const metaClient = useBaileys ? metaWhatsApp : metaClientFromConfig(channelConfig);

    // Modo "local/test": sem canal WhatsApp configurado (conversas mock ou
    // ambiente de desenvolvimento sem Meta/Baileys). Ainda persistimos a
    // mensagem no banco para que o chat funcione localmente; apenas pulamos
    // o envio externo e avisamos via metaError.
    const localOnly = !useBaileys && !metaClient.configured;

    if (!useBaileys && !localOnly) {
      const waTarget = await getContactWhatsAppTargets(conv.contactId);
      if (!waTarget) {
        return NextResponse.json(
          { message: "Contato sem telefone nem BSUID WhatsApp (Meta)." },
          { status: 400 }
        );
      }
    }

    const saved = await prisma.message.create({
      data: withOrgFromCtx({
        conversationId: conv.id,
        channelId: outboundChannelId ?? undefined,
        content,
        direction: "out",
        messageType: "text",
        senderName,
        replyToId: replyParentInternalId,
        replyToPreview,
        ...(localOnly ? { sendStatus: "sent" } : {}),
      }),
    });

    if (!useBaileys && !localOnly) {
      const lastInbound = await prisma.message.findFirst({
        where: { conversationId: conv.id, direction: "in", externalId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { externalId: true },
      });
      if (lastInbound?.externalId) {
        metaClient.sendTypingIndicator(lastInbound.externalId).catch(() => {});
      }
    }

    const sendResult = localOnly
      ? { externalId: null as string | null, failed: false, error: undefined as string | undefined }
      : await sendWhatsAppText({
          conversationId: conv.id,
          contactId: conv.contactId,
          channelRef: outboundChannelRef,
          content,
          messageId: saved.id,
          replyContextWamid,
          waJid: conv.waJid,
        });

    const externalId = sendResult.externalId;
    const sendFailed = sendResult.failed;
    const sendErrorMsg = sendResult.error;

    // Update conversation tracking fields
    try {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          lastMessageDirection: "out",
          hasAgentReply: true,
          hasHumanReply: true,
          ...(sendFailed ? { hasError: true } : { hasError: false }),
        },
      });
    } catch { /* columns may not exist yet */ }

    // Resposta do consultor libera vaga na fila (deixa de contar em
    // `getQueueCounts`) → drena a fila de espera sem esperar o cron.
    void import("@/services/distribution/pending")
      .then((m) =>
        m.scheduleProcessPendingDistributionQueue({
          trigger: "capacity_released",
          delayMs: 400,
        }),
      )
      .catch(() => {});

    void stopAutomationsAfterHumanReply(conv.contactId).then(() =>
      fireTrigger("message_sent", {
        contactId: conv.contactId,
        data: buildMessageTriggerData({
          channel: "WhatsApp",
          channelId: outboundChannelId,
          conversationId: conv.id,
          content,
        }),
      }).catch((err) => console.warn("[automation trigger] message_sent:", err)),
    );

    // Log unificado de atividade (Activity Log) — fire-and-forget.
    // Falhas de envio sao registradas como MESSAGE_FAILED dentro de
    // sendWhatsAppText (markFailed) — aqui so logamos o sucesso para
    // nao duplicar o evento nem poluir as estatisticas.
    if (!sendFailed) {
      void logEvent({
        type: "MESSAGE_SENT",
        entityType: "MESSAGE",
        entityId: saved.id,
        entityLabel: senderName ?? "Mensagem enviada",
        conversationId: conv.id,
        contactId: conv.contactId,
        meta: {
          preview: content.slice(0, 200),
          channel: "WhatsApp",
          via: useBaileys ? "baileys" : localOnly ? "local" : "meta",
          externalId,
        },
      });
    }

    // Notifica abas/inboxes em tempo real: a conversa acabou de mudar de
    // 'esperando' para 'respondidas' (ou similar). Sem isso, a UI so
    // atualizava no proximo polling (15-20s) — usuario percebia delay.
    try {
      sseBus.publish("new_message", {
        organizationId: conv.organizationId,
        conversationId: conv.id,
        contactId: conv.contactId,
        direction: "out",
        content,
        timestamp: saved.createdAt,
      });
    } catch {
      // best-effort: nunca derruba o envio por falha de SSE.
    }

    // Agente enviou mensagem manual: cancela qualquer agendamento pendente
    // da conversa (convenção do "qualquer interação cancela"). Uso
    // cancelledById=null porque o cancelamento é automático, não manual.
    cancelPendingForConversation(conv.id, "agent_reply", authResult.user.id).catch(
      (err) =>
        console.warn(
          "[scheduled-messages] falha ao cancelar apos envio manual:",
          err,
        ),
    );
    // Humano respondeu: invalida debounce do Agente IA pendente.
    cancelAiReplyDebounce(conv.id, "human_outbound");

    return NextResponse.json({
      message: {
        id: externalId ?? saved.id,
        content,
        createdAt: saved.createdAt.toISOString(),
        direction: "out",
        messageType: "text",
        senderName,
        replyToId: replyParentInternalId,
        replyToPreview,
        status: sendErrorMsg ? "FAILED" : "SENT",
        channelId: outboundChannelId ?? null,
      } satisfies InboxMessageDto,
      conversationId: conv.id,
      ...(reopenedConversationId ? { reopenedConversationId } : {}),
      ...(sendErrorMsg ? { metaError: sendErrorMsg } : {}),
    }, { status: 201 });
    });
  } catch (e: unknown) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Erro ao enviar mensagem.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
