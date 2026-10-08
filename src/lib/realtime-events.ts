/**
 * Contrato dos eventos de tempo real (SSE `/api/sse/messages`).
 *
 * Este é o ÚNICO módulo da aplicação que chama `sseBus.publish`
 * (`realtime-contract.test.ts` falha se aparecer outro). Cada evento tem
 * um tipo de payload em `RealtimeEventMap` e um publisher tipado; o
 * frontend espelha os mesmos tipos em `src/lib/realtime-contract.ts`.
 *
 * Regras do contrato
 * ──────────────────
 * - Todo payload leva `organizationId`: o barramento descarta o evento
 *   sem org (fail-closed de multi-tenancy, ver `sse-bus.ts`).
 * - Nome de evento e campo existente não mudam: produção pode estar com
 *   um frontend mais antigo. Campo novo é sempre aditivo e opcional.
 * - O publisher repassa o payload como recebeu (sem renomear nem
 *   preencher campo). Quem acrescenta campo é o barramento:
 *     · `card` / `cardOmitted` em `new_message` e `conversation_updated`
 *       (`inbox-sse-card.ts`, gate por usuário na rota SSE);
 *     · `pipelineIds` / `dealIds` em `new_message` (escopo do board).
 *
 * Escopo do board em `new_message`
 * ────────────────────────────────
 * `pipelineIds`: pipelines onde o contato da mensagem tem negócio — só o
 * board desses funis muda. Lista vazia = nenhum board afetado.
 * `dealIds`: os negócios (cards) do contato nesses funis; ausente quando
 * a lista não é conhecida ou passa de 50.
 * Origem: o chamador informa quando já tem a lista COMPLETA de funis do
 * contato; senão o barramento usa o cache contato → pipelines de 60 s
 * (`board-invalidation.ts`), a mesma resolução que já decidia a purga do
 * cache do board — nenhuma consulta a mais por mensagem. Se a resolução
 * falha ou não dá para saber o contato, os campos NÃO vão no evento e o
 * cliente segue o caminho antigo (casa o card pelo `contactId`).
 * Não informe um funil só porque o chamador tem um negócio em mãos: a
 * prévia do card é por contato e os outros funis dele ficariam sem purga.
 *
 * Eventos (nome → payload → quem publica)
 * ───────────────────────────────────────
 * Ver `RealtimeEventMap` abaixo. `realtime-contract.test.ts` confere o
 * formato que cada publisher emite; a tabela com os chamadores de cada
 * evento está na descrição do PR do contrato (P-12).
 *
 * Fora deste contrato (transporte): `sse_access_revoked` (o barramento
 * fecha as conexões do usuário, `sseBus.revokeUser`) e
 * `sse_connection_evicted` (teto de conexões, escrito pela rota SSE).
 */
import type { EntityViewer } from "@/lib/entity-presence";
import { sseBus, type SsePublishOptions } from "@/lib/sse-bus";

/** Org do evento. `null`/`undefined` = o barramento descarta e loga. */
type OrgId = string | null | undefined;

// ── Mensagens ───────────────────────────────────────────────────────────

export type NewMessagePayload = {
  organizationId: OrgId;
  conversationId: string;
  /** Contato da conversa — o board casa o card por ele. */
  contactId?: string | null;
  direction: "in" | "out";
  /** Texto da prévia (legenda/descrição quando é mídia). */
  content?: string | null;
  /** Horário da mensagem; ausente = o cliente usa a chegada do evento. */
  timestamp?: Date | string;
  /** `text` implícito; `note`, `ai_draft`, `whatsapp_call_recording`, `event_*`… */
  messageType?: string | null;
  mediaUrl?: string | null;
  /** Agente remetente (saída manual). */
  senderName?: string | null;
  senderUserId?: string | null;
  /** Responsável da conversa no momento (entrada: aba e alerta). */
  assignedToId?: string | null;
  /** Pedido de catálogo do WhatsApp (entrada Meta). */
  catalogOrder?: unknown;
  /** Referral do anúncio Meta desta mensagem inbound. */
  referral?: unknown;
  /** Contatos compartilhados normalizados desta mensagem. */
  sharedContacts?: unknown;
  /** Escopo do board — ver cabeçalho. Só com a lista completa do contato. */
  pipelineIds?: string[];
  dealIds?: string[];
};

export type MessageStatusPayload = {
  organizationId: OrgId;
  conversationId: string;
  /** Id da bolha no cliente (externalId/wamid quando existe). */
  messageId: string;
  /** Id interno da mensagem; ausente no envio Baileys ainda sem linha. */
  internalId?: string;
  /** `pending` | `sent` | `delivered` | `read` | `failed`. */
  status: string;
  error?: string | null;
};

/** Rascunho da IA aprovado: a bolha deixa de ser rascunho. */
export type MessageUpdatedPayload = {
  organizationId: OrgId;
  conversationId: string;
  messageId: string;
  status: "approved";
};

/** Rascunho da IA descartado. */
export type MessageDeletedPayload = {
  organizationId: OrgId;
  conversationId: string;
  messageId: string;
};

// ── Conversas ───────────────────────────────────────────────────────────

/**
 * Mudança no card da conversa. Só vão os campos que mudaram; o cliente
 * faz patch do que veio. Status/responsável trocam a aba do inbox (o
 * barramento invalida os contadores nesses casos).
 */
export type ConversationUpdatedPayload = {
  organizationId: OrgId;
  conversationId: string;
  contactId?: string | null;
  status?: string;
  closedAt?: string | null;
  followUpAt?: string | null;
  assignedToId?: string | null;
  /**
   * Responsável. `type` (HUMAN/AI) decide a aba; `id`/`name` só vão quando o
   * publisher tem o usuário em mãos (atribuição/transferência) — aditivo.
   */
  assignedTo?: { type: string | null; id?: string; name?: string | null } | null;
  /** Departamento atual (`null` = sem departamento). Só em atribuição/transferência. */
  departmentId?: string | null;
  /** Responsável antes da troca (`null` = estava sem). Só em atribuição/transferência. */
  previousAssignedToId?: string | null;
  unreadCount?: number;
  /** Horário da última mensagem de chat (ISO); atribuir/transferir não o altera. */
  lastMessageAt?: string | null;
  whatsappCallConsentStatus?: string;
};

/** A timeline (chatter) da conversa ganhou um evento do tipo `type`. */
export type ConversationTimelineUpdatedPayload = {
  organizationId: OrgId;
  conversationId: string;
  /** Tipo do ActivityEvent: `CONVERSATION_CLOSED`, `ASSIGNEE_CHANGED`… */
  type: string;
};

/**
 * Transferência feita pela IA. Evento `conversation_assigned` quando há
 * novo responsável, `conversation_unassigned` quando voltou para a fila.
 */
export type ConversationAssignmentPayload = {
  organizationId: OrgId;
  conversationId: string;
  contactId?: string | null;
  assignedToId: string | null;
  reason?: string | null;
};

export type TypingEventPayload = {
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  /** Quem está digitando. `null` quando é o contato (canal Baileys). */
  userId: string | null;
  userName: string | null;
  source: "agent" | "contact";
  /** ISO: o cliente esconde o indicador quando passa deste instante. */
  until: string;
};

export type ScheduledMessageUpdatedPayload = {
  organizationId: string;
  conversationId: string;
  scheduledMessageId: string | null;
  /** Estado que motivou o evento. */
  status: "PENDING" | "CANCELLED" | "SENT" | "FAILED";
};

// ── Contato, chamadas, automação, canal ─────────────────────────────────

export type ContactUpdatedPayload = {
  organizationId: OrgId;
  contactId: string;
  /** `phone_changed` vem com `oldPhone`/`newPhone`. */
  reason?: string;
  oldPhone?: string | null;
  newPhone?: string | null;
  avatarUrl?: string | null;
};

export type WhatsappCallPayload = {
  organizationId: OrgId;
  conversationId: string;
  contactId?: string | null;
  callId: string;
  /** `connect`, `terminate`, `accepted_by_agent`… */
  event?: string;
  direction?: string;
  signalingStatus?: string;
  contactName?: string | null;
  fromWa?: string | null;
  /** Agente que deve tocar (chamada recebida roteada). */
  assignedToId?: string;
  /** SDP/sessão WebRTC repassada ao navegador. */
  session?: unknown;
};

export type AutomationStatePayload = {
  organizationId: OrgId;
  contactId: string | null;
  automationId: string | null;
  status: string | null;
  /** `status` é `RUNNING` ou `PAUSED`. */
  active: boolean;
  createdAt: string | null;
};

export type ChannelUpdatedPayload = {
  organizationId: OrgId;
  channelId: string;
  status?: string;
};

// ── Presença ────────────────────────────────────────────────────────────

/** Status de atendimento do agente (ONLINE/AWAY/OFFLINE). */
export type PresenceUpdatePayload = {
  organizationId: OrgId;
  userId: string;
  status: string;
};

/** Agente com o sistema aberto (heartbeat) ou não. */
export type SystemPresenceUpdatePayload = {
  organizationId: OrgId;
  userId: string;
  systemOnline: boolean;
  lastSeenAt: string;
};

/** Quem está com a entidade (negócio, conversa…) aberta. */
export type EntityViewersPayload = {
  organizationId: OrgId;
  entityType: string;
  entityId: string;
  viewers: EntityViewer[];
};

// ── Suporte interno e chat da equipe ────────────────────────────────────

export type SupportTicketPayload = {
  organizationId: OrgId;
  ticketId: string;
  status: string;
  requesterId?: string;
  assignedToId?: string | null;
  number?: number;
};

export type SupportMessagePayload = {
  organizationId: OrgId;
  ticketId: string;
  requesterId: string;
  assignedToId: string | null;
  message: unknown;
};

export type TeamChatEventName =
  | "team_chat_message"
  | "team_chat_room_updated"
  | "team_chat_typing"
  | "team_chat_work_item_updated"
  | "team_chat_forward_updated";

/**
 * Evento privado da sala: só chega a `audienceUserIds` (membership
 * resolvida no servidor). `memberIds` é dado para o cliente, não
 * autorização. Os demais campos dependem do evento (mensagem, sala…).
 */
export type TeamChatPayload = {
  organizationId: string;
  roomId?: string | null;
  memberIds: string[];
  [field: string]: unknown;
};

// ── Funil ───────────────────────────────────────────────────────────────

/**
 * Card enxuto do board, só para o cliente que ainda não tem o negócio
 * em cache (outro funil). Quem já tem o card reaproveita o objeto local
 * — `lastMessage` e não-lidas não viajam aqui.
 */
export type DealMovedCard = {
  id: string;
  title: string;
  value?: number | string;
  status?: string;
  lostReason?: string | null;
  position?: number;
  expectedClose?: string | null;
  createdAt?: string;
  updatedAt?: string;
  contact?: {
    id: string;
    name: string;
    email?: string | null;
    phone?: string | null;
    avatarUrl?: string | null;
  } | null;
  owner?: {
    id: string;
    name: string;
    avatarUrl?: string | null;
    type?: string | null;
  } | null;
  tags?: Array<{ id: string; name: string; color: string }>;
};

/**
 * Negócio mudou de etapa (ou de ordem na mesma etapa) e o banco já
 * commitou. `position` é a posição fracionária gravada, não o índice
 * que o cliente pediu. `card` é opcional: sem ele, quem não tem o
 * negócio em cache espera o polling.
 */
export type DealMovedPayload = {
  organizationId: OrgId;
  dealId: string;
  fromPipelineId: string;
  toPipelineId: string;
  fromStageId: string;
  toStageId: string;
  position: number;
  updatedAt: string;
  /**
   * Dono do negócio (`null` = sem dono). A rota SSE usa para entregar o
   * `card` só a quem vê o negócio (mesma regra do GET /api/deals/:id) e
   * tira o campo de quem não vê. Aditivo/opcional: ausente = desconhecido
   * (o gate trata como "não vejo" para quem só vê os próprios).
   */
  ownerId?: string | null;
  /** Unidade (filial) do negócio, quando conhecida. Aditivo/opcional. */
  orgUnitId?: string | null;
  card?: DealMovedCard;
};

// ── União discriminada ──────────────────────────────────────────────────

export type RealtimeEventMap = {
  new_message: NewMessagePayload;
  message_status: MessageStatusPayload;
  message_updated: MessageUpdatedPayload;
  message_deleted: MessageDeletedPayload;
  conversation_updated: ConversationUpdatedPayload;
  conversation_timeline_updated: ConversationTimelineUpdatedPayload;
  conversation_assigned: ConversationAssignmentPayload;
  conversation_unassigned: ConversationAssignmentPayload;
  typing: TypingEventPayload;
  scheduled_message_updated: ScheduledMessageUpdatedPayload;
  contact_updated: ContactUpdatedPayload;
  whatsapp_call: WhatsappCallPayload;
  automation_state: AutomationStatePayload;
  channel_updated: ChannelUpdatedPayload;
  presence_update: PresenceUpdatePayload;
  system_presence_update: SystemPresenceUpdatePayload;
  entity_viewers: EntityViewersPayload;
  support_ticket_new: SupportTicketPayload;
  support_ticket_updated: SupportTicketPayload;
  support_message: SupportMessagePayload;
  team_chat_message: TeamChatPayload;
  team_chat_room_updated: TeamChatPayload;
  team_chat_typing: TeamChatPayload;
  team_chat_work_item_updated: TeamChatPayload;
  team_chat_forward_updated: TeamChatPayload;
  deal_moved: DealMovedPayload;
};

export type RealtimeEventName = keyof RealtimeEventMap;

/** `{ event, data }` com `data` estreitado pelo nome do evento. */
export type RealtimeEvent = {
  [E in RealtimeEventName]: { event: E; data: RealtimeEventMap[E] };
}[RealtimeEventName];

/** Nomes do contrato, para testes e para o espelho do frontend. */
export const REALTIME_EVENT_NAMES = [
  "new_message",
  "message_status",
  "message_updated",
  "message_deleted",
  "conversation_updated",
  "conversation_timeline_updated",
  "conversation_assigned",
  "conversation_unassigned",
  "typing",
  "scheduled_message_updated",
  "contact_updated",
  "whatsapp_call",
  "automation_state",
  "channel_updated",
  "presence_update",
  "system_presence_update",
  "entity_viewers",
  "support_ticket_new",
  "support_ticket_updated",
  "support_message",
  "team_chat_message",
  "team_chat_room_updated",
  "team_chat_typing",
  "team_chat_work_item_updated",
  "team_chat_forward_updated",
  "deal_moved",
] as const satisfies readonly RealtimeEventName[];

/** Único ponto que fala com o barramento. */
function publish<E extends RealtimeEventName>(
  event: E,
  data: RealtimeEventMap[E],
  opts?: SsePublishOptions,
): void {
  if (opts) sseBus.publish(event, data, opts);
  else sseBus.publish(event, data);
}

// ── Publishers: mensagens ───────────────────────────────────────────────

/**
 * Mensagem nova na conversa (entrada, saída, nota, rascunho da IA,
 * linha de chamada). O barramento anexa `card` e o escopo do board.
 */
export function publishNewMessage(payload: NewMessagePayload): void {
  publish("new_message", payload);
}

/**
 * Atalho do envio pelo CRM: mensagem de saída recém-gravada. Best-effort
 * — falha de SSE nunca derruba o envio.
 */
export function publishOutboundNewMessage(
  conv: { id: string; organizationId: string; contactId: string | null },
  content: string,
  timestamp: Date,
): void {
  try {
    publishNewMessage({
      organizationId: conv.organizationId,
      conversationId: conv.id,
      contactId: conv.contactId,
      direction: "out",
      content,
      timestamp,
    });
  } catch {
    /* best-effort */
  }
}

/** Tick da mensagem (enviada → entregue → lida → falhou). */
export function publishMessageStatus(payload: MessageStatusPayload): void {
  publish("message_status", payload);
}

export function publishMessageUpdated(payload: MessageUpdatedPayload): void {
  publish("message_updated", payload);
}

export function publishMessageDeleted(payload: MessageDeletedPayload): void {
  publish("message_deleted", payload);
}

// ── Publishers: conversas ───────────────────────────────────────────────

export function publishConversationUpdated(
  payload: ConversationUpdatedPayload,
): void {
  publish("conversation_updated", payload);
}

/**
 * Board: um negócio já está na etapa/posição novas (ou trocou de dono, ou foi
 * a Ganho/Perdido). Publicado por `moveDeal`, pela automação e pelos lotes
 * pequenos (até `DEAL_MOVED_BATCH_LIMIT` negócios, via
 * `syncBoardsAfterDealChanges`); acima do teto só o cache do board é
 * invalidado e o quadro converge na próxima leitura. Mudança de dono sem
 * troca de etapa sai com `fromStageId === toStageId`. Best-effort: falha de
 * Redis/SSE não desfaz a gravação.
 */
export function publishDealMoved(payload: DealMovedPayload): void {
  try {
    publish("deal_moved", payload);
  } catch {
    /* best-effort */
  }
}

export function publishConversationTimelineUpdated(
  payload: ConversationTimelineUpdatedPayload,
): void {
  publish("conversation_timeline_updated", payload);
}

/**
 * `conversation_assigned` quando `assignedToId` tem valor,
 * `conversation_unassigned` quando é `null` (voltou para a fila).
 */
export function publishConversationAssignment(
  payload: ConversationAssignmentPayload,
): void {
  publish(
    payload.assignedToId ? "conversation_assigned" : "conversation_unassigned",
    payload,
  );
}

/** Janela mínima entre dois `typing` do mesmo agente na mesma conversa. */
export const TYPING_THROTTLE_MS = 3_000;
/** Quanto tempo o cliente mostra "digitando…" a partir de cada evento. */
export const TYPING_TTL_MS = 5_000;

// `${conversationId}:${source}:${userId}` → epoch ms do último evento
// publicado. Chave por agente (e não só por conversa) de propósito: dois
// agentes digitando ao mesmo tempo na mesma conversa precisam aparecer um
// para o outro; com a chave só por conversa o segundo cairia sempre no
// throttle do primeiro. A origem entra na chave para o contato
// (`source: "contact"`, sem `userId`) ter a própria janela e nunca
// disputar com um agente.
const lastTypingAt = new Map<string, number>();
const TYPING_MAP_PRUNE_AT = 2_000;

function pruneTypingMap(now: number): void {
  if (lastTypingAt.size < TYPING_MAP_PRUNE_AT) return;
  for (const [key, at] of lastTypingAt) {
    if (now - at > TYPING_THROTTLE_MS) lastTypingAt.delete(key);
  }
}

/** Só para testes: zera o throttle. */
export function __resetTypingThrottleForTests(): void {
  lastTypingAt.clear();
}

/**
 * Publica `typing` para a org, no máximo 1 a cada `TYPING_THROTTLE_MS`
 * por (conversa, origem, agente). Devolve `true` quando publicou. Para os
 * OUTROS agentes (o cliente ignora o próprio `userId`); `until` = agora +
 * 5 s. `source: "contact"` (`userId`/`userName` nulos) vem do worker
 * Baileys (`workers/baileys/contact-typing.ts`); o webhook da Meta não
 * publica.
 */
export function publishTypingEvent(args: {
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  userId: string | null;
  userName?: string | null;
  source?: "agent" | "contact";
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  const source = args.source ?? "agent";
  const key = `${args.conversationId}:${source}:${args.userId ?? ""}`;
  const last = lastTypingAt.get(key);
  if (last !== undefined && now - last < TYPING_THROTTLE_MS) return false;
  lastTypingAt.set(key, now);
  pruneTypingMap(now);

  const payload: TypingEventPayload = {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    userId: args.userId,
    userName: args.userName?.trim() || null,
    source,
    until: new Date(now + TYPING_TTL_MS).toISOString(),
  };
  publish("typing", payload);
  return true;
}

/**
 * Publica `scheduled_message_updated` — a lista de agendamentos pendentes
 * da conversa mudou (criado, cancelado, enviado ou falhou). O cliente só
 * invalida a query; não há payload de item.
 */
export function publishScheduledMessageUpdated(args: {
  organizationId: string | null | undefined;
  conversationId: string;
  scheduledMessageId?: string | null;
  status: ScheduledMessageUpdatedPayload["status"];
}): void {
  if (!args.organizationId) return;
  const payload: ScheduledMessageUpdatedPayload = {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    scheduledMessageId: args.scheduledMessageId ?? null,
    status: args.status,
  };
  publish("scheduled_message_updated", payload);
}

// ── Publishers: contato, chamadas, automação, canal ─────────────────────

export function publishContactUpdated(payload: ContactUpdatedPayload): void {
  publish("contact_updated", payload);
}

export function publishWhatsappCall(payload: WhatsappCallPayload): void {
  publish("whatsapp_call", payload);
}

export function publishAutomationState(payload: AutomationStatePayload): void {
  publish("automation_state", payload);
}

export function publishChannelUpdated(payload: ChannelUpdatedPayload): void {
  publish("channel_updated", payload);
}

// ── Publishers: presença ────────────────────────────────────────────────

export function publishPresenceUpdate(payload: PresenceUpdatePayload): void {
  publish("presence_update", payload);
}

export function publishSystemPresenceUpdate(
  payload: SystemPresenceUpdatePayload,
): void {
  publish("system_presence_update", payload);
}

export function publishEntityViewers(payload: EntityViewersPayload): void {
  publish("entity_viewers", payload);
}

// ── Publishers: suporte interno e chat da equipe ────────────────────────

export function publishSupportTicketNew(payload: SupportTicketPayload): void {
  publish("support_ticket_new", payload);
}

export function publishSupportTicketUpdated(
  payload: SupportTicketPayload,
): void {
  publish("support_ticket_updated", payload);
}

export function publishSupportMessage(payload: SupportMessagePayload): void {
  publish("support_message", payload);
}

/**
 * Evento do chat da equipe para a audiência informada. Sem audiência o
 * barramento descarta (fail-closed). A membership é resolvida por quem
 * chama (`publishTeamChatEvent` em `services/team-chat.ts`).
 */
export function publishTeamChat(
  event: TeamChatEventName,
  payload: TeamChatPayload,
  audienceUserIds: string[],
): void {
  publish(event, payload, { audienceUserIds });
}
