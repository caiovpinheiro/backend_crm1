import { createHash } from "crypto";
import { Prisma, type ConversationStatus } from "@prisma/client";

import type { AppUserRole } from "@/lib/auth-types";
import { cache } from "@/lib/cache";
import { inboxTabCountsKey, invalidateInboxTabCounts } from "@/lib/cache/keys";
import {
  resolveConversationId,
  userHasConversationAccess,
} from "@/lib/conversation-access";
import { canRoleSelfAssign } from "@/lib/self-assign";
import { prettifyChatMessageBody } from "@/lib/whatsapp-outbound-template-label";
import { allocateOrgNumber, prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  countableReplyWhere,
  countAgentReplyAsAnswered,
  inboxCardGroupKey,
  noCountableReplyWhere,
} from "@/lib/conversation-reply-marking";
import {
  getOrgIdOrNull,
  getOrgIdOrThrow,
  getRequestContext,
} from "@/lib/request-context";
import { sseBus } from "@/lib/sse-bus";
import { logEvent } from "@/services/activity-log";
import { enrichContactsWithUserAvatarFallback } from "@/lib/contact-avatar-fallback";
import { parseSessionResetAt } from "@/lib/channel-session";
import { parseInboxFilterChannelIds } from "@/services/channels";
import {
  findContactIdsByPhoneDigits,
  resolveConversationSearchCandidates,
  SOURCE_NONE,
} from "@/services/kanban-filters";
import { normalizeHoursBeforeExpiry, WHATSAPP_SESSION_WINDOW_MS } from "@/services/whatsapp-session-expiry";

/**
 * Frescura dos badges vem da invalidação (mensagem nova via `sse-bus`,
 * mudança de status aqui, jobs de bulk), não do TTL. Com TTL de 5s o refetch
 * que o SSE dispara ~1s depois caía fora da janela em ~metade das vezes e
 * recomputava a agregação (1,2-2,3s medidos em produção). O TTL agora é só
 * rede de segurança contra invalidação perdida.
 */
const TAB_COUNTS_CACHE_TTL_SEC = 30;

/** Int4 Postgres — ticket `number` não pode ultrapassar isso na query. */
const PG_INT4_MAX = 2_147_483_647;

/** Abas de categoria (filtro OR em "Todos" para membros com escopo limitado). */
export const INBOX_CATEGORY_TABS = [
  "entrada",
  "esperando",
  "respondidas",
  "agente_ia",
  "automacao",
  "finalizados",
  "erro",
] as const;

export type InboxCategoryTab = (typeof INBOX_CATEGORY_TABS)[number];
/**
 * `abertas` = TODAS as conversas em aberto (status OPEN), sem subdividir por
 * categoria e excluindo as Resolvidas. Igual a `todos`, é um "super-tab" e não
 * uma categoria (não entra em `INBOX_CATEGORY_TABS`).
 *
 * `ligar` = fila de trabalho de WhatsApp com opt-in de voz ativo (GRANTED e
 * não expirado). Também não é categoria: a conversa continua em
 * Entrada/Aguardando/Respondidas, mas a aba aparece na barra da Inbox.
 */
export type InboxTab = InboxCategoryTab | "todos" | "abertas" | "ligar";

export type GetConversationsParams = {
  contactId?: string;
  status?: ConversationStatus;
  channel?: string;
  /** IDs de instância de Channel (e sentinelas `__missing__:` / `__deleted__`). */
  channelIds?: string[];
  tab?: InboxTab;
  /**
   * Com `tab: "todos"` e papel MEMBER: OR destas categorias (só o que o
   * utilizador pode ver). Omitir para ADMIN/MANAGER (todas as conversas
   * visíveis, só `visibilityWhere`).
   */
  todosCategoryTabs?: InboxCategoryTab[];
  /** Busca: nome/telefone/ticket/etc. Combinada em AND com a aba (não substitui). */
  search?: string;
  page?: number;
  perPage?: number;
  visibilityWhere?: Prisma.ConversationWhereInput;
  ownerId?: string;
  /** Multi-seleção de responsáveis (OR). Preferir sobre `ownerId`. */
  ownerIds?: string[];
  /** true = só conversas sem responsável (`assignedToId` null). */
  withoutOwner?: boolean;
  stageId?: string;
  /** Multi-seleção de etapas (OR). Preferir sobre `stageId`. */
  stageIds?: string[];
  tagIds?: string[];
  /** Origens do contato (Contact.source). Pode incluir `SOURCE_NONE`. */
  sources?: string[];
  /** true = só conversas cujo contato não tem origem. */
  withoutSource?: boolean;
  sortBy?: "updatedAt" | "createdAt" | "unreadCount";
  sortOrder?: "asc" | "desc";
  /**
   * Escopo de canais por usuário (IDs de `Channel`). `null/undefined` → sem
   * restrição; array (mesmo vazio) → restringe conversas a esses canais.
   */
  allowedChannelIds?: string[] | null;
  /** Sessões Meta ainda abertas que expiram entre agora e agora + X horas. */
  sessionExpiresWithinHours?: number;
  /** IDs resolvidos pelo agregador contato+canal antes de montar o where. */
  sessionExpiringConversationIds?: string[];
  /**
   * Filtro de status da UI (Aberta/Fechada). Tem de ir no mesmo `where`
   * da lista, dos badges e do bulk — se ficar só no cliente, Erro mostra
   * lista vazia com badge 233.
   */
  windowState?: "open" | "closed";
};

const listSelect = {
  id: true,
  number: true,
  externalId: true,
  channel: true,
  status: true,
  inboxName: true,
  unreadCount: true,
  hasError: true,
  lastInboundAt: true,
  lastMessageDirection: true,
  closedAt: true,
  updatedAt: true,
  createdAt: true,
  assignedToId: true,
  departmentId: true,
  department: { select: { id: true, name: true, requireTabulationOnClose: true } },
  tabulationId: true,
  assignedTo: {
    select: { id: true, name: true, email: true, avatarUrl: true, type: true },
  },
  contact: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      avatarUrl: true,
      tags: {
        select: {
          tag: { select: { id: true, name: true, color: true } },
        },
      },
      // `deals.tags` removido: o card/header usa só tags do contato.
      // Tags do negócio vêm pelo detalhe do deal quando necessário.
    },
  },
} satisfies Prisma.ConversationSelect;

export type ConversationLastMessagePreview = {
  content: string;
  messageType: string;
  mediaUrl: string | null;
  direction: string;
  /** Ack de entrega (só relevante para direction=out). */
  sendStatus: string | null;
  /** Motivo da falha quando sendStatus=failed. */
  sendError: string | null;
};

export type ConversationTag = {
  id: string;
  name: string;
  color: string;
};

export type ConversationListItem = Prisma.ConversationGetPayload<{
  select: typeof listSelect;
}> & {
  lastMessagePreview: ConversationLastMessagePreview | null;
  lastMessageAt: Date | null;
  tags: ConversationTag[];
};

async function lastInboundBatch(
  conversationIds: string[]
): Promise<Map<string, Date>> {
  if (conversationIds.length === 0) return new Map();
  const orgId = getOrgIdOrThrow();
  // Janela de 24h e' do CONTATO (regra da Meta), nao do ticket: um ticket
  // recem-aberto (reopen/resposta pos-encerramento) nasce sem inbound, mas
  // o cliente pode ter escrito minutos atras no ticket anterior. Agrega o
  // ultimo inbound de QUALQUER conversa do mesmo contato+canal.
  const rows = await prisma.$queryRaw<{ conversationId: string; lastIn: Date }[]>`
    SELECT c."id" AS "conversationId", MAX(m."createdAt") AS "lastIn"
    FROM "conversations" c
    JOIN "conversations" c2
      ON c2."contactId" = c."contactId"
     AND c2."channel" = c."channel"
     AND c2."organizationId" = c."organizationId"
    JOIN "messages" m
      ON m."conversationId" = c2."id"
     AND m."direction" = 'in'
    WHERE c."id" = ANY(${conversationIds})
      AND c."organizationId" = ${orgId}
    GROUP BY c."id"
  `;
  const map = new Map<string, Date>();
  for (const r of rows) {
    map.set(r.conversationId, r.lastIn);
  }
  await applyChannelSessionResetToInboundMap(conversationIds, map);
  return map;
}

/** Inbound anterior à troca de phoneNumberId/WABA não reabre a janela 24h. */
async function applyChannelSessionResetToInboundMap(
  conversationIds: string[],
  map: Map<string, Date>,
): Promise<void> {
  if (map.size === 0) return;
  const convs = await prisma.conversation.findMany({
    where: { id: { in: conversationIds } },
    select: { id: true, channelRef: { select: { config: true } } },
  });
  for (const c of convs) {
    const resetAt = parseSessionResetAt(c.channelRef?.config);
    if (!resetAt) continue;
    const lastIn = map.get(c.id);
    if (lastIn && lastIn.getTime() < resetAt.getTime()) {
      map.delete(c.id);
    }
  }
}

async function lastMessagePreviewsBatch(
  conversationIds: string[]
): Promise<Map<string, { preview: ConversationLastMessagePreview; createdAt: Date }>> {
  if (conversationIds.length === 0) return new Map();
  const orgId = getOrgIdOrThrow();

  const rows = await prisma.$queryRaw<{
    conversationId: string;
    content: string;
    messageType: string;
    mediaUrl: string | null;
    direction: string;
    sendStatus: string | null;
    sendError: string | null;
    createdAt: Date;
  }[]>`
    SELECT DISTINCT ON ("conversationId")
      "conversationId", "content", "messageType", "mediaUrl", "direction",
      "sendStatus", "sendError", "createdAt"
    FROM "messages"
    WHERE "conversationId" = ANY(${conversationIds})
      AND "organizationId" = ${orgId}
      -- Mesma regra do board: preview = chat real, não nota/sistema.
      AND "isPrivate" = false
      AND "messageType" NOT IN (
        'note',
        'ai_draft',
        'whatsapp_call',
        'whatsapp_call_recording'
      )
      AND "messageType" NOT LIKE 'event%'
      AND direction IN ('in', 'out')
    ORDER BY "conversationId", "createdAt" DESC
  `;

  const map = new Map<string, { preview: ConversationLastMessagePreview; createdAt: Date }>();
  for (const r of rows) {
    const text = prettifyChatMessageBody(r.content ?? "").trim();
    map.set(r.conversationId, {
      preview: {
        content: text.length > 140 ? `${text.slice(0, 137)}…` : text,
        messageType: r.messageType || "text",
        mediaUrl: r.mediaUrl ?? null,
        direction: r.direction || "in",
        sendStatus: r.sendStatus ?? null,
        sendError: r.sendError ?? null,
      },
      createdAt: r.createdAt,
    });
  }
  return map;
}

function buildConversationSourceCondition(
  sources?: string[],
  withoutSource?: boolean,
): Prisma.ConversationWhereInput | null {
  const real = (sources ?? []).filter((s) => s && s !== SOURCE_NONE);
  const wantNone = withoutSource === true || (sources ?? []).includes(SOURCE_NONE);
  const or: Prisma.ConversationWhereInput[] = [];
  if (real.length) or.push({ contact: { source: { in: real } } });
  if (wantNone) {
    or.push({
      OR: [
        { contactId: null },
        { contact: { is: { source: null } } },
        { contact: { is: { source: "" } } },
      ],
    });
  }
  if (or.length === 0) return null;
  return or.length === 1 ? or[0] : { OR: or };
}

/**
 * Contexto de automação ainda "vivo" no contato: RUNNING (executando) ou
 * PAUSED (aguardando reply/botão — típico pós-template de campanha).
 * Entrada só excluía RUNNING; PAUSED sem dono caía em Entrada e poluía a
 * fila dos consultores após disparos AUTOMATION.
 */
const ACTIVE_AUTOMATION_CTX: Prisma.EnumAutomationCtxStatusFilter = {
  in: ["RUNNING", "PAUSED"],
};

/** Cliente ainda não falou — template/campanha depois do inbound não conta. */
const NEVER_REPLIED: Prisma.ConversationWhereInput = {
  lastInboundAt: null,
};

function tabToWhere(
  tab: InboxCategoryTab,
  countAgentReply = false,
): Prisma.ConversationWhereInput {
  switch (tab) {
    case "entrada":
      // Entrada = (1) sem dono e fora do robô, OU (2) já com consultor
      // humano aguardando a 1ª msg dele, OU (3) sem dono após redistribuição
      // manual com fila cheia (hasHumanReply=true — antes sumia das abas).
      // Aguardando exige assignee + reply humano; aqui o último inbound é do
      // cliente e o consultor precisa ver. Com countAgentReplyAsAnswered,
      // “já houve reply” também inclui hasAgentReply.
      // Em (2) NÃO exigimos “sem RUNNING”: no handoff “Falar com equipe” o
      // contexto PIPE pode ainda estar RUNNING por um instante.
      // Assignee IA NÃO entra aqui: tem aba própria (`agente_ia`). O card
      // volta para Entrada quando o handoff libera o responsável (fila de
      // espera) ou atribui um consultor.
      return {
        status: "OPEN",
        hasError: false,
        OR: [
          {
            ...noCountableReplyWhere(countAgentReply),
            OR: [
              {
                // Sem inbound = só disparo/órfão — não é Entrada (aparece
                // quando o aluno responder e lastInboundAt for setado).
                assignedToId: null,
                lastInboundAt: { not: null },
              },
              { assignedTo: { is: { type: "HUMAN" } } },
            ],
          },
          {
            ...countableReplyWhere(countAgentReply),
            assignedToId: null,
          },
        ],
      };
    case "esperando":
      // "Aguardando" = já teve atendimento (humano; + agente se setting) e o
      // cliente falou por último (`lastMessageDirection = "in"`).
      // Só assignee HUMANO: com a IA como responsável o card fica em
      // `agente_ia` até o handoff.
      return {
        status: "OPEN",
        assignedTo: { is: { type: "HUMAN" } },
        AND: [countableReplyWhere(countAgentReply)],
        lastMessageDirection: "in",
        hasError: false,
      };
    case "respondidas":
      // "Respondidas" = já teve atendimento e nós falamos por último
      // (`lastMessageDirection = "out"`). Com setting OFF, só hasHumanReply
      // (aviso automático da distribuição sem reply humano fica em Entrada).
      // Assignee IA fica em `agente_ia`.
      return {
        status: "OPEN",
        assignedTo: { is: { type: "HUMAN" } },
        AND: [countableReplyWhere(countAgentReply)],
        lastMessageDirection: "out",
        hasError: false,
      };
    case "agente_ia":
      // Fila do Agente IA: TODA conversa em aberto cujo responsável é um
      // usuário `type: AI`, tenha o aluno falado ou não. Sai daqui quando o
      // handoff atribui um consultor OU libera o responsável (fila de
      // espera) — em ambos os casos o card cai em Entrada.
      return {
        status: "OPEN",
        hasError: false,
        assignedTo: { is: { type: "AI" } },
      };
    case "automacao":
      // Robô ativo (RUNNING ou PAUSED) sem dono e sem nenhuma resposta do
      // cliente. Quem já falou (lastInboundAt) vai para Entrada —
      // campanha/template posterior não devolve o card pra cá. Assignee IA
      // tem aba própria (`agente_ia`); consultor humano vai para
      // Entrada/Aguardando mesmo se o PIPE ainda não encerrou.
      return {
        status: "OPEN",
        assignedToId: null,
        AND: [NEVER_REPLIED],
        contact: {
          automationContexts: {
            some: { status: ACTIVE_AUTOMATION_CTX },
          },
        },
      };
    case "finalizados":
      return { status: "RESOLVED" };
    case "erro":
      return erroTabWhere();
    default: {
      const _exhaustive: never = tab;
      return _exhaustive;
    }
  }
}

/**
 * Predicado único da aba Erro — lista, badges e bulk-resolve.
 * Só OPEN + hasError. Encerrar (individual ou massa) zera a flag;
 * RESOLVED com hasError sticky não entra.
 *
 * Códigos Meta de elegibilidade (131047, 131049, 131026, 130472, 133010)
 * deixam de marcar hasError em envios novos, mas NÃO são excluídos
 * daqui: tickets já flagados continuam visíveis até encerrar. Excluir
 * só do badge (e não da lista) recria o 233 zumbi.
 */
export function erroTabWhere(): Prisma.ConversationWhereInput {
  return { status: "OPEN", hasError: true };
}

/** WhatsApp OPEN com permissão de ligação ativa (permanente ou TTL vigente). */
export function ligarTabWhere(): Prisma.ConversationWhereInput {
  return {
    status: "OPEN",
    channel: "whatsapp",
    hasError: false,
    whatsappCallConsentStatus: "GRANTED",
    OR: [
      { whatsappCallConsentExpiresAt: null },
      { whatsappCallConsentExpiresAt: { gt: new Date() } },
    ],
  };
}

/**
 * Condições OR da busca textual (nome, telefone, ticket #, etc.).
 * Extraído para reuso entre listagem e contadores — busca e aba/filtros
 * devem ser aplicados em AND (nunca um exclui o outro).
 */
export async function buildConversationSearchWhere(
  search: string | undefined | null,
): Promise<Prisma.ConversationWhereInput | null> {
  const q = search?.trim() ?? "";
  if (q.length === 0) return null;

  // O `where` final só toca colunas de `conversations`. Tudo que exige join
  // (contato, empresa, campos personalizados, título de negócio, responsável)
  // é resolvido antes em pré-queries indexadas — ver
  // `resolveConversationSearchCandidates`. Agrupar os predicados por join,
  // como fazíamos até 26/ago/26, reduziu o número de LEFT JOINs mas manteve
  // ILIKE cross-table e EXISTS por linha no mesmo OR: 4s por busca em prod.
  const or: Prisma.ConversationWhereInput[] = [
    { inboxName: { contains: q, mode: "insensitive" } },
  ];

  // Telefone parcial por dígitos (ignora +, espaços, DDI): "11945" casa
  // "+55 11 94501-0493". Mesma regra de deals/contatos/kanban.
  const digits = q.replace(/\D+/g, "");
  const [candidates, phoneContactIds] = await Promise.all([
    resolveConversationSearchCandidates(q),
    digits.length >= 3 ? findContactIdsByPhoneDigits(digits) : Promise.resolve([]),
  ]);

  const contactIds = new Set([...candidates.contactIds, ...phoneContactIds]);
  if (contactIds.size > 0) {
    or.push({ contactId: { in: [...contactIds] } });
  }
  if (candidates.assignedToIds.length > 0) {
    or.push({ assignedToId: { in: candidates.assignedToIds } });
  }
  // Busca pelo #número do ticket ("1234" ou "#1234") — match exato.
  // Só Int4 válido: telefone completo (11 dígitos) estoura o Int e quebrava
  // a query inteira (loading longo + zero resultados).
  const numeric = q.replace(/^#/, "");
  if (/^\d+$/.test(numeric)) {
    const n = Number(numeric);
    if (Number.isInteger(n) && n >= 0 && n <= PG_INT4_MAX) {
      or.push({ number: n });
    }
  }
  return { OR: or };
}

function tabFilterWhere(
  tab: InboxTab,
  todosCategoryTabs?: InboxCategoryTab[],
  countAgentReply = false,
): Prisma.ConversationWhereInput | null {
  if (tab === "todos") {
    if (todosCategoryTabs && todosCategoryTabs.length > 0) {
      return {
        OR: todosCategoryTabs.map((t) => tabToWhere(t, countAgentReply)),
      };
    }
    return null;
  }
  if (tab === "abertas") return { status: "OPEN" };
  if (tab === "ligar") return ligarTabWhere();
  return tabToWhere(tab, countAgentReply);
}

/**
 * Monta o `where` da listagem de conversas (visibilidade + busca/aba +
 * filtros). Extraído de `getConversations` para ser reaproveitado pelo
 * encerramento em massa "por filtro" (`getResolvableConversationIds`),
 * garantindo que a seleção "todas do filtro" case exatamente com a lista.
 *
 * Busca e aba são AND: com termo digitado, a aba continua filtrando
 * (ex.: Encerradas + telefone). Antes a busca substituía a aba e o
 * operador via conversa RESOLVED dentro de "Entrada".
 */
export async function buildConversationListWhere(
  params: GetConversationsParams,
): Promise<Prisma.ConversationWhereInput> {
  const conditions: Prisma.ConversationWhereInput[] = [];

  if (params.visibilityWhere && Object.keys(params.visibilityWhere).length > 0) {
    conditions.push(params.visibilityWhere);
  }

  const searchWhere = await buildConversationSearchWhere(params.search);
  if (searchWhere) conditions.push(searchWhere);

  const countAgentReply = await countAgentReplyAsAnswered();
  if (params.tab) {
    const tabWhere = tabFilterWhere(
      params.tab,
      params.todosCategoryTabs,
      countAgentReply,
    );
    if (tabWhere) conditions.push(tabWhere);
  }
  if (params.status && !params.tab) conditions.push({ status: params.status });
  if (params.allowedChannelIds) {
    conditions.push({ channelId: { in: params.allowedChannelIds } });
  }
  const filterWhere = buildInboxFilterConditions(params);
  conditions.push(...filterWhere);

  return conditions.length > 0 ? { AND: conditions } : {};
}

const CONVERSATION_CHANNEL_TYPES = new Set([
  "whatsapp",
  "instagram",
  "meta",
  "facebook",
  "telegram",
  "email",
  "webchat",
  "messaging",
  "whatsapp_meta",
  "meta_whatsapp",
]);

function isConversationChannelType(value: string): boolean {
  return CONVERSATION_CHANNEL_TYPES.has(value.toLowerCase());
}

function buildChannelInstanceFilter(
  channelIds: string[] | undefined,
): Prisma.ConversationWhereInput | null {
  if (!channelIds?.length) return null;
  const parsed = parseInboxFilterChannelIds(channelIds);
  const branches: Prisma.ConversationWhereInput[] = [];
  if (parsed.channelIds.length > 0) {
    branches.push({ channelId: { in: parsed.channelIds } });
  }
  if (parsed.missingInboxNames.length > 0) {
    branches.push({
      channelId: null,
      inboxName: { in: parsed.missingInboxNames },
    });
  }
  if (parsed.includeUnnamedDeleted) {
    branches.push({
      channelId: null,
      OR: [{ inboxName: null }, { inboxName: "" }],
    });
  }
  if (branches.length === 0) return null;
  if (branches.length === 1) return branches[0] ?? null;
  return { OR: branches };
}

/**
 * Condições dos FILTROS do inbox (funil): responsável, estágio, tags, origem,
 * canal e contato. NÃO inclui aba/busca/visibilidade — isso permite reaproveitar
 * o MESMO recorte tanto na listagem quanto na CONTAGEM por aba (para os
 * contadores refletirem o filtro ativo). Retorna um array de condições (AND).
 */
export function buildInboxFilterConditions(
  params: GetConversationsParams,
): Prisma.ConversationWhereInput[] {
  const conditions: Prisma.ConversationWhereInput[] = [];
  if (params.contactId) conditions.push({ contactId: params.contactId });
  if (params.channel) {
    if (isConversationChannelType(params.channel)) {
      conditions.push({ channel: params.channel });
    } else {
      const asInstance = buildChannelInstanceFilter([params.channel]);
      if (asInstance) conditions.push(asInstance);
    }
  }
  const channelIdFilter = buildChannelInstanceFilter(params.channelIds);
  if (channelIdFilter) conditions.push(channelIdFilter);
  if (params.sessionExpiresWithinHours !== undefined) {
    conditions.push({ id: { in: params.sessionExpiringConversationIds ?? [] } });
  }

  if (params.withoutOwner) {
    conditions.push({ assignedToId: null });
  } else {
    const ownerIds = Array.from(
      new Set(
        [...(params.ownerIds ?? []), ...(params.ownerId ? [params.ownerId] : [])].filter(
          Boolean,
        ),
      ),
    );
    if (ownerIds.length > 0) {
      // Filtro da aba "Conversa > Responsável" corresponde ao responsável
      // exibido no card (Conversation.assignedTo). Antes usávamos um OR que
      // também incluía contatos cujo deal fosse do usuário ou cujo owner
      // padrão fosse o usuário — isso trazia conversas atribuídas a outros
      // agentes só porque o contato tinha algum vínculo com o filtrado,
      // gerando o bug do inbox (Breno trazia conversas de Beatriz/Julia).
      conditions.push({ assignedToId: { in: ownerIds } });
    }
  }
  const stageIds = Array.from(
    new Set(
      [...(params.stageIds ?? []), ...(params.stageId ? [params.stageId] : [])].filter(
        Boolean,
      ),
    ),
  );
  if (stageIds.length > 0) {
    conditions.push({
      contact: { deals: { some: { stageId: { in: stageIds } } } },
    });
  }
  if (params.tagIds && params.tagIds.length > 0) {
    conditions.push({
      contact: { tags: { some: { tagId: { in: params.tagIds } } } },
    });
  }
  const sourceCond = buildConversationSourceCondition(
    params.sources,
    params.withoutSource,
  );
  if (sourceCond) conditions.push(sourceCond);
  if (params.windowState === "open") {
    conditions.push({ status: { not: "RESOLVED" } });
  } else if (params.windowState === "closed") {
    conditions.push({ status: "RESOLVED" });
  }
  return conditions;
}

export async function findSessionExpiringConversationIds(
  hoursValue: unknown,
  now = new Date(),
): Promise<string[]> {
  const hours = normalizeHoursBeforeExpiry(hoursValue);
  if (hours === null) return [];
  const organizationId = getOrgIdOrThrow();
  const oldestInbound = new Date(now.getTime() - WHATSAPP_SESSION_WINDOW_MS);
  const newestInbound = new Date(
    oldestInbound.getTime() + hours * 60 * 60 * 1000,
  );
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH sessions AS (
      SELECT
        c."organizationId",
        c."contactId",
        c."channel",
        MAX(m."createdAt") AS "lastInboundAt"
      FROM "conversations" c
      JOIN "messages" m
        ON m."conversationId" = c."id"
       AND m."direction" = 'in'
      WHERE c."contactId" IS NOT NULL
        AND c."organizationId" = ${organizationId}
        AND LOWER(c."channel") IN ('whatsapp', 'whatsapp_meta', 'meta_whatsapp')
      GROUP BY c."organizationId", c."contactId", c."channel"
      HAVING MAX(m."createdAt") > ${oldestInbound}
         AND MAX(m."createdAt") <= ${newestInbound}
    )
    SELECT rep."id"
    FROM sessions s
    JOIN LATERAL (
      SELECT c2."id"
      FROM "conversations" c2
      JOIN "channels" ch
        ON ch."id" = c2."channelId"
       AND ch."provider" = 'META_CLOUD_API'
      WHERE c2."organizationId" = s."organizationId"
        AND c2."contactId" = s."contactId"
        AND c2."channel" = s."channel"
      ORDER BY (c2."status" <> 'RESOLVED') DESC, c2."updatedAt" DESC
      LIMIT 1
    ) rep ON TRUE
  `);
  return rows.map((row) => row.id);
}

async function withResolvedSessionFilter(
  params: GetConversationsParams,
): Promise<GetConversationsParams> {
  if (params.sessionExpiresWithinHours === undefined) return params;
  return {
    ...params,
    sessionExpiringConversationIds:
      params.sessionExpiringConversationIds ??
      (await findSessionExpiringConversationIds(params.sessionExpiresWithinHours)),
  };
}

/**
 * IDs das conversas ENCERRÁVEIS que casam com um filtro de listagem — usado
 * pelo "selecionar todas do filtro → Encerrar". Aplica o MESMO `where` da
 * lista, mas restringe a `status != RESOLVED` (já resolvidas são no-op) e
 * separa as que estão em departamento com tabulação obrigatória no
 * encerramento (`requireTabulationOnClose`), que NÃO podem ser encerradas em
 * massa por não-admin (precisam de tabulação individual).
 *
 * ADMIN / super-admin: `allowCloseWithoutTabulation` inclui essas conversas
 * nos ids (override de tabulação só no bulk).
 */
export async function getResolvableConversationIds(
  params: GetConversationsParams,
  opts?: { allowCloseWithoutTabulation?: boolean },
): Promise<{ ids: string[]; skippedIds: string[] }> {
  const baseWhere = await buildConversationListWhere(
    await withResolvedSessionFilter(params),
  );
  const openWhere: Prisma.ConversationWhereInput = {
    AND: [baseWhere, { status: { not: "RESOLVED" } }],
  };

  const rows = await prisma.conversation.findMany({
    where: openWhere,
    select: {
      id: true,
      department: { select: { requireTabulationOnClose: true } },
    },
  });

  const ids: string[] = [];
  const skippedIds: string[] = [];
  const skipTabulationFilter = opts?.allowCloseWithoutTabulation === true;
  for (const r of rows) {
    if (!skipTabulationFilter && r.department?.requireTabulationOnClose) {
      skippedIds.push(r.id);
    } else {
      ids.push(r.id);
    }
  }
  return { ids, skippedIds };
}

export async function getConversations(
  params: GetConversationsParams = {}
): Promise<{
  items: ConversationListItem[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
}> {
  params = await withResolvedSessionFilter(params);
  const page = Math.max(1, params.page ?? 1);
  // 27/mai/26 — Cap subido de 100 → 200 pra acomodar o infinite scroll
  // da lista de conversas (operador com 455+ conversas em "Entrada"
  // travava porque o front pedia 60 e nunca pedia mais).
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 20));
  const skip = (page - 1) * perPage;

  const where = await buildConversationListWhere(params);

  const sortBy = params.sortBy ?? "updatedAt";
  const sortOrder = params.sortOrder ?? "desc";
  const orderBy: Prisma.ConversationOrderByWithRelationInput = { [sortBy]: sortOrder };

  // Colapso por CONTATO+CANAL (1 card por numero — modelo de ticket).
  // Reabrir uma conversa encerrada gera um NOVO id (ticket B); o ticket A
  // (RESOLVED) nao pode aparecer como um segundo card do mesmo numero. Como
  // os filtros dinamicos (tab/visibilidade/tags/sources/busca) sao objetos
  // Prisma complexos, evitamos traduzir tudo pra SQL cru: buscamos os IDs
  // que casam com o `where` NA ORDEM pedida (payload minimo) e colapsamos
  // em memoria pegando o REPRESENTANTE = primeiro da ordem por grupo. Com
  // `orderBy` = updatedAt desc (default), o primeiro e' o ticket ativo/mais
  // recente (os RESOLVED antigos ficam congelados, pois qualquer nova msg
  // reabre como ticket novo). Historico dos tickets antigos segue acessivel
  // na timeline continua do chat. Paginamos a lista colapsada e hidratamos
  // so a pagina com o `listSelect` completo. Ver frontend use-conversations.
  //
  // Performance (ago/26): carregar TODOS os IDs da org em memoria fazia
  // GET /api/conversations levar 5–8s. Varremos em lotes ate cobrir a
  // pagina pedida (+1 pra saber se ha mais) e, se ainda houver linhas,
  // estimamos `total` pelo teto conservador (repIds + restantes brutos)
  // so pra infinite scroll nao parar cedo demais.
  const collapse = !params.contactId;
  const needReps = skip + perPage + 1;
  const BATCH = 500;
  const HARD_CAP = 8_000;
  const seenGroups = new Set<string>();
  const repIds: string[] = [];
  let scanned = 0;
  let exhausted = false;

  while (repIds.length < needReps && scanned < HARD_CAP) {
    const batch = await prisma.conversation.findMany({
      where,
      orderBy,
      select: { id: true, contactId: true, channel: true },
      skip: scanned,
      take: Math.min(BATCH, HARD_CAP - scanned),
    });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    scanned += batch.length;
    if (batch.length < BATCH) exhausted = true;

    for (const r of batch) {
      const groupKey =
        collapse && r.contactId ? inboxCardGroupKey(r) : `id:${r.id}`;
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
      repIds.push(r.id);
      if (repIds.length >= needReps) break;
    }
    if (exhausted) break;
  }

  const pageIds = repIds.slice(skip, skip + perPage);
  // hasMore vem do scan +1 — NÃO do total. O sentinela `skip+perPage+1`
  // nunca pode ser o total exibido (1ª página = 26 vs badge 421).
  const hasMore = repIds.length > skip + perPage || (!exhausted && scanned >= HARD_CAP);
  // Total EXATO — o mesmo COUNT das badges (`countConversationsLikeList`),
  // em TODAS as abas (Entrada, Automação, Erro, …).
  const [total, hydrated] = await Promise.all([
    countConversationsLikeList(
      Object.keys(where).length > 0 ? [where] : [],
      collapse,
    ),
    prisma.conversation.findMany({
      where: { id: { in: pageIds } },
      select: listSelect,
    }),
  ]);
  // Reordena para preservar a ordem paginada de `pageIds` (o `in` nao
  // garante ordem). Evita cards "pulando" de posicao entre paginas.
  const byIdRow = new Map(hydrated.map((r) => [r.id, r]));
  const rows = pageIds
    .map((id) => byIdRow.get(id))
    .filter((r): r is (typeof hydrated)[number] => r !== undefined);

  const convIds = rows.map((r) => r.id);
  const [previewMap, lastInboundMap] = await Promise.all([
    lastMessagePreviewsBatch(convIds),
    lastInboundBatch(convIds),
  ]);

  await enrichContactsWithUserAvatarFallback(
    rows.map((r) => r.contact).filter((c): c is NonNullable<typeof c> => c !== null),
  );

  const items: ConversationListItem[] = rows.map((row) => {
    // `tags` do card/header da conversa = tags do CONTATO apenas.
    // Antes mesclávamos tags do negócio aqui, o que fazia o header do
    // chat exibir badge derivada de tag de deal (ex.: "ENTERPRISE") —
    // pedido do operador: o header reflete a tag do contato, não do
    // negócio. Tags do negócio continuam disponíveis na seção de deal
    // do aside (via detalhe do deal), não neste array agregado.
    const tagMap = new Map<string, ConversationTag>();
    for (const t of row.contact?.tags ?? []) {
      if (t.tag) tagMap.set(t.tag.id, t.tag);
    }
    return {
      ...row,
      // Batch = inbound do contato+canal (mesma regra do GET messages).
      // Sem entrada no map → sem inbound real; NÃO cair no denormalizado
      // (pode estar stale e esconder "Expirada" no card).
      lastInboundAt: lastInboundMap.get(row.id) ?? null,
      lastMessagePreview: previewMap.get(row.id)?.preview ?? null,
      lastMessageAt: previewMap.get(row.id)?.createdAt ?? null,
      tags: Array.from(tagMap.values()),
    };
  });

  return { items, total, page, perPage, hasMore };
}

/** Lista só categorias (exclui "todos") — contagens por aba e grants. */
export const INBOX_TAB_LIST: readonly InboxCategoryTab[] = INBOX_CATEGORY_TABS;

/** @deprecated use INBOX_TAB_LIST */
const TAB_LIST = INBOX_TAB_LIST;

/**
 * Contagem que ESPELHA a semântica da lista: `getConversations` colapsa os
 * tickets por CONTATO (1 card por pessoa/canal — ver comentário do colapso
 * lá), porque encerrar e receber nova mensagem cria um ticket NOVO. Contar
 * linhas de `conversations` inflava o badge (ex.: 1 contato com 19
 * encerramentos contava 19 — badge "Encerradas 20" para uma lista de 2
 * cards). Contamos então CONTATOS distintos que possuem ≥1 conversa
 * casando o `where`, via semi-join no Postgres (`contacts WHERE EXISTS
 * (...)`) — um único COUNT escalar, sem trazer os grupos para memória
 * (o org maior tem 28k grupos; `groupBy` custaria MBs por aba).
 *
 * Contato x contato+canal: a lista agrupa por `contactId::channel`, mas em
 * produção `count(DISTINCT contactId) == count(DISTINCT (contactId, channel))`
 * em TODAS as orgs (um contato não tem tickets em canais diferentes), logo
 * contato distinto casa exatamente com a quantidade de cards.
 *
 * `collapseByContact = false` (filtro por `contactId`) espelha a lista quando
 * ela NÃO colapsa: aí cada ticket é um card e contamos linhas.
 */
async function countConversationsLikeList(
  conditions: Prisma.ConversationWhereInput[],
  collapseByContact: boolean,
): Promise<number> {
  const where: Prisma.ConversationWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};
  if (!collapseByContact) return prisma.conversation.count({ where });

  // A extension de org injeta `organizationId` só na raiz (aqui, em
  // `contacts`); replicamos no filtro aninhado para manter o escopo da
  // contagem anterior (`prisma.conversation.count`) idêntico.
  const orgId = getOrgIdOrNull();
  const someWhere: Prisma.ConversationWhereInput = orgId
    ? { AND: [...conditions, { organizationId: orgId }] }
    : where;
  return prisma.contact.count({ where: { conversations: { some: someWhere } } });
}

async function countTodosTab(
  visibilityWhere: Prisma.ConversationWhereInput | undefined,
  memberOrTabs: InboxCategoryTab[] | null,
  allowedChannelIds?: string[] | null,
  filterConditions?: Prisma.ConversationWhereInput[],
  searchWhere?: Prisma.ConversationWhereInput | null,
  countAgentReply = false,
  collapseByContact = true,
): Promise<number> {
  const conditions: Prisma.ConversationWhereInput[] = [];
  if (visibilityWhere && Object.keys(visibilityWhere).length > 0) {
    conditions.push(visibilityWhere);
  }
  if (memberOrTabs && memberOrTabs.length > 0) {
    conditions.push({
      OR: memberOrTabs.map((t) => tabToWhere(t, countAgentReply)),
    });
  }
  if (allowedChannelIds) {
    conditions.push({ channelId: { in: allowedChannelIds } });
  }
  if (filterConditions && filterConditions.length > 0) {
    conditions.push(...filterConditions);
  }
  if (searchWhere) conditions.push(searchWhere);
  return countConversationsLikeList(conditions, collapseByContact);
}

export async function getTabCounts(
  visibilityWhere?: Prisma.ConversationWhereInput,
  /** `null` = ADMIN/MANAGER (todas as conversas visíveis). Array = MEMBER (OR das categorias). */
  todosMemberCategoryTabs?: InboxCategoryTab[] | null,
  /** Escopo de canais por usuário (IDs de `Channel`). `null` = sem restrição. */
  allowedChannelIds?: string[] | null,
  /** Filtros ativos (funil): responsável, tags, origem, estágio… Aplicados a
   *  TODAS as contagens para que os badges reflitam o filtro selecionado. */
  filterConditions?: Prisma.ConversationWhereInput[],
  /** Busca textual — mesma regra da listagem, para badges casarem com a lista. */
  search?: string | null,
  /** `false` quando a lista NÃO colapsa por contato (filtro por `contactId`). */
  collapseByContact = true,
): Promise<Record<InboxTab, number>> {
  const orgId = getOrgIdOrNull() ?? "noorg";
  let scopeFp: string;
  try {
    scopeFp = createHash("sha1")
      .update(
        JSON.stringify({
          k: 3,
          v: visibilityWhere ?? null,
          m: todosMemberCategoryTabs ?? null,
          c: allowedChannelIds ?? null,
          f: filterConditions ?? [],
          s: search?.trim() || null,
          g: collapseByContact,
        }),
      )
      .digest("hex")
      .slice(0, 20);
  } catch {
    return computeTabCounts(
      visibilityWhere,
      todosMemberCategoryTabs,
      allowedChannelIds,
      filterConditions,
      search,
      collapseByContact,
    );
  }

  return cache.wrap(
    inboxTabCountsKey(orgId, scopeFp),
    TAB_COUNTS_CACHE_TTL_SEC,
    () => computeTabCounts(
      visibilityWhere,
      todosMemberCategoryTabs,
      allowedChannelIds,
      filterConditions,
      search,
      collapseByContact,
    ),
  );
}

async function computeTabCounts(
  visibilityWhere?: Prisma.ConversationWhereInput,
  todosMemberCategoryTabs?: InboxCategoryTab[] | null,
  allowedChannelIds?: string[] | null,
  filterConditions?: Prisma.ConversationWhereInput[],
  search?: string | null,
  collapseByContact = true,
): Promise<Record<InboxTab, number>> {
  const extra = filterConditions ?? [];
  const searchWhere = await buildConversationSearchWhere(search);
  const countAgentReply = await countAgentReplyAsAnswered();

  // Abas "leves" (OPEN + filtros estreitos) vs "pesadas" (RESOLVED / OR amplo).
  // finalizados + todos ainda rodam no mesmo batch, mas o cache.wrap acima
  // evita repetir o pacote inteiro a cada mount/SSE.
  const lightTabs = TAB_LIST.filter((t) => t !== "finalizados");
  const countTab = async (tab: InboxCategoryTab) => {
    const conditions: Prisma.ConversationWhereInput[] = [];
    if (visibilityWhere && Object.keys(visibilityWhere).length > 0) {
      conditions.push(visibilityWhere);
    }
    conditions.push(tabToWhere(tab, countAgentReply));
    if (allowedChannelIds) {
      conditions.push({ channelId: { in: allowedChannelIds } });
    }
    if (extra.length > 0) conditions.push(...extra);
    if (searchWhere) conditions.push(searchWhere);
    return countConversationsLikeList(conditions, collapseByContact);
  };

  // Sequencial de propósito: 8 COUNT em paralelo (cold load) esgotava o
  // pool da API e o login/inbox viravam 500 "Internal Server Error".
  const lightResults: Array<readonly [InboxCategoryTab, number]> = [];
  for (const tab of lightTabs) {
    lightResults.push([tab, await countTab(tab)]);
  }
  const finalizados = await countTab("finalizados");
  const todos = await countTodosTab(
    visibilityWhere,
    todosMemberCategoryTabs ?? null,
    allowedChannelIds,
    extra,
    searchWhere,
    countAgentReply,
    collapseByContact,
  );
  const abertas = await (() => {
    const conditions: Prisma.ConversationWhereInput[] = [];
    if (visibilityWhere && Object.keys(visibilityWhere).length > 0) {
      conditions.push(visibilityWhere);
    }
    conditions.push({ status: "OPEN" });
    if (allowedChannelIds) conditions.push({ channelId: { in: allowedChannelIds } });
    if (extra.length > 0) conditions.push(...extra);
    if (searchWhere) conditions.push(searchWhere);
    return countConversationsLikeList(conditions, collapseByContact);
  })();
  const ligar = await (() => {
    const conditions: Prisma.ConversationWhereInput[] = [];
    if (visibilityWhere && Object.keys(visibilityWhere).length > 0) {
      conditions.push(visibilityWhere);
    }
    conditions.push(ligarTabWhere());
    if (allowedChannelIds) conditions.push({ channelId: { in: allowedChannelIds } });
    if (extra.length > 0) conditions.push(...extra);
    if (searchWhere) conditions.push(searchWhere);
    return countConversationsLikeList(conditions, collapseByContact);
  })();

  const record = Object.fromEntries(lightResults) as Record<InboxTab, number>;
  record.finalizados = finalizados;
  record.todos = todos;
  record.abertas = abertas;
  record.ligar = ligar;
  return record;
}

export async function linkContactToConversation(conversationId: string, contactId: string) {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { contactId },
    include: { contact: { select: { id: true, number: true, name: true, email: true, phone: true, avatarUrl: true } } },
  });
}

/** Dígitos → `number` da org; senão CUID/`id`. Null se o número for inválido. */
function conversationLookupWhere(idOrNumber: string, orgId: string) {
  if (/^\d+$/.test(idOrNumber)) {
    const n = Number(idOrNumber);
    if (!Number.isInteger(n) || n < 1 || n > PG_INT4_MAX) return null;
    return { organizationId_number: { organizationId: orgId, number: n } };
  }
  return { id: idOrNumber };
}

/**
 * Detalhe de uma conversa no shape da lista (deep-link / GET :id).
 * Usa `listSelect` (não `include` de todos os escalares) — mesmo padrão do
 * assign: evita 500 por drift de coluna e devolve department/tags/preview
 * iguais ao card da inbox.
 *
 * Deep-link `?c=`: dígitos resolvem pelo `number` da org; CUID legado por `id`.
 */
export async function getConversationById(idOrNumber: string) {
  const orgId = getOrgIdOrThrow();
  const where = conversationLookupWhere(idOrNumber, orgId);
  if (!where) return null;
  const row = await prisma.conversation.findUnique({
    where,
    select: {
      organizationId: true,
      ...listSelect,
    },
  });
  if (!row) return null;
  const convId = row.id;
  if (row.contact) {
    await enrichContactsWithUserAvatarFallback([row.contact]);
  }
  const [previewMap, lastInboundMap] = await Promise.all([
    lastMessagePreviewsBatch([convId]),
    lastInboundBatch([convId]),
  ]);
  const tagMap = new Map<string, ConversationTag>();
  for (const t of row.contact?.tags ?? []) {
    if (t.tag) tagMap.set(t.tag.id, t.tag);
  }
  return {
    ...row,
    lastInboundAt: lastInboundMap.get(convId) ?? null,
    lastMessagePreview: previewMap.get(convId)?.preview ?? null,
    lastMessageAt: previewMap.get(convId)?.createdAt ?? null,
    tags: Array.from(tagMap.values()),
  };
}

/** Campos mínimos do assign/transfer — evita RETURNING de colunas novas
 *  (ex.: hasHumanReply) que ainda não existem em DBs com drift de migração. */
const ASSIGN_CONVERSATION_SELECT = {
  id: true,
  status: true,
  externalId: true,
  contactId: true,
  assignedToId: true,
  contact: {
    select: { id: true, number: true, name: true, email: true, phone: true, avatarUrl: true },
  },
  assignedTo: {
    select: { id: true, name: true, email: true, avatarUrl: true, type: true },
  },
} as const;

export type AssignConversationPayload = Prisma.ConversationGetPayload<{
  select: typeof ASSIGN_CONVERSATION_SELECT;
}>;

export type AssignConversationResult =
  | { ok: true; conversation: AssignConversationPayload }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" | "USER_NOT_FOUND" };

export async function assignConversationAssignedTo(
  conversationId: string,
  newAssigneeId: string | null,
  actor: {
    id: string;
    role: AppUserRole;
    canReassignOthers?: boolean;
    /** Pode transferir conversa própria/livre para outro agente (RBAC `conversation:transfer`). */
    canTransfer?: boolean;
  }
): Promise<AssignConversationResult> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { assignedToId: true },
  });
  if (!conv) return { ok: false, code: "NOT_FOUND" };

  const isAdmin = actor.role === "ADMIN";
  const isManager = actor.role === "MANAGER";
  // `canReassignOthers` vem do RBAC efetivo na rota de assign. O fallback
  // por role preserva os demais callsites legados (ex.: transfer).
  const canReassignOthers =
    actor.canReassignOthers ?? (isAdmin || isManager);
  const canTransfer = actor.canTransfer ?? false;

  if (!canReassignOthers) {
    // Transferência: conversa própria OU livre → outro agente. Sem isso o
    // operador só conseguia se autoatribuir (`claim`), e o botão Transferir
    // da Inbox devolvia 403 em silêncio.
    const ownsOrUnassigned =
      !conv.assignedToId || conv.assignedToId === actor.id;
    if (
      canTransfer &&
      ownsOrUnassigned &&
      newAssigneeId !== null &&
      newAssigneeId !== actor.id
    ) {
      const u = await prisma.user.findUnique({
        where: { id: newAssigneeId },
        select: { id: true },
      });
      if (!u) return { ok: false, code: "USER_NOT_FOUND" };
      const ok = await userHasConversationAccess(actor, conversationId);
      if (!ok) return { ok: false, code: "FORBIDDEN" };
    } else {
      if (newAssigneeId === null) return { ok: false, code: "FORBIDDEN" };
      if (newAssigneeId !== actor.id) return { ok: false, code: "FORBIDDEN" };
      if (conv.assignedToId && conv.assignedToId !== actor.id) {
        return { ok: false, code: "FORBIDDEN" };
      }
      // Auto-atribuição requer permissão configurada pelo administrador.
      if (!conv.assignedToId) {
        const allowed = await canRoleSelfAssign(actor.role);
        if (!allowed) return { ok: false, code: "FORBIDDEN" };
        const ok = await userHasConversationAccess(actor, conversationId);
        if (!ok) return { ok: false, code: "FORBIDDEN" };
      }
    }
  } else {
    // Managers também respeitam o flag quando estão se auto-atribuindo.
    if (!isAdmin && newAssigneeId === actor.id && !conv.assignedToId) {
      const allowed = await canRoleSelfAssign(actor.role);
      if (!allowed) return { ok: false, code: "FORBIDDEN" };
    }
    if (!isAdmin) {
      const ok = await userHasConversationAccess(actor, conversationId);
      if (!ok) return { ok: false, code: "FORBIDDEN" };
    }
    if (newAssigneeId !== null) {
      const u = await prisma.user.findUnique({
        where: { id: newAssigneeId },
        select: { id: true },
      });
      if (!u) return { ok: false, code: "USER_NOT_FOUND" };
    }
  }

  // Reset do flag de saudação do agente IA quando há troca real de
  // assignedToId — garante que a próxima reatribuição a um agente IA
  // dispare saudação de novo.
  const shouldResetGreeted = (conv.assignedToId ?? null) !== (newAssigneeId ?? null);

  // Atribuir/remover pelo inbox SINCRONIZA tudo: conversa + contato +
  // negócios abertos do contato. Sem isso, "Remover responsável" limpava só
  // a conversa e o contato/negócio continuavam atribuídos (inconsistente) —
  // dava a impressão de que não removeu. Tudo numa transação (atômico).
  //
  // `select` explícito (não `include`): Prisma com include devolve TODOS os
  // escalares no RETURNING — incluindo hasHumanReply. Em DBs sem a coluna
  // (drift de migração), o assign/bulk-reassign quebrava mesmo sem tocar no
  // campo. O select lista só o que a rota de actions precisa.
  const updated = await prisma.$transaction(async (tx) => {
    const conv = await tx.conversation.update({
      where: { id: conversationId },
      data: {
        assignedToId: newAssigneeId,
        ...(shouldResetGreeted ? { aiGreetedAt: null } : {}),
      },
      select: ASSIGN_CONVERSATION_SELECT,
    });
    if (conv.contactId) {
      await tx.contact.update({
        where: { id: conv.contactId },
        data: { assignedToId: newAssigneeId },
      });
      await tx.deal.updateMany({
        where: { contactId: conv.contactId, status: "OPEN" },
        data: { ownerId: newAssigneeId },
      });
    }
    return conv;
  });

  return { ok: true, conversation: updated };
}

/**
 * Reabre uma conversa RESOLVED como NOVO ticket (regra "reabrir = novo id").
 * Se ja existe um ticket ativo pro contato+canal (ex.: um inbound reabriu
 * antes), reusa; caso contrario cria um novo, tratando a corrida do indice
 * unico parcial. Herda canal/jid/inbox/responsavel da conversa origem.
 */
export async function reopenResolvedAsNewTicket(sourceId: string): Promise<{
  id: string;
  created: boolean;
  contactId: string | null;
  channel: string;
}> {
  const src = await prisma.conversation.findUnique({
    where: { id: sourceId },
    select: {
      id: true, contactId: true, channel: true, channelId: true,
      waJid: true, inboxName: true, assignedToId: true,
    },
  });
  if (!src || !src.contactId) {
    return { id: sourceId, created: false, contactId: src?.contactId ?? null, channel: src?.channel ?? "" };
  }

  const findActive = () =>
    prisma.conversation.findFirst({
      where: { contactId: src.contactId!, channel: src.channel, status: { not: "RESOLVED" } },
      select: { id: true },
    });

  const existing = await findActive();
  if (existing) {
    return { id: existing.id, created: false, contactId: src.contactId, channel: src.channel };
  }

  try {
    const created = await withConversationNumberRetry((number) =>
      prisma.conversation.create({
        data: withOrgFromCtx({
          number,
          contactId: src.contactId!,
          channel: src.channel,
          status: "OPEN" as const,
          ...(src.channelId ? { channelId: src.channelId } : {}),
          ...(src.waJid ? { waJid: src.waJid } : {}),
          ...(src.inboxName ? { inboxName: src.inboxName } : {}),
          ...(src.assignedToId ? { assignedToId: src.assignedToId } : {}),
        }),
        select: { id: true },
      }),
    );
    return { id: created.id, created: true, contactId: src.contactId, channel: src.channel };
  } catch (err) {
    if (isActiveConversationUniqueViolation(err)) {
      const won = await findActive();
      if (won) return { id: won.id, created: false, contactId: src.contactId, channel: src.channel };
    }
    throw err;
  }
}

export async function getConversationLite(idOrNumber: string) {
  const id = await resolveConversationId(idOrNumber);
  if (!id) return null;
  return prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true, externalId: true, contactId: true, status: true,
      channel: true, channelId: true, waJid: true, organizationId: true,
      number: true,
      createdAt: true,
      lastInboundAt: true,
      assignedToId: true,
      assignedTo: { select: { id: true, name: true, type: true } },
      pinnedNoteId: true,
      channelRef: {
        select: {
          id: true, provider: true, config: true, name: true,
          phoneNumber: true, type: true, status: true,
        },
      },
    },
  });
}

export async function updateConversationStatusInDb(
  id: string,
  status: ConversationStatus,
  extra?: {
    tabulationId?: string | null;
    /** Ao encerrar (RESOLVED), desvincula o atendente (assignedToId=null). */
    clearAssignedTo?: boolean;
    /** Ao encerrar (RESOLVED), desvincula o departamento (departmentId=null). */
    clearDepartment?: boolean;
  },
) {
  // closedAt: preencher quando encerra, limpar quando reabre. Fica em sync
  // com o status pra UI/relatorios sem consultar historico de eventos.
  // Outros valores (PENDING/SNOOZED) nao mexem em closedAt.
  const closedAtPatch: { closedAt: Date | null } | Record<string, never> =
    status === "RESOLVED"
      ? { closedAt: new Date() }
      : status === "OPEN"
        ? { closedAt: null }
        : {};

  // Reabrir (OPEN) limpa a tabulacao — coerente com "novo ciclo". O
  // caller pode passar `tabulationId` explicito no encerramento, ou omitir.
  const tabulationPatch: { tabulationId: string | null } | Record<string, never> =
    status === "OPEN"
      ? { tabulationId: null }
      : extra && "tabulationId" in extra
        ? { tabulationId: extra.tabulationId ?? null }
        : {};

  // Ao ENCERRAR: respeita as configs "Manter atendente/departamento ao
  // finalizar". Quando desligadas, o caller passa clearAssignedTo/
  // clearDepartment=true e desvinculamos os campos aqui.
  const clearPatch: { assignedToId?: null; departmentId?: null } =
    status === "RESOLVED"
      ? {
          ...(extra?.clearAssignedTo ? { assignedToId: null } : {}),
          ...(extra?.clearDepartment ? { departmentId: null } : {}),
        }
      : {};

  // Snapshot ANTES do update: precisamos de quem era o atendente para
  // logar a remoção e limpar deal/contato (abaixo).
  let clearedAssignee: { id: string; name: string | null } | null = null;
  let closeContactId: string | null = null;
  if (status === "RESOLVED" && extra?.clearAssignedTo) {
    const prev = await prisma.conversation.findUnique({
      where: { id },
      select: {
        assignedToId: true,
        contactId: true,
        assignedTo: { select: { name: true } },
      },
    });
    if (prev?.assignedToId) {
      clearedAssignee = {
        id: prev.assignedToId,
        name: prev.assignedTo?.name ?? null,
      };
      closeContactId = prev.contactId ?? null;
    }
  }

  const updated = await prisma.conversation.update({
    where: { id },
    data: {
      status,
      ...closedAtPatch,
      ...tabulationPatch,
      ...clearPatch,
      // Encerrar remove da fila Erro — hasError sticky não é mais acionável.
      ...(status === "RESOLVED" ? { hasError: false } : {}),
    },
    include: { contact: { select: { id: true, number: true, name: true, email: true, phone: true, avatarUrl: true } } },
  });

  // Badges Redis (TTL 45s) sem invalidação sobreviviam ao F5 — Erro 233
  // com lista já vazia. Encerrou/reabriu → zera o cache da org.
  if (status === "RESOLVED" || status === "OPEN") {
    const orgId = getOrgIdOrNull();
    if (orgId) void invalidateInboxTabCounts(orgId);
  }

  // Encerrou atendimento → liberou capacidade na fila do responsável.
  // Agenda drenagem da Distribuição (best-effort, sem ciclo de import).
  if (status === "RESOLVED") {
    void import("@/services/distribution/pending")
      .then((m) =>
        m.scheduleProcessPendingDistributionQueue({
          trigger: "capacity_released",
          delayMs: 400,
        }),
      )
      .catch(() => {});
  }

  // Encerrou SEM manter atendente → registra a remoção (chat + timeline)
  // e limpa deal/contato que ainda apontavam para ela. Import dinâmico:
  // deals.ts é pesado e este arquivo é importado por webhooks quentes.
  if (clearedAssignee) {
    const orgId = getOrgIdOrNull();
    await logEvent({
      type: "ASSIGNEE_CHANGED",
      entityType: "CONVERSATION",
      entityId: id,
      entityLabel: updated.externalId ?? null,
      conversationId: id,
      contactId: closeContactId,
      field: "assignedTo",
      oldValue: clearedAssignee.name,
      newValue: null,
      meta: {
        fromUserId: clearedAssignee.id,
        toUserId: null,
        reason: "conversation_closed",
      },
    });
    try {
      sseBus.publish("conversation_timeline_updated", {
        organizationId: orgId,
        conversationId: id,
        type: "ASSIGNEE_CHANGED",
      });
    } catch {
      /* best-effort */
    }
    if (closeContactId) {
      const { clearContactOwnershipOnClose } = await import("@/services/deals");
      await clearContactOwnershipOnClose({
        contactId: closeContactId,
        clearedUserId: clearedAssignee.id,
        actorUserId: getRequestContext()?.userId ?? null,
      }).catch(() => {});
    }
  }

  return updated;
}

/**
 * Retorna o proximo `number` sequencial de Conversation na org do
 * contexto atual.
 *
 * Delega no contador atomico compartilhado (`org_number_counters`) em vez de
 * fazer `MAX(number) + 1` aqui. Ter dois alocadores para o mesmo model era o
 * que sobrava de corrida depois do fix de custo: este caminho emitia MAX+1
 * enquanto a extension de scope emitia pelo contador, e os dois colidiam
 * entre si. Fonte unica de verdade -> a colisao deixa de existir por
 * construcao. Ver `allocateOrgNumber` em lib/prisma.ts.
 */
export async function nextConversationNumber(): Promise<number> {
  const orgId = getOrgIdOrThrow();
  return allocateOrgNumber("Conversation", orgId);
}

/**
 * Detecta P2002 do indice unico PARCIAL que garante no maximo UMA conversa
 * ativa (status != RESOLVED) por (organizationId, contactId, channel).
 * Criado na migration `conversations_active_contact_channel`. Usado pelos
 * pontos de criacao (baileys/meta/whatsapp-conversation) para tratar a
 * corrida de mensagens simultaneas do mesmo numero: em vez de criar um 2o
 * ticket, o caller relê e reusa o ticket vencedor.
 */
export function isActiveConversationUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const hit = (s: string) =>
    s.includes("active_contact_channel") || s.includes("contactId");
  if (Array.isArray(target)) return target.some(hit);
  if (typeof target === "string") return hit(target);
  return false;
}

// Campanha Meta usa concurrency=10 no send worker: varios creates
// resolvem o mesmo max+1 e colidem no unique (organizationId, number).
// 5 retries bastam em inbox/webhook; em blast o stampede precisa de
// mais tentativas + jitter pra desincronizar os perdedores.
const CONVERSATION_NUMBER_MAX_RETRIES = 12;

/**
 * Detecta P2002 no unique (organizationId, number). Outros P2002
 * (externalId, active_contact_channel, etc) NAO devem ser retentados
 * aqui — deixamos borbulhar para o caller tratar.
 */
function isConversationNumberUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    message?: string;
    meta?: { target?: string[] | string };
  };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const targetHasNumber = (s: string) =>
    s === "number" || s.includes("number");
  if (Array.isArray(target)) return target.some((t) => targetHasNumber(String(t)));
  if (typeof target === "string") return targetHasNumber(target);
  // Prisma as vezes omite meta.target; mensagem tipica do engine:
  // Unique constraint failed on the fields: (`"organizationId"`,`number`)
  const msg = typeof e.message === "string" ? e.message : "";
  return /organizationId/i.test(msg) && /[`"']number[`"']/i.test(msg);
}

/**
 * Executa `run(number)` com retry se der P2002 no unique
 * (organizationId, number). Uso pra centralizar a logica de numero
 * sequencial de Conversation em todos os pontos de criacao — mesma
 * ideia do loop em `createContact` (services/contacts.ts). O caller
 * mantem o tipo retornado (generic T), sem gymnastics de Prisma types.
 */
export async function withConversationNumberRetry<T>(
  run: (number: number) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < CONVERSATION_NUMBER_MAX_RETRIES; attempt++) {
    const number = await nextConversationNumber();
    try {
      return await run(number);
    } catch (err) {
      if (isConversationNumberUniqueViolation(err)) {
        lastErr = err;
        // Jitter crescente: sem isso N workers que perderam o create
        // re-leem max e colidem de novo no mesmo instante.
        const delayMs = 5 + Math.floor(Math.random() * 15 * (attempt + 1));
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw (
    lastErr ??
    new Error(
      `withConversationNumberRetry: max ${CONVERSATION_NUMBER_MAX_RETRIES} retries exceeded`,
    )
  );
}
