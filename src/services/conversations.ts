import { createHash } from "crypto";
import { Prisma, type ConversationStatus } from "@prisma/client";

import type { AppUserRole } from "@/lib/auth-types";
import { cache } from "@/lib/cache";
import { getLogger } from "@/lib/logger";
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
  activeInboxQueueGuardWhere,
  encerradasTabWhere,
  withActiveInboxQueueGuard,
} from "@/lib/inbox-queue-membership";
import {
  getOrgIdOrNull,
  getOrgIdOrThrow,
  getRequestContext,
} from "@/lib/request-context";
import { sseBus } from "@/lib/sse-bus";
import { logEvent, userIdForFk } from "@/services/activity-log";
import { enrichContactsWithUserAvatarFallback } from "@/lib/contact-avatar-fallback";
import { parseSessionResetAt } from "@/lib/channel-session";
import { metaSessionWindowWhere } from "@/lib/meta-session-window";
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
 * rede de segurança contra invalidação perdida. 90s reduz recomputo
 * das badges quando o SSE dispara refetch em rajada.
 */
const TAB_COUNTS_CACHE_TTL_SEC = 90;

/**
 * 1ª página de Encerradas: em vez de DISTINCT ON em todo o histórico
 * RESOLVED, varre só os N tickets mais recentes e colapsa esse recorte.
 * 2000 cobre ~50 cards únicos mesmo com vários encerramentos por número.
 */
const COLLAPSE_FIRST_PAGE_SCAN = 2_000;

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
  /**
   * Keyset da próxima página (`${sortValMs}_${id}`). Preferir sobre
   * `page`/`skip` — OFFSET desloca quando chega mensagem no topo.
   * Sem cursor, `page` continua válido (clientes velhos).
   */
  cursor?: string;
  /** Hidrata cards por id (SSE / deep-link em lote). Sem aba/filtro. */
  ids?: string[];
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
   * Janela 24h da Meta (WhatsApp Cloud): aberta = lastInboundAt < 24h,
   * fechada = sem inbound ou inbound vencido. Não é status RESOLVED.
   * Tem de ir no mesmo `where` da lista, dos badges e do bulk.
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

/**
 * Lista: preenche `lastInboundAt` nulo (ticket reaberto sem inbound) com o
 * MAX denormalizado dos irmãos contato+canal — sem tocar em `messages`.
 */
async function fillMissingLastInboundFromSiblings(
  rows: { id: string; contactId: string | null; lastInboundAt: Date | null }[],
  map: Map<string, Date>,
): Promise<void> {
  const missingIds = rows
    .filter((r) => r.contactId && !map.has(r.id))
    .map((r) => r.id);
  if (missingIds.length === 0) return;
  const orgId = getOrgIdOrThrow();
  const siblingRows = await prisma.$queryRaw<{ conversationId: string; lastIn: Date }[]>`
    SELECT c.id AS "conversationId", MAX(c2."lastInboundAt") AS "lastIn"
    FROM conversations c
    JOIN conversations c2
      ON c2."contactId" = c."contactId"
     AND c2.channel = c.channel
     AND c2."organizationId" = c."organizationId"
     AND c2."lastInboundAt" IS NOT NULL
    WHERE c.id = ANY(${missingIds})
      AND c."organizationId" = ${orgId}
    GROUP BY c.id
  `;
  for (const r of siblingRows) {
    if (r.lastIn) map.set(r.conversationId, r.lastIn);
  }
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
      return withActiveInboxQueueGuard({
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
      });
    case "esperando":
      // "Aguardando" = já teve atendimento (humano; + agente se setting) e o
      // cliente falou por último (`lastMessageDirection = "in"`).
      // Só assignee HUMANO: com a IA como responsável o card fica em
      // `agente_ia` até o handoff.
      return withActiveInboxQueueGuard({
        assignedTo: { is: { type: "HUMAN" } },
        AND: [countableReplyWhere(countAgentReply)],
        lastMessageDirection: "in",
        hasError: false,
      });
    case "respondidas":
      // "Respondidas" = já teve atendimento e nós falamos por último
      // (`lastMessageDirection = "out"`). Com setting OFF, só hasHumanReply
      // (aviso automático da distribuição sem reply humano fica em Entrada).
      // Assignee IA fica em `agente_ia`.
      return withActiveInboxQueueGuard({
        assignedTo: { is: { type: "HUMAN" } },
        AND: [countableReplyWhere(countAgentReply)],
        lastMessageDirection: "out",
        hasError: false,
      });
    case "agente_ia":
      // Fila do Agente IA: TODA conversa em aberto cujo responsável é um
      // usuário `type: AI`, tenha o aluno falado ou não. Sai daqui quando o
      // handoff atribui um consultor OU libera o responsável (fila de
      // espera) — em ambos os casos o card cai em Entrada.
      return withActiveInboxQueueGuard({
        hasError: false,
        assignedTo: { is: { type: "AI" } },
      });
    case "automacao":
      // Robô ativo (RUNNING ou PAUSED) sem dono e sem nenhuma resposta do
      // cliente. Quem já falou (lastInboundAt) vai para Entrada —
      // campanha/template posterior não devolve o card pra cá. Assignee IA
      // tem aba própria (`agente_ia`); consultor humano vai para
      // Entrada/Aguardando mesmo se o PIPE ainda não encerrou.
      return withActiveInboxQueueGuard({
        assignedToId: null,
        AND: [NEVER_REPLIED],
        contact: {
          automationContexts: {
            some: { status: ACTIVE_AUTOMATION_CTX },
          },
        },
      });
    case "finalizados":
      return encerradasTabWhere();
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
  return withActiveInboxQueueGuard({ hasError: true });
}

/** WhatsApp OPEN com permissão de ligação ativa (permanente ou TTL vigente). */
export function ligarTabWhere(): Prisma.ConversationWhereInput {
  return withActiveInboxQueueGuard({
    channel: "whatsapp",
    hasError: false,
    whatsappCallConsentStatus: "GRANTED",
    OR: [
      { whatsappCallConsentExpiresAt: null },
      { whatsappCallConsentExpiresAt: { gt: new Date() } },
    ],
  });
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
  if (tab === "abertas") return activeInboxQueueGuardWhere();
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
  if (params.windowState === "open" || params.windowState === "closed") {
    conditions.push(metaSessionWindowWhere(params.windowState));
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
 * encerramento (`requireTabulationOnClose`) quando o lote NÃO traz folha.
 *
 * Com `tabulationDepartmentId` (folha no request): todas entram — a
 * tabulação escolhida vale para o lote inteiro, inclusive outros depts.
 *
 * Sem tabulação: `allowCloseWithoutTabulation` (ADMIN / super-admin)
 * inclui todos; não-admin pulam os depts que exigem tabulação.
 */
export async function getResolvableConversationIds(
  params: GetConversationsParams,
  opts?: {
    allowCloseWithoutTabulation?: boolean;
    tabulationDepartmentId?: string | null;
    /** Folha válida no request — inclui o lote inteiro, qualquer dept. */
    hasChosenTabulation?: boolean;
  },
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
      departmentId: true,
      department: { select: { requireTabulationOnClose: true } },
    },
  });

  const ids: string[] = [];
  const skippedIds: string[] = [];
  const skipTabulationFilter = opts?.allowCloseWithoutTabulation === true;
  const hasChosenTabulation =
    opts?.hasChosenTabulation === true || Boolean(opts?.tabulationDepartmentId);
  for (const r of rows) {
    const requires = !!r.department?.requireTabulationOnClose;
    if (hasChosenTabulation || !requires || skipTabulationFilter) {
      ids.push(r.id);
      continue;
    }
    skippedIds.push(r.id);
  }
  return { ids, skippedIds };
}

/** IDs que casam com o filtro da listagem — usado no bulk assign "todas do filtro". */
export async function getFilteredConversationIds(
  params: GetConversationsParams,
): Promise<string[]> {
  const where = await buildConversationListWhere(
    await withResolvedSessionFilter(params),
  );
  const rows = await prisma.conversation.findMany({
    where,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

function listSortColumnSql(
  sortBy: "updatedAt" | "createdAt" | "unreadCount",
): Prisma.Sql {
  if (sortBy === "createdAt") return Prisma.sql`c."createdAt"`;
  if (sortBy === "unreadCount") return Prisma.sql`c."unreadCount"`;
  return Prisma.sql`c."updatedAt"`;
}

type ListCursor = { sortVal: Date | number; id: string };

/** `${sortValMs|n}_${id}` — opaco pro cliente; bate com o ORDER BY da lista. */
function parseListCursor(
  raw: string | undefined | null,
  sortBy: "updatedAt" | "createdAt" | "unreadCount",
): ListCursor | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf("_");
  if (sep <= 0) return null;
  const valPart = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!id) return null;
  if (sortBy === "unreadCount") {
    const n = Number(valPart);
    return Number.isFinite(n) ? { sortVal: n, id } : null;
  }
  const asNum = Number(valPart);
  if (Number.isFinite(asNum) && asNum > 1e11) return { sortVal: new Date(asNum), id };
  const d = new Date(valPart);
  return Number.isNaN(d.getTime()) ? null : { sortVal: d, id };
}

function encodeListCursor(
  sortVal: Date | number | string | null | undefined,
  id: string,
): string | null {
  if (sortVal == null || !id) return null;
  if (typeof sortVal === "number") return `${sortVal}_${id}`;
  const d = sortVal instanceof Date ? sortVal : new Date(sortVal);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getTime()}_${id}`;
}

function cursorAfterRepsSql(cursor: ListCursor, sortOrder: "asc" | "desc"): Prisma.Sql {
  const val = cursor.sortVal;
  if (sortOrder === "desc") {
    return Prisma.sql`(reps.sort_val < ${val} OR (reps.sort_val = ${val} AND reps.id < ${cursor.id}))`;
  }
  return Prisma.sql`(reps.sort_val > ${val} OR (reps.sort_val = ${val} AND reps.id > ${cursor.id}))`;
}

function cursorAfterColSql(
  sortCol: Prisma.Sql,
  cursor: ListCursor,
  sortOrder: "asc" | "desc",
): Prisma.Sql {
  const val = cursor.sortVal;
  if (sortOrder === "desc") {
    return Prisma.sql`(${sortCol} < ${val} OR (${sortCol} = ${val} AND c.id < ${cursor.id}))`;
  }
  return Prisma.sql`(${sortCol} > ${val} OR (${sortCol} = ${val} AND c.id > ${cursor.id}))`;
}

function passesListCursor(
  sortVal: Date | number | null | undefined,
  id: string,
  cursor: ListCursor,
  sortOrder: "asc" | "desc",
): boolean {
  if (sortVal == null) return false;
  const a =
    sortVal instanceof Date
      ? sortVal.getTime()
      : typeof sortVal === "number"
        ? sortVal
        : new Date(sortVal).getTime();
  const b =
    cursor.sortVal instanceof Date ? cursor.sortVal.getTime() : Number(cursor.sortVal);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (sortOrder === "desc") return a < b || (a === b && id < cursor.id);
  return a > b || (a === b && id > cursor.id);
}

type CollapsedConversationPage = {
  /** Até `take` IDs a partir de `skip` (já colapsados). */
  ids: string[];
  hasMore: boolean;
  /** Total exato quando a varredura esgotou o conjunto colapsado. */
  knownTotal: number | null;
};

/**
 * Uma página colapsada por contato+canal em SQL (`DISTINCT ON`).
 * Fallback: scan em lotes Prisma se o `where` não traduzir.
 */
async function findCollapsedConversationPage(args: {
  where: Prisma.ConversationWhereInput;
  collapse: boolean;
  sortBy: "updatedAt" | "createdAt" | "unreadCount";
  sortOrder: "asc" | "desc";
  skip: number;
  take: number;
  cursor?: ListCursor | null;
}): Promise<CollapsedConversationPage> {
  const orgId = getOrgIdOrNull();
  const skip = args.cursor ? 0 : args.skip;
  if (orgId) {
    const scoped: Prisma.ConversationWhereInput = {
      AND: [args.where, { organizationId: orgId }],
    };
    const sql = sqlConversationWhere(scoped, orgId);
    if (sql) {
      const sortCol = listSortColumnSql(args.sortBy);
      const sortDir = args.sortOrder === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
      const cursorPred = args.cursor
        ? cursorAfterRepsSql(args.cursor, args.sortOrder)
        : Prisma.sql`TRUE`;
      const rowCursorPred = args.cursor
        ? cursorAfterColSql(sortCol, args.cursor, args.sortOrder)
        : Prisma.sql`TRUE`;
      try {
        const firstPageCollapse =
          args.collapse && !args.cursor && skip === 0;
        const rows = args.collapse
          ? firstPageCollapse
            ? await prisma.$queryRaw<{ id: string }[]>`
                SELECT reps.id
                FROM (
                  SELECT DISTINCT ON (inner_c.grp)
                    inner_c.id,
                    inner_c.sort_val
                  FROM (
                    SELECT
                      c.id,
                      ${sortCol} AS sort_val,
                      CASE
                        WHEN c."contactId" IS NULL THEN 'id:' || c.id
                        ELSE 'c:' || c."contactId" || '::' || COALESCE(c.channel, '')
                      END AS grp
                    FROM conversations c
                    WHERE ${sql}
                    ORDER BY ${sortCol} ${sortDir}, c.id ${sortDir}
                    LIMIT ${COLLAPSE_FIRST_PAGE_SCAN}
                  ) inner_c
                  ORDER BY inner_c.grp, inner_c.sort_val ${sortDir}, inner_c.id ${sortDir}
                ) reps
                ORDER BY reps.sort_val ${sortDir}, reps.id ${sortDir}
                LIMIT ${args.take}
              `
            : await prisma.$queryRaw<{ id: string }[]>`
              SELECT reps.id
              FROM (
                SELECT DISTINCT ON (inner_c.grp)
                  inner_c.id,
                  inner_c.sort_val
                FROM (
                  SELECT
                    c.id,
                    ${sortCol} AS sort_val,
                    CASE
                      WHEN c."contactId" IS NULL THEN 'id:' || c.id
                      ELSE 'c:' || c."contactId" || '::' || COALESCE(c.channel, '')
                    END AS grp
                  FROM conversations c
                  WHERE ${sql}
                ) inner_c
                ORDER BY inner_c.grp, inner_c.sort_val ${sortDir}, inner_c.id ${sortDir}
              ) reps
              WHERE ${cursorPred}
              ORDER BY reps.sort_val ${sortDir}, reps.id ${sortDir}
              LIMIT ${args.take} OFFSET ${skip}
            `
          : await prisma.$queryRaw<{ id: string }[]>`
              SELECT c.id
              FROM conversations c
              WHERE ${sql} AND ${rowCursorPred}
              ORDER BY ${sortCol} ${sortDir}, c.id ${sortDir}
              LIMIT ${args.take} OFFSET ${skip}
            `;
        const ids = rows.map((r) => r.id);
        const hasMore = ids.length === args.take;
        const emptyPastEnd = skip > 0 && ids.length === 0;
        return {
          ids,
          hasMore,
          knownTotal:
            args.cursor || hasMore || emptyPastEnd ? null : skip + ids.length,
        };
      } catch (err) {
        getLogger("conversations").warn(
          { err },
          "collapsed list SQL failed — falling back to JS scan",
        );
      }
    }
  }
  return scanCollapsedRepIdsJs(args);
}

async function scanCollapsedRepIdsJs(args: {
  where: Prisma.ConversationWhereInput;
  collapse: boolean;
  sortBy: "updatedAt" | "createdAt" | "unreadCount";
  sortOrder: "asc" | "desc";
  skip: number;
  take: number;
  cursor?: ListCursor | null;
}): Promise<CollapsedConversationPage> {
  const needReps = args.cursor ? args.take : args.skip + args.take;
  const BATCH = 500;
  const HARD_CAP = 8_000;
  const seenGroups = new Set<string>();
  const repIds: string[] = [];
  let scanned = 0;
  let exhausted = false;
  const orderBy: Prisma.ConversationOrderByWithRelationInput[] = [
    { [args.sortBy]: args.sortOrder },
    { id: args.sortOrder },
  ];

  while (repIds.length < needReps && scanned < HARD_CAP) {
    const batch = await prisma.conversation.findMany({
      where: args.where,
      orderBy,
      select: {
        id: true,
        contactId: true,
        channel: true,
        updatedAt: true,
        createdAt: true,
        unreadCount: true,
      },
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
        args.collapse && r.contactId ? inboxCardGroupKey(r) : `id:${r.id}`;
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
      if (
        args.cursor &&
        !passesListCursor(r[args.sortBy], r.id, args.cursor, args.sortOrder)
      ) {
        continue;
      }
      repIds.push(r.id);
      if (repIds.length >= needReps) break;
    }
    if (exhausted) break;
  }

  const ids = args.cursor
    ? repIds.slice(0, args.take)
    : repIds.slice(args.skip, args.skip + args.take);
  const capped = !exhausted && scanned >= HARD_CAP;
  const hasMore = ids.length === args.take || (capped && ids.length > 0);
  return {
    ids,
    hasMore,
    knownTotal: !args.cursor && exhausted && !capped ? repIds.length : null,
  };
}

type ConversationListPage = {
  items: ConversationListItem[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  nextCursor: string | null;
};

async function paintListRows(
  rows: Prisma.ConversationGetPayload<{ select: typeof listSelect }>[],
  previewMapReady?: Map<string, { preview: ConversationLastMessagePreview; createdAt: Date }>,
): Promise<ConversationListItem[]> {
  const convIds = rows.map((r) => r.id);
  const previewMap =
    previewMapReady ??
    (convIds.length === 0
      ? new Map<string, { preview: ConversationLastMessagePreview; createdAt: Date }>()
      : await lastMessagePreviewsBatch(convIds));
  const lastInboundMap = new Map<string, Date>();
  for (const row of rows) {
    if (row.lastInboundAt) lastInboundMap.set(row.id, row.lastInboundAt);
  }
  await fillMissingLastInboundFromSiblings(
    rows.map((r) => ({
      id: r.id,
      contactId: r.contact?.id ?? null,
      lastInboundAt: r.lastInboundAt,
    })),
    lastInboundMap,
  );
  await applyChannelSessionResetToInboundMap(convIds, lastInboundMap);
  await enrichContactsWithUserAvatarFallback(
    rows.map((r) => r.contact).filter((c): c is NonNullable<typeof c> => c !== null),
  );

  return rows.map((row) => {
    const tagMap = new Map<string, ConversationTag>();
    for (const t of row.contact?.tags ?? []) {
      if (t.tag) tagMap.set(t.tag.id, t.tag);
    }
    return {
      ...row,
      lastInboundAt: lastInboundMap.get(row.id) ?? null,
      lastMessagePreview: previewMap.get(row.id)?.preview ?? null,
      lastMessageAt: previewMap.get(row.id)?.createdAt ?? null,
      tags: Array.from(tagMap.values()),
    };
  });
}

async function hydrateConversationsByIds(
  params: GetConversationsParams,
): Promise<ConversationListPage> {
  const ids = [...new Set((params.ids ?? []).filter(Boolean))].slice(0, 80);
  const perPage = ids.length || 1;
  if (ids.length === 0) {
    return { items: [], total: 0, page: 1, perPage, hasMore: false, nextCursor: null };
  }
  const conditions: Prisma.ConversationWhereInput[] = [{ id: { in: ids } }];
  if (params.visibilityWhere && Object.keys(params.visibilityWhere).length > 0) {
    conditions.push(params.visibilityWhere);
  }
  if (params.allowedChannelIds) {
    conditions.push({ channelId: { in: params.allowedChannelIds } });
  }
  const hydrated = await prisma.conversation.findMany({
    where: { AND: conditions },
    select: listSelect,
  });
  const byId = new Map(hydrated.map((r) => [r.id, r]));
  const rows = ids
    .map((id) => byId.get(id))
    .filter((r): r is (typeof hydrated)[number] => r !== undefined);
  const items = await paintListRows(rows);
  return { items, total: items.length, page: 1, perPage, hasMore: false, nextCursor: null };
}

/**
 * DISTINCT ON (contato+canal) materializa TODOS os grupos antes do
 * LIMIT — 5s+ na 1ª página de `todos` (OPEN+RESOLVED da org). Filas
 * OPEN já são 1:1 (`conversations_active_contact_channel`). `todos` e
 * o picker sem aba usam ORDER BY + LIMIT; o FE já colapsa o card.
 * Só Encerradas ainda colapsa (N tickets RESOLVED por número).
 */
function listNeedsContactChannelCollapse(params: GetConversationsParams): boolean {
  if (params.contactId) return false;
  return params.tab === "finalizados";
}

export async function getConversations(
  params: GetConversationsParams = {}
): Promise<ConversationListPage> {
  params = await withResolvedSessionFilter(params);
  if (params.ids?.length) {
    return hydrateConversationsByIds(params);
  }

  const page = Math.max(1, params.page ?? 1);
  // 27/mai/26 — Cap subido de 100 → 200 pra acomodar o infinite scroll
  // da lista de conversas (operador com 455+ conversas em "Entrada"
  // travava porque o front pedia 60 e nunca pedia mais).
  const perPage = Math.min(200, Math.max(1, params.perPage ?? 20));
  const skip = (page - 1) * perPage;

  const where = await buildConversationListWhere(params);

  const sortBy = params.sortBy ?? "updatedAt";
  const sortOrder = params.sortOrder ?? "desc";
  const cursor = parseListCursor(params.cursor, sortBy);

  // Colapso SQL só em Encerradas. `todos` / sem aba / filas OPEN:
  // ORDER BY + LIMIT (1ª página). COUNT DISTINCT ficou no GET ?counts=1.
  // OFFSET só se o cliente velho mandar `page` sem `cursor`.
  const collapse = listNeedsContactChannelCollapse(params);
  const { ids: windowIds, hasMore, knownTotal } = await findCollapsedConversationPage({
    where,
    collapse,
    sortBy,
    sortOrder,
    skip: cursor ? 0 : skip,
    take: perPage + 1,
    cursor,
  });
  const pageIds = windowIds.slice(0, perPage);
  const [cachedTotal, hydrated, previewMap] = await Promise.all([
    knownTotal == null ? peekCachedTabTotal(params, collapse) : Promise.resolve(null),
    pageIds.length === 0
      ? Promise.resolve([])
      : prisma.conversation.findMany({
          where: { id: { in: pageIds } },
          select: listSelect,
        }),
    lastMessagePreviewsBatch(pageIds),
  ]);
  const total = knownTotal ?? cachedTotal ?? skip + perPage + 1;
  const byIdRow = new Map(hydrated.map((r) => [r.id, r]));
  const rows = pageIds
    .map((id) => byIdRow.get(id))
    .filter((r): r is (typeof hydrated)[number] => r !== undefined);

  const items = await paintListRows(rows, previewMap);
  const last = items[items.length - 1];
  const sortVal =
    !last
      ? null
      : sortBy === "createdAt"
        ? last.createdAt
        : sortBy === "unreadCount"
          ? last.unreadCount
          : last.updatedAt;
  const nextCursor = hasMore && last ? encodeListCursor(sortVal, last.id) : null;

  return { items, total, page, perPage, hasMore, nextCursor };
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
 * Contato x contato+canal: a lista agrupa por `contactId::channel`. Em
 * `dnawork` os dois COUNTs divergem (3 cards a mais no par) — o badge
 * usa a mesma chave da lista, não só `contactId`.
 *
 * `collapseByContact = false` (filtro por `contactId`) espelha a lista quando
 * ela NÃO colapsa: aí cada ticket é um card e contamos linhas.
 */
type AssigneeIdsByType = { HUMAN: string[]; AI: string[] };

async function loadAssigneeIdsByType(): Promise<AssigneeIdsByType> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return { HUMAN: [], AI: [] };
  const rows = await prisma.user.findMany({
    where: { organizationId: orgId, type: { in: ["HUMAN", "AI"] } },
    select: { id: true, type: true },
  });
  const HUMAN: string[] = [];
  const AI: string[] = [];
  for (const r of rows) {
    if (r.type === "AI") AI.push(r.id);
    else HUMAN.push(r.id);
  }
  return { HUMAN, AI };
}

function rewriteAssignedToType(
  where: Prisma.ConversationWhereInput,
  byType: AssigneeIdsByType,
): Prisma.ConversationWhereInput {
  const assignedTo = where.assignedTo as { is?: { type?: string } } | undefined;
  const type = assignedTo?.is?.type;
  const out: Prisma.ConversationWhereInput = { ...where };
  if (type === "HUMAN" || type === "AI") {
    delete out.assignedTo;
    out.assignedToId = { in: byType[type] };
  }
  if (where.AND) {
    const and = Array.isArray(where.AND) ? where.AND : [where.AND];
    out.AND = and.map((w) =>
      w && typeof w === "object"
        ? rewriteAssignedToType(w as Prisma.ConversationWhereInput, byType)
        : w,
    );
  }
  if (where.OR) {
    out.OR = where.OR.map((w) => rewriteAssignedToType(w, byType));
  }
  if (where.NOT) {
    const not = where.NOT;
    if (Array.isArray(not)) {
      out.NOT = not.map((w) => rewriteAssignedToType(w, byType));
    } else if (typeof not === "object") {
      out.NOT = rewriteAssignedToType(not, byType);
    }
  }
  return out;
}

function sqlIn(column: Prisma.Sql, values: unknown[]): Prisma.Sql {
  if (values.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`${column} IN (${Prisma.join(values)})`;
}

function sqlScalar(
  column: Prisma.Sql,
  value: unknown,
  enumCast?: string,
): Prisma.Sql | null {
  if (value === null) return Prisma.sql`${column} IS NULL`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return enumCast
      ? Prisma.sql`${column} = ${value}::${Prisma.raw(`"${enumCast}"`)}`
      : Prisma.sql`${column} = ${value}`;
  }
  if (typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if ("in" in v) {
    const arr = Array.isArray(v.in) ? v.in : [];
    if (arr.length === 0) return Prisma.sql`FALSE`;
    if (enumCast) {
      return Prisma.sql`${column} IN (${Prisma.join(
        arr.map((x) => Prisma.sql`${x}::${Prisma.raw(`"${enumCast}"`)}`),
      )})`;
    }
    return sqlIn(column, arr);
  }
  if ("not" in v) {
    if (v.not === null) return Prisma.sql`${column} IS NOT NULL`;
    if (typeof v.not === "string" || typeof v.not === "number" || typeof v.not === "boolean") {
      return enumCast
        ? Prisma.sql`${column} <> ${v.not}::${Prisma.raw(`"${enumCast}"`)}`
        : Prisma.sql`${column} <> ${v.not}`;
    }
    if (v.not && typeof v.not === "object" && "in" in (v.not as object)) {
      const arr = Array.isArray((v.not as { in: unknown[] }).in)
        ? (v.not as { in: unknown[] }).in
        : [];
      if (arr.length === 0) return Prisma.sql`TRUE`;
      return Prisma.sql`${column} NOT IN (${Prisma.join(arr)})`;
    }
    return null;
  }
  if ("equals" in v) {
    if (v.equals === null) return Prisma.sql`${column} IS NULL`;
    return enumCast
      ? Prisma.sql`${column} = ${v.equals}::${Prisma.raw(`"${enumCast}"`)}`
      : Prisma.sql`${column} = ${v.equals}`;
  }
  if ("contains" in v && typeof v.contains === "string") {
    return Prisma.sql`${column} ILIKE ${`%${v.contains}%`}`;
  }
  const parts: Prisma.Sql[] = [];
  if ("gt" in v) parts.push(Prisma.sql`${column} > ${v.gt}`);
  if ("gte" in v) parts.push(Prisma.sql`${column} >= ${v.gte}`);
  if ("lt" in v) parts.push(Prisma.sql`${column} < ${v.lt}`);
  if ("lte" in v) parts.push(Prisma.sql`${column} <= ${v.lte}`);
  if (parts.length === 0) return null;
  return Prisma.join(parts, " AND ");
}

function sqlContactFilter(
  contact: Prisma.ContactWhereInput,
  orgId: string,
): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  const push = (sql: Prisma.Sql | null) => {
    if (sql) parts.push(sql);
    return sql !== null;
  };

  if (contact.OR) {
    const orParts: Prisma.Sql[] = [];
    for (const branch of contact.OR) {
      const s = sqlContactFilter(branch, orgId);
      if (!s) return null;
      orParts.push(s);
    }
    if (orParts.length > 0) parts.push(Prisma.sql`(${Prisma.join(orParts, " OR ")})`);
  }
  if (contact.AND) {
    const and = Array.isArray(contact.AND) ? contact.AND : [contact.AND];
    for (const branch of and) {
      if (!branch || typeof branch !== "object") continue;
      const s = sqlContactFilter(branch as Prisma.ContactWhereInput, orgId);
      if (!s) return null;
      parts.push(s);
    }
  }

  if (contact.assignedToId !== undefined) {
    if (!push(sqlScalar(Prisma.sql`ct."assignedToId"`, contact.assignedToId))) return null;
  }
  if (contact.source !== undefined) {
    if (!push(sqlScalar(Prisma.sql`ct.source`, contact.source))) return null;
  }

  const deals = contact.deals as { some?: Prisma.DealWhereInput } | undefined;
  if (deals?.some) {
    const d = deals.some;
    const dParts: Prisma.Sql[] = [
      Prisma.sql`d."contactId" = c."contactId"`,
      Prisma.sql`d."organizationId" = ${orgId}`,
    ];
    if (d.stageId !== undefined) {
      const s = sqlScalar(Prisma.sql`d."stageId"`, d.stageId);
      if (!s) return null;
      dParts.push(s);
    }
    if (d.ownerId !== undefined) {
      const s = sqlScalar(Prisma.sql`d."ownerId"`, d.ownerId);
      if (!s) return null;
      dParts.push(s);
    }
    const extraKeys = Object.keys(d).filter((k) => !["stageId", "ownerId"].includes(k));
    if (extraKeys.length > 0) return null;
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM deals d WHERE ${Prisma.join(dParts, " AND ")})`);
  }

  const tags = contact.tags as { some?: { tagId?: unknown } } | undefined;
  if (tags?.some) {
    const tagId = tags.some.tagId;
    const s = sqlScalar(Prisma.sql`toc."tagId"`, tagId);
    if (!s) return null;
    parts.push(
      Prisma.sql`EXISTS (SELECT 1 FROM tags_on_contacts toc WHERE toc."contactId" = c."contactId" AND ${s})`,
    );
  }

  const ctxs = contact.automationContexts as {
    some?: { status?: unknown };
  } | undefined;
  if (ctxs?.some) {
    const status = ctxs.some.status;
    const s = sqlScalar(Prisma.sql`ac.status`, status, "AutomationCtxStatus");
    if (!s) return null;
    parts.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM automation_contexts ac
        WHERE ac."contactId" = c."contactId"
          AND ac."organizationId" = ${orgId}
          AND ${s}
      )`,
    );
  }

  const isRel = (contact as { is?: Prisma.ContactWhereInput }).is;
  if (isRel) {
    const inner = sqlContactFilter(isRel, orgId);
    if (!inner) return null;
    parts.push(inner);
  }

  const used = new Set([
    "OR",
    "AND",
    "assignedToId",
    "source",
    "deals",
    "tags",
    "automationContexts",
    "is",
  ]);
  if (Object.keys(contact).some((k) => !used.has(k) && contact[k as keyof Prisma.ContactWhereInput] !== undefined)) {
    return null;
  }
  if (parts.length === 0) return Prisma.sql`TRUE`;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM contacts ct
    WHERE ct.id = c."contactId"
      AND ct."organizationId" = ${orgId}
      AND ${Prisma.join(parts, " AND ")}
  )`;
}

function sqlConversationWhere(
  where: Prisma.ConversationWhereInput,
  orgId: string,
): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];

  if (where.AND) {
    const and = Array.isArray(where.AND) ? where.AND : [where.AND];
    for (const branch of and) {
      if (!branch || typeof branch !== "object") continue;
      const s = sqlConversationWhere(branch as Prisma.ConversationWhereInput, orgId);
      if (!s) return null;
      parts.push(s);
    }
  }
  if (where.OR) {
    const orParts: Prisma.Sql[] = [];
    for (const branch of where.OR) {
      const s = sqlConversationWhere(branch, orgId);
      if (!s) return null;
      orParts.push(s);
    }
    if (orParts.length > 0) parts.push(Prisma.sql`(${Prisma.join(orParts, " OR ")})`);
  }
  if (where.NOT) {
    const not = Array.isArray(where.NOT) ? { AND: where.NOT } : where.NOT;
    const s = sqlConversationWhere(not, orgId);
    if (!s) return null;
    parts.push(Prisma.sql`NOT (${s})`);
  }

  const scalars: Array<[keyof Prisma.ConversationWhereInput, Prisma.Sql, string?]> = [
    ["organizationId", Prisma.sql`c."organizationId"`],
    ["id", Prisma.sql`c.id`],
    ["contactId", Prisma.sql`c."contactId"`],
    ["assignedToId", Prisma.sql`c."assignedToId"`],
    ["channelId", Prisma.sql`c."channelId"`],
    ["channel", Prisma.sql`c.channel`],
    ["status", Prisma.sql`c.status`, "ConversationStatus"],
    ["closedAt", Prisma.sql`c."closedAt"`],
    ["hasError", Prisma.sql`c."hasError"`],
    ["hasHumanReply", Prisma.sql`c."hasHumanReply"`],
    ["hasAgentReply", Prisma.sql`c."hasAgentReply"`],
    ["lastInboundAt", Prisma.sql`c."lastInboundAt"`],
    ["lastMessageDirection", Prisma.sql`c."lastMessageDirection"`],
    ["inboxName", Prisma.sql`c."inboxName"`],
    ["number", Prisma.sql`c.number`],
    ["departmentId", Prisma.sql`c."departmentId"`],
    ["whatsappCallConsentStatus", Prisma.sql`c."whatsappCallConsentStatus"`, "WhatsappCallConsentStatus"],
    ["whatsappCallConsentExpiresAt", Prisma.sql`c."whatsappCallConsentExpiresAt"`],
  ];

  for (const [key, col, enumCast] of scalars) {
    if (where[key] === undefined) continue;
    const s = sqlScalar(col, where[key], enumCast);
    if (!s) return null;
    parts.push(s);
  }

  if (where.assignedTo) {
    const assignedTo = where.assignedTo as { is?: { type?: string } };
    const type = assignedTo.is?.type;
    if (type !== "HUMAN" && type !== "AI") return null;
    parts.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = c."assignedToId"
          AND u.type = ${type}::"UserType"
      )`,
    );
  }

  if (where.contact) {
    const contactBag = where.contact as Prisma.ContactWhereInput & {
      is?: Prisma.ContactWhereInput;
    };
    const contactWhere =
      contactBag.is && !("source" in contactBag)
        ? contactBag.is
        : contactBag;
    const s = sqlContactFilter(contactWhere, orgId);
    if (!s) return null;
    if (where.contactId === null) {
      parts.push(Prisma.sql`(c."contactId" IS NULL OR ${s})`);
    } else {
      parts.push(s);
    }
  }

  const known = new Set([
    "AND",
    "OR",
    "NOT",
    "organizationId",
    "id",
    "contactId",
    "assignedToId",
    "channelId",
    "channel",
    "status",
    "closedAt",
    "hasError",
    "hasHumanReply",
    "hasAgentReply",
    "lastInboundAt",
    "lastMessageDirection",
    "inboxName",
    "number",
    "departmentId",
    "whatsappCallConsentStatus",
    "whatsappCallConsentExpiresAt",
    "assignedTo",
    "contact",
  ]);
  if (
    Object.keys(where).some(
      (k) => !known.has(k) && where[k as keyof Prisma.ConversationWhereInput] !== undefined,
    )
  ) {
    return null;
  }
  if (parts.length === 0) return Prisma.sql`TRUE`;
  return Prisma.join(parts, " AND ");
}

async function countConversationsLikeList(
  conditions: Prisma.ConversationWhereInput[],
  collapseByContact: boolean,
  assigneeIdsByType?: AssigneeIdsByType,
): Promise<number> {
  const byType = assigneeIdsByType ?? (await loadAssigneeIdsByType());
  const collapsed = conditions.map((c) => rewriteAssignedToType(c, byType));
  const where: Prisma.ConversationWhereInput =
    collapsed.length > 0 ? { AND: collapsed } : {};
  if (!collapseByContact) return prisma.conversation.count({ where });

  const orgId = getOrgIdOrNull();
  if (!orgId) return prisma.conversation.count({ where });

  const scoped: Prisma.ConversationWhereInput = {
    AND: [...collapsed, { organizationId: orgId }],
  };
  const sql = sqlConversationWhere(scoped, orgId);
  if (!sql) {
    return prisma.contact.count({
      where: { conversations: { some: scoped } },
    });
  }
  const rows = await prisma.$queryRaw<[{ n: number }]>`
    SELECT COUNT(DISTINCT CASE
      WHEN c."contactId" IS NULL THEN 'id:' || c.id
      ELSE 'c:' || c."contactId" || '::' || COALESCE(c.channel, '')
    END)::int AS n
    FROM conversations c
    WHERE ${sql}
  `;
  return rows[0]?.n ?? 0;
}

async function countTodosTab(
  visibilityWhere: Prisma.ConversationWhereInput | undefined,
  memberOrTabs: InboxCategoryTab[] | null,
  allowedChannelIds?: string[] | null,
  filterConditions?: Prisma.ConversationWhereInput[],
  searchWhere?: Prisma.ConversationWhereInput | null,
  countAgentReply = false,
  collapseByContact = true,
  assigneeIdsByType?: AssigneeIdsByType,
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
  return countConversationsLikeList(conditions, collapseByContact, assigneeIdsByType);
}

function inboxTabCountsScopeFp(args: {
  visibilityWhere?: Prisma.ConversationWhereInput;
  todosMemberCategoryTabs?: InboxCategoryTab[] | null;
  allowedChannelIds?: string[] | null;
  filterConditions?: Prisma.ConversationWhereInput[];
  search?: string | null;
  collapseByContact: boolean;
}): string | null {
  try {
    return createHash("sha1")
      .update(
        JSON.stringify({
          k: 4,
          v: args.visibilityWhere ?? null,
          m: args.todosMemberCategoryTabs ?? null,
          c: args.allowedChannelIds ?? null,
          f: args.filterConditions ?? [],
          s: args.search?.trim() || null,
          g: args.collapseByContact,
        }),
      )
      .digest("hex")
      .slice(0, 20);
  } catch {
    return null;
  }
}

/** Peek do Redis das badges — não recomputa COUNT no miss. */
async function peekCachedTabTotal(
  params: GetConversationsParams,
  collapse: boolean,
): Promise<number | null> {
  const tab = params.tab;
  if (!tab) return null;
  const orgId = getOrgIdOrNull();
  if (!orgId) return null;
  const fp = inboxTabCountsScopeFp({
    visibilityWhere: params.visibilityWhere,
    todosMemberCategoryTabs: params.todosCategoryTabs ?? null,
    allowedChannelIds: params.allowedChannelIds,
    filterConditions: buildInboxFilterConditions(params),
    search: params.search,
    collapseByContact: collapse,
  });
  if (!fp) return null;
  const cached = await cache.get<Record<InboxTab, number>>(
    inboxTabCountsKey(orgId, fp),
  );
  if (!cached) return null;
  const n = cached[tab];
  return typeof n === "number" && n >= 0 ? n : null;
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
  const scopeFp = inboxTabCountsScopeFp({
    visibilityWhere,
    todosMemberCategoryTabs,
    allowedChannelIds,
    filterConditions,
    search,
    collapseByContact,
  });
  if (!scopeFp) {
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

function tabCountExpr(tabCond: Prisma.Sql, collapse: boolean): Prisma.Sql {
  if (collapse) {
    return Prisma.sql`COUNT(DISTINCT CASE
      WHEN c."contactId" IS NULL THEN 'id:' || c.id
      ELSE 'c:' || c."contactId" || '::' || COALESCE(c.channel, '')
    END) FILTER (WHERE ${tabCond})::int`;
  }
  return Prisma.sql`COUNT(*) FILTER (WHERE ${tabCond})::int`;
}

async function tryComputeTabCountsOneSql(args: {
  visibilityCollapsed?: Prisma.ConversationWhereInput;
  todosMemberCategoryTabs?: InboxCategoryTab[] | null;
  allowedChannelIds?: string[] | null;
  extra: Prisma.ConversationWhereInput[];
  searchWhere: Prisma.ConversationWhereInput | null;
  countAgentReply: boolean;
  collapseByContact: boolean;
}): Promise<Record<InboxTab, number> | null> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return null;

  const shared: Prisma.ConversationWhereInput[] = [{ organizationId: orgId }];
  if (args.visibilityCollapsed && Object.keys(args.visibilityCollapsed).length > 0) {
    shared.push(args.visibilityCollapsed);
  }
  if (args.allowedChannelIds) {
    shared.push({ channelId: { in: args.allowedChannelIds } });
  }
  if (args.extra.length > 0) shared.push(...args.extra);
  if (args.searchWhere) shared.push(args.searchWhere);

  const sharedSql = sqlConversationWhere({ AND: shared }, orgId);
  if (!sharedSql) return null;

  const tabSql = (where: Prisma.ConversationWhereInput): Prisma.Sql | null =>
    sqlConversationWhere(where, orgId);

  const entrada = tabSql(tabToWhere("entrada", args.countAgentReply));
  const esperando = tabSql(tabToWhere("esperando", args.countAgentReply));
  const respondidas = tabSql(tabToWhere("respondidas", args.countAgentReply));
  const agenteIa = tabSql(tabToWhere("agente_ia", args.countAgentReply));
  const automacao = tabSql(tabToWhere("automacao", args.countAgentReply));
  const finalizados = tabSql(tabToWhere("finalizados", args.countAgentReply));
  const erro = tabSql(tabToWhere("erro", args.countAgentReply));
  const abertas = tabSql(activeInboxQueueGuardWhere());
  const ligar = tabSql(ligarTabWhere());
  const todosWhere =
    args.todosMemberCategoryTabs && args.todosMemberCategoryTabs.length > 0
      ? {
          OR: args.todosMemberCategoryTabs.map((t) =>
            tabToWhere(t, args.countAgentReply),
          ),
        }
      : null;
  const todos = todosWhere ? tabSql(todosWhere) : Prisma.sql`TRUE`;

  if (
    !entrada ||
    !esperando ||
    !respondidas ||
    !agenteIa ||
    !automacao ||
    !finalizados ||
    !erro ||
    !abertas ||
    !ligar ||
    !todos
  ) {
    return null;
  }

  const collapse = args.collapseByContact;
  try {
    const rows = await prisma.$queryRaw<
      [{
        entrada: number;
        esperando: number;
        respondidas: number;
        agente_ia: number;
        automacao: number;
        finalizados: number;
        erro: number;
        todos: number;
        abertas: number;
        ligar: number;
      }]
    >`
      SELECT
        ${tabCountExpr(entrada, false)} AS entrada,
        ${tabCountExpr(esperando, false)} AS esperando,
        ${tabCountExpr(respondidas, false)} AS respondidas,
        ${tabCountExpr(agenteIa, false)} AS agente_ia,
        ${tabCountExpr(automacao, false)} AS automacao,
        ${tabCountExpr(finalizados, collapse)} AS finalizados,
        ${tabCountExpr(erro, false)} AS erro,
        ${tabCountExpr(todos, collapse)} AS todos,
        ${tabCountExpr(abertas, false)} AS abertas,
        ${tabCountExpr(ligar, false)} AS ligar
      FROM conversations c
      WHERE ${sharedSql}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      entrada: row.entrada ?? 0,
      esperando: row.esperando ?? 0,
      respondidas: row.respondidas ?? 0,
      agente_ia: row.agente_ia ?? 0,
      automacao: row.automacao ?? 0,
      finalizados: row.finalizados ?? 0,
      erro: row.erro ?? 0,
      todos: row.todos ?? 0,
      abertas: row.abertas ?? 0,
      ligar: row.ligar ?? 0,
    };
  } catch (err) {
    getLogger("conversations").warn(
      { err },
      "tab counts one-SQL failed — falling back to sequential COUNT",
    );
    return null;
  }
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
  const [countAgentReply, assigneeIdsByType] = await Promise.all([
    countAgentReplyAsAnswered(),
    loadAssigneeIdsByType(),
  ]);
  const visibilityCollapsed =
    visibilityWhere && Object.keys(visibilityWhere).length > 0
      ? rewriteAssignedToType(visibilityWhere, assigneeIdsByType)
      : visibilityWhere;

  const oneSql = await tryComputeTabCountsOneSql({
    visibilityCollapsed,
    todosMemberCategoryTabs,
    allowedChannelIds,
    extra,
    searchWhere,
    countAgentReply,
    collapseByContact,
  });
  if (oneSql) return oneSql;

  // Fallback: where não traduziu (filtro raro) — sequencial pra não
  // esgotar o pool com 8 COUNT em paralelo.
  const lightTabs = TAB_LIST.filter((t) => t !== "finalizados");
  const countTab = async (tab: InboxCategoryTab) => {
    const conditions: Prisma.ConversationWhereInput[] = [];
    if (visibilityCollapsed && Object.keys(visibilityCollapsed).length > 0) {
      conditions.push(visibilityCollapsed);
    }
    conditions.push(tabToWhere(tab, countAgentReply));
    if (allowedChannelIds) {
      conditions.push({ channelId: { in: allowedChannelIds } });
    }
    if (extra.length > 0) conditions.push(...extra);
    if (searchWhere) conditions.push(searchWhere);
    return countConversationsLikeList(
      conditions,
      collapseByContact && tab === "finalizados",
      assigneeIdsByType,
    );
  };

  const lightResults: Array<readonly [InboxCategoryTab, number]> = [];
  for (const tab of lightTabs) {
    lightResults.push([tab, await countTab(tab)]);
  }
  const finalizados = await countTab("finalizados");
  const todos = await countTodosTab(
    visibilityCollapsed,
    todosMemberCategoryTabs ?? null,
    allowedChannelIds,
    extra,
    searchWhere,
    countAgentReply,
    collapseByContact,
    assigneeIdsByType,
  );
  const abertas = await (() => {
    const conditions: Prisma.ConversationWhereInput[] = [];
    if (visibilityCollapsed && Object.keys(visibilityCollapsed).length > 0) {
      conditions.push(visibilityCollapsed);
    }
    conditions.push({ status: "OPEN" });
    if (allowedChannelIds) conditions.push({ channelId: { in: allowedChannelIds } });
    if (extra.length > 0) conditions.push(...extra);
    if (searchWhere) conditions.push(searchWhere);
    return countConversationsLikeList(conditions, false, assigneeIdsByType);
  })();
  const ligar = await (() => {
    const conditions: Prisma.ConversationWhereInput[] = [];
    if (visibilityCollapsed && Object.keys(visibilityCollapsed).length > 0) {
      conditions.push(visibilityCollapsed);
    }
    conditions.push(ligarTabWhere());
    if (allowedChannelIds) conditions.push({ channelId: { in: allowedChannelIds } });
    if (extra.length > 0) conditions.push(...extra);
    if (searchWhere) conditions.push(searchWhere);
    return countConversationsLikeList(conditions, false, assigneeIdsByType);
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
  const lastInboundMap = new Map<string, Date>();
  if (row.lastInboundAt) lastInboundMap.set(convId, row.lastInboundAt);
  const [previewMap] = await Promise.all([
    lastMessagePreviewsBatch([convId]),
    fillMissingLastInboundFromSiblings(
      [
        {
          id: convId,
          contactId: row.contact?.id ?? null,
          lastInboundAt: row.lastInboundAt,
        },
      ],
      lastInboundMap,
    ),
  ]);
  await applyChannelSessionResetToInboundMap([convId], lastInboundMap);
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
 * Lotes até este tamanho reatribuem na API (mesmo `assignConversationAssignedTo`
 * do kebab). Acima disso a rota enfileira o leads-worker — o toast de sucesso
 * só deve sair depois do persist, nunca no 202.
 */
export const BULK_ASSIGN_SYNC_LIMIT = 2000;

/**
 * Reatribui / remove responsável conversa a conversa, com o mesmo RBAC e
 * sincronização contato+negócios do assign individual. O toast de sucesso
 * só deve sair depois desta persistência.
 */
export async function assignConversationsInline(params: {
  ids: string[];
  assignedToId: string | null;
  actor: {
    id: string;
    role: AppUserRole;
    canReassignOthers?: boolean;
    canTransfer?: boolean;
  };
  organizationId: string;
  source?: string;
}): Promise<{ updated: number; skipped: string[] }> {
  const skipped: string[] = [];
  let updated = 0;
  const source = params.source ?? "bulk-sync";
  const actorId = params.actor.id;
  const { cancelAiReplyDebounce } = await import(
    "@/services/ai/inbound-debounce"
  );
  const { createDealEvent } = await import("@/services/deals");

  for (const conversationId of params.ids) {
    try {
      const prev = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          assignedToId: true,
          contactId: true,
          externalId: true,
          assignedTo: { select: { id: true, name: true } },
        },
      });
      const result = await assignConversationAssignedTo(
        conversationId,
        params.assignedToId,
        params.actor,
      );
      if (!result.ok) {
        skipped.push(conversationId);
        continue;
      }
      updated += 1;
      const nextId = result.conversation.assignedToId ?? null;
      if ((prev?.assignedToId ?? null) === nextId) continue;

      cancelAiReplyDebounce(conversationId, "assignee_changed");
      const fromName = prev?.assignedTo?.name ?? null;
      const toName = result.conversation.assignedTo?.name ?? null;
      if (prev?.contactId) {
        const deals = await prisma.deal.findMany({
          where: { contactId: prev.contactId, status: "OPEN" },
          select: { id: true },
        });
        await Promise.all(
          deals.map((d) =>
            createDealEvent(d.id, actorId, "ASSIGNEE_CHANGED", {
              conversationId,
              from: prev.assignedToId
                ? { id: prev.assignedToId, name: fromName }
                : null,
              to: nextId ? { id: nextId, name: toName } : null,
            }).catch(() => undefined),
          ),
        );
      }
      await logEvent({
        type: "ASSIGNEE_CHANGED",
        entityType: "CONVERSATION",
        entityId: conversationId,
        entityLabel: result.conversation.externalId ?? null,
        conversationId,
        contactId: result.conversation.contactId ?? null,
        field: "assignedTo",
        oldValue: fromName,
        newValue: toName,
        meta: {
          fromUserId: prev?.assignedToId ?? null,
          toUserId: nextId,
          source,
        },
      }).catch(() => undefined);
      try {
        sseBus.publish("conversation_updated", {
          organizationId: params.organizationId,
          conversationId,
          assignedToId: nextId,
          assignedTo: result.conversation.assignedTo
            ? { type: result.conversation.assignedTo.type }
            : null,
        });
        sseBus.publish("conversation_timeline_updated", {
          organizationId: params.organizationId,
          conversationId,
          type: "ASSIGNEE_CHANGED",
        });
      } catch {
        /* best-effort */
      }
    } catch {
      skipped.push(conversationId);
    }
  }

  if (updated > 0) {
    void invalidateInboxTabCounts(params.organizationId);
  }

  return { updated, skipped };
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
        actorUserId: userIdForFk(getRequestContext()?.userId),
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

/**
 * Lotes até este tamanho fecham na API com updateMany — não dependem do
 * leads-worker. O teto antigo (100) mandava 107 "Respondidas" pra fila:
 * o toast saía 202 e as conversas ficavam OPEN se o worker não consumisse.
 */
export const BULK_RESOLVE_SYNC_LIMIT = 2000;
const BULK_RESOLVE_CHUNK = 50;

export type BulkResolveTabulation = {
  tabulationId: string;
  departmentId: string;
  name: string;
  number: number;
  ancestorIds: string[];
};

/**
 * Encerra conversas com updateMany (status RESOLVED + closedAt).
 * O toast de sucesso só deve sair depois desta persistência.
 */
export async function resolveConversationsInline(params: {
  ids: string[];
  keepAgent: boolean;
  keepDepartment: boolean;
  tabulation?: BulkResolveTabulation | null;
  skipAutomations?: boolean;
}): Promise<{ updated: number; missing: number }> {
  const tab = params.tabulation ?? null;
  const applyTab = Boolean(tab);
  let updated = 0;
  let missing = 0;
  const source = "bulk-sync";
  const closePatch = {
    status: "RESOLVED" as const,
    closedAt: new Date(),
    hasError: false,
    ...(params.keepAgent ? {} : { assignedToId: null }),
    ...(params.keepDepartment ? {} : { departmentId: null }),
    ...(applyTab && tab ? { tabulationId: tab.tabulationId } : {}),
  };

  for (let i = 0; i < params.ids.length; i += BULK_RESOLVE_CHUNK) {
    const chunkIds = params.ids.slice(i, i + BULK_RESOLVE_CHUNK);
    const convs = await prisma.conversation.findMany({
      where: { id: { in: chunkIds } },
      select: {
        id: true,
        status: true,
        contactId: true,
        departmentId: true,
        organizationId: true,
        externalId: true,
        assignedToId: true,
        assignedTo: { select: { name: true } },
        contact: { select: { name: true } },
      },
    });
    const found = new Set(convs.map((c) => c.id));
    missing += chunkIds.filter((id) => !found.has(id)).length;
    const toResolve = convs.filter((c) => c.status !== "RESOLVED");
    if (toResolve.length === 0) continue;

    await prisma.conversation.updateMany({
      where: {
        id: { in: toResolve.map((c) => c.id) },
        status: { not: "RESOLVED" },
      },
      data: closePatch,
    });
    updated += toResolve.length;

    if (!params.keepAgent) {
      const pairs = new Map<string, { contactId: string; userId: string }>();
      for (const conv of toResolve) {
        if (conv.contactId && conv.assignedToId) {
          pairs.set(`${conv.contactId}:${conv.assignedToId}`, {
            contactId: conv.contactId,
            userId: conv.assignedToId,
          });
        }
      }
      if (pairs.size > 0) {
        const { clearContactOwnershipOnClose } = await import("@/services/deals");
        for (const { contactId, userId } of pairs.values()) {
          await clearContactOwnershipOnClose({
            contactId,
            clearedUserId: userId,
            actorUserId: userIdForFk(getRequestContext()?.userId),
          }).catch(() => {});
        }
      }
    }

    const { tabulationLogMeta } = applyTab
      ? await import("@/services/tabulations")
      : { tabulationLogMeta: null };

    for (const conv of toResolve) {
      if (!params.keepAgent && conv.assignedToId) {
        void logEvent({
          type: "ASSIGNEE_CHANGED",
          entityType: "CONVERSATION",
          entityId: conv.id,
          entityLabel: conv.contact?.name ?? conv.externalId ?? null,
          conversationId: conv.id,
          contactId: conv.contactId,
          field: "assignedTo",
          oldValue: conv.assignedTo?.name ?? null,
          newValue: null,
          meta: {
            fromUserId: conv.assignedToId,
            toUserId: null,
            reason: "conversation_closed",
            source,
          },
        }).catch(() => {});
      }
      void logEvent({
        type: "CONVERSATION_CLOSED",
        entityType: "CONVERSATION",
        entityId: conv.id,
        entityLabel: conv.contact?.name ?? conv.externalId ?? null,
        conversationId: conv.id,
        contactId: conv.contactId,
        field: "status",
        oldValue: conv.status,
        newValue: "RESOLVED",
        meta: {
          from: conv.status,
          to: "RESOLVED",
          source,
          ...(applyTab && tab ? { tabulationId: tab.tabulationId } : {}),
          ...(params.skipAutomations ? { skipAutomations: true } : {}),
        },
      }).catch(() => {});

      if (applyTab && tab && tabulationLogMeta) {
        void logEvent({
          type: "CONVERSATION_TABULATED",
          entityType: "CONVERSATION",
          entityId: conv.id,
          entityLabel: conv.contact?.name ?? conv.externalId ?? null,
          conversationId: conv.id,
          contactId: conv.contactId,
          meta: tabulationLogMeta(
            {
              tabulationId: tab.tabulationId,
              ancestorIds: tab.ancestorIds,
              departmentId: tab.departmentId,
              name: tab.name,
              number: tab.number,
            },
            { source },
          ),
        }).catch(() => {});
      }

      if (!params.skipAutomations) {
        void (async () => {
          const { fireTrigger } = await import("@/services/automation-triggers");
          let dealId: string | undefined;
          if (conv.contactId) {
            const deal = await prisma.deal.findFirst({
              where: { contactId: conv.contactId, status: "OPEN" },
              orderBy: { createdAt: "desc" },
              select: { id: true },
            });
            dealId = deal?.id;
          }
          await fireTrigger("conversation_tabulated", {
            contactId: conv.contactId ?? undefined,
            dealId,
            data: {
              tabulationId: applyTab && tab ? tab.tabulationId : null,
              ancestorIds: applyTab && tab ? tab.ancestorIds : [],
              departmentId: conv.departmentId ?? tab?.departmentId ?? null,
              conversationId: conv.id,
            },
          });
        })().catch(() => {});
      }

      try {
        sseBus.publish("conversation_updated", {
          organizationId: conv.organizationId,
          conversationId: conv.id,
          status: "RESOLVED",
          closedAt: new Date().toISOString(),
        });
        sseBus.publish("conversation_timeline_updated", {
          organizationId: conv.organizationId,
          conversationId: conv.id,
          type: "CONVERSATION_CLOSED",
        });
      } catch {
        /* best-effort */
      }
    }
  }

  if (updated > 0) {
    const orgId = getOrgIdOrNull();
    if (orgId) void invalidateInboxTabCounts(orgId);
    void import("@/services/distribution/pending")
      .then((m) =>
        m.scheduleProcessPendingDistributionQueue({
          trigger: "capacity_released",
          delayMs: 400,
        }),
      )
      .catch(() => {});
  }

  return { updated, missing };
}
