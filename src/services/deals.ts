import {
  Prisma,
  type ConversationStatus,
  type DealRole,
  type DealStatus,
} from "@prisma/client";

import { defaultDealTitleForContact } from "@/lib/display-name";
import { allocateOrgNumber, prisma, type ScopedTx } from "@/lib/prisma";
import {
  isReplaySandboxActive,
  recordBlockedEffect,
} from "@/services/ai/replay-sandbox";
import { withOrg, withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull, getOrgIdOrThrow, type ContextActor } from "@/lib/request-context";
import {
  publishConversationTimelineUpdated,
  publishDealMoved,
  type DealMovedCard,
  type DealMovedPayload,
} from "@/lib/realtime-events";
import { getOrgSettingBool } from "@/lib/org-settings";
import {
  lockOpenCommercialContactExclusive,
  lockOpenCommercialPipelineShared,
  OPEN_COMMERCIAL_CREATE_TX_MS,
  pipelineForbidsDuplicateDeals,
} from "@/services/deal-duplicates";
import { preferConversationWithLastMessage } from "@/services/deal-panel-conversation";
import {
  logEvent,
  userIdForFk,
  withAutomationOriginMeta,
} from "@/services/activity-log";
import { getStageMetrics } from "@/services/analytics";
import { enrichContactsWithUserAvatarFallback } from "@/lib/contact-avatar-fallback";
import { cache, type TextCacheSource } from "@/lib/cache";
import { boardDataKey, invalidateBoardData } from "@/lib/cache/keys";
import type { ServerTiming } from "@/lib/server-timing";
import {
  BOARD_MAX_PER_STAGE,
  canonicalBoardVariant,
  normalizeBoardOffsets,
  normalizeBoardPerStage,
} from "@/services/board-cache-variant";
import {
  boardColumnKeysetWhere,
  boardColumnOrderBy,
  encodeBoardColumnCursor,
  normalizeBoardCursorSort,
  parseBoardColumnCursor,
  type BoardColumnCursor,
  type BoardCursorDirection,
  type BoardCursorSort,
} from "@/services/board-column-cursor";
import {
  buildDealWhereFromFilters,
  createDealSearch,
  type AdvancedDealFilters,
  type DealSearch,
} from "@/services/kanban-filters";
import { NON_CHAT_MESSAGE_TYPES } from "@/lib/conversation-last-message";
import { getLogger } from "@/lib/logger";

const log = getLogger("deals");

/**
 * Valida o motivo da perda no contexto do funil.
 *
 * - Com `pipelineId`: usa `pipelines.lossReasonAllowOther`.
 * - Sem funil: fallback na org setting `deals.loss_reason_allow_other`.
 *
 * Motivo vazio/null é no-op (obrigatoriedade é outra checagem).
 * Throws `Error("INVALID_LOST_REASON")` — handlers → HTTP 400.
 */
export async function assertLostReasonAllowed(
  reason: string | null | undefined,
  pipelineId?: string | null,
): Promise<void> {
  const trimmed = reason?.trim();
  if (!trimmed) return;

  const {
    assertLostReasonAllowedForPipeline,
    isPipelineLossReasonAllowOther,
  } = await import("@/services/loss-reasons");

  let allowOther = true;
  try {
    if (pipelineId) {
      allowOther = await isPipelineLossReasonAllowOther(pipelineId);
    } else {
      allowOther = await getOrgSettingBool(
        "deals.loss_reason_allow_other",
        true,
      );
    }
  } catch (e) {
    log.warn(
      { err: (e as Error)?.message ?? e },
      "[deals/assertLostReasonAllowed] Falha lendo allowOther; permitindo",
    );
    return;
  }
  await assertLostReasonAllowedForPipeline(pipelineId, trimmed, allowOther);
}

export function isValidDealStatus(v: string): v is DealStatus {
  return v === "OPEN" || v === "WON" || v === "LOST";
}

/**
 * Cria um `DealEvent` (log legado) E um `ActivityEvent` (log novo) para
 * o mesmo evento. Mantida a assinatura original para nao quebrar os
 * ~30 call sites existentes em routes/services.
 *
 * Quando todas as features da UI estiverem apontando para `activity_events`,
 * a escrita em `deal_events` pode ser removida e este wrapper passa a
 * delegar apenas para `logEvent`. Por ora mantemos os dois para que
 * panels existentes (timeline) continuem funcionando durante o cutover.
 *
 * Extrai `field/oldValue/newValue` do `meta` (chaves `from`/`to`/`field`
 * sao convencao em quase todos os call sites) para popular as colunas
 * dedicadas do novo log.
 */
/// Extrai field/old/new do meta (convencao herdada do log antigo).
function deriveDealEventColumns(meta: Record<string, unknown>) {
  const field =
    typeof meta.field === "string"
      ? (meta.field as string)
      : typeof meta.fieldKey === "string"
        ? (meta.fieldKey as string)
        : null;
  const oldValue =
    meta.from !== undefined && meta.from !== null
      ? String(meta.from)
      : meta.oldValue !== undefined && meta.oldValue !== null
        ? String(meta.oldValue)
        : null;
  const newValue =
    meta.to !== undefined && meta.to !== null
      ? String(meta.to)
      : meta.newValue !== undefined && meta.newValue !== null
        ? String(meta.newValue)
        : null;
  return { field, oldValue, newValue };
}

export type DealEventInput = {
  dealId: string;
  userId: string | null;
  type: string;
  meta?: Record<string, unknown>;
};

/**
 * Versão em lote de `createDealEvent`, para handlers de operação em massa.
 *
 * Diferenças em relação a chamar `createDealEvent` N vezes:
 *   - o log legado `deal_events` vira um único `createMany` (N inserts em
 *     1 round-trip);
 *   - as gravações em `activity_events` deixam de ser N promises soltas e
 *     passam por um limite de 3 em voo, para não estourar o pool do worker.
 *
 * Continua best-effort: erros são logados e nunca sobem para o chamador.
 */
export async function createDealEventsMany(
  events: DealEventInput[],
): Promise<void> {
  if (events.length === 0) return;

  const rows = events.map((e) => {
    const meta = e.meta ?? {};
    return {
      input: e,
      meta,
      columns: deriveDealEventColumns(meta),
      metaJson: withAutomationOriginMeta(meta),
      userId: userIdForFk(e.userId),
    };
  });

  try {
    await prisma.dealEvent.createMany({
      data: rows.map((r) =>
        withOrgFromCtx({
          dealId: r.input.dealId,
          userId: r.userId,
          type: r.input.type,
          meta: r.metaJson,
        }),
      ),
    });
  } catch {
    // Mesmo fallback do singular: FK de userId inválida derruba o lote
    // inteiro, então re-tenta sem atribuir o autor.
    try {
      await prisma.dealEvent.createMany({
        data: rows.map((r) =>
          withOrgFromCtx({
            dealId: r.input.dealId,
            userId: null,
            type: r.input.type,
            meta: r.metaJson,
          }),
        ),
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[createDealEventsMany] falha ao gravar deal_events em lote",
      );
    }
  }

  const LOG_EVENT_CONCURRENCY = 3;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(LOG_EVENT_CONCURRENCY, rows.length) },
    async () => {
      while (cursor < rows.length) {
        const r = rows[cursor++];
        await logEvent({
          type: r.input.type,
          entityType: "DEAL",
          entityId: r.input.dealId,
          dealId: r.input.dealId,
          field: r.columns.field,
          oldValue: r.columns.oldValue,
          newValue: r.columns.newValue,
          meta: r.meta,
        });
      }
    },
  );
  await Promise.all(workers);
}

export function createDealEvent(
  dealId: string,
  userId: string | null,
  type: string,
  meta: Record<string, unknown> = {},
  /**
   * Override do ator gravado em `activity_events` (não afeta o legado
   * `deal_events`). Use quando o evento tem uma origem específica que o
   * `RequestContext` não captura — ex.: `move_stage` disparado por
   * automação passa `{ type: "AUTOMATION", label: "Automação: <nome>" }`
   * para que a timeline mostre "por Automação: <nome>" em vez de
   * "por Sistema". Sem override, o `logEvent` usa o ator do contexto.
   */
  actorOverride?: ContextActor,
) {
  // Mesma origem de automacao gravada no log novo (ver
  // `withAutomationOriginMeta`) — o endpoint da timeline cai no
  // `deal_events` legado quando o deal nao tem activity_events.
  const metaJson = withAutomationOriginMeta(meta);
  const { field, oldValue, newValue } = deriveDealEventColumns(meta);
  // Placeholders do worker (`"system"` via withSystemContext) e ids que
  // não existem em `users` quebram `deal_events_userId_fkey`. Schema
  // permite null — não inventar user.
  const safeUserId = userIdForFk(userId);
  const orgId = getOrgIdOrNull();

  // Fire-and-forget para o novo log — falhas nao afetam o legado.
  // Snapshot do orgId agora: `void logEvent` pode correr depois do ALS.
  void logEvent({
    type,
    entityType: "DEAL",
    entityId: dealId,
    dealId,
    field,
    oldValue,
    newValue,
    meta,
    organizationId: orgId,
    ...(actorOverride ? { actor: actorOverride } : {}),
  });

  if (!orgId) {
    return Promise.resolve();
  }

  return prisma.dealEvent
    .create({
      data: withOrg({ dealId, userId: safeUserId, type, meta: metaJson }, orgId),
    })
    .catch(() =>
      prisma.dealEvent.create({
        data: withOrg({ dealId, userId: null, type, meta: metaJson }, orgId),
      }),
    );
}

export type GetDealsParams = {
  pipelineId?: string;
  stageId?: string;
  status?: DealStatus;
  ownerId?: string;
  search?: string;
  /**
   * Match EXATO pelo email do contato dono do deal (case-insensitive).
   * Espelha o pattern `emailExact` de `getContacts` — pensado para que
   * integrações respondam "esse cliente tem deal aberto?" sem precisar
   * fazer GET de contacts antes.
   */
  contactEmail?: string;
  /** Match EXATO pelo telefone do contato (tolerante a formatação). */
  contactPhone?: string;
  /** Match direto por contactId — útil quando o caller já tem o id resolvido. */
  contactId?: string;
  page?: number;
  perPage?: number;
  /**
   * `false` = não rodar o `COUNT(*)` da lista (K5). A resposta sempre traz
   * `hasMore` (uma linha a mais que a página); `total` vem preenchido quando
   * sai de graça (última página) e `null` quando exigiria contar. Ausente ou
   * `true` = conta como sempre (contrato antigo: `total` numérico).
   */
  withTotal?: boolean;
  visibilityWhere?: Prisma.DealWhereInput;
  /**
   * Escopo de funis por usuário. `null/undefined` → sem restrição; array
   * (mesmo vazio) → restringe deals aos estágios desses funis.
   */
  allowedPipelineIds?: string[] | null;
  /** Mesma engine do POST /board — filtros avançados (tags, datas, custom…). */
  advancedFilters?: AdvancedDealFilters;
  /**
   * Incremental sync: só deals com `updatedAt >=`. Integrações devem
   * paginar isto em vez de N× GET /api/deals/:id.
   */
  updatedSince?: Date;
  /**
   * `lastInteraction` ordena o recorte inteiro (não a página) pelo mesmo
   * instante que a coluna da lista mostra — a última mensagem de chat do
   * contato; sem mensagem, o `updatedAt` do negócio — e só então aplica
   * skip/take. Ausente = `updatedAt` desc, como sempre.
   */
  sort?: "lastInteraction";
  direction?: "asc" | "desc";
};

/**
 * Página de ids já na ordem da coluna "Última interação": última mensagem
 * de chat do contato (`contacts.lastMessageAt` e, só se estiver NULL, o
 * fallback de `conversations`). Sem mensagem, cai no `updatedAt` do deal.
 * O `updatedAt` não entra quando já existe mensagem: etapa, campo ou dono
 * mexidos ontem não podem esconder a conversa mais antiga. O `ORDER BY`
 * roda antes do LIMIT, então a página 1 no sentido antigo é o mais
 * antigo do filtro, não o mais antigo dos que já estavam na tela.
 */
async function pageIdsByLastInteraction(
  where: Prisma.DealWhereInput,
  direction: "asc" | "desc",
  skip: number,
  take: number,
): Promise<string[]> {
  const idRows = await prisma.deal.findMany({ where, select: { id: true } });
  if (idRows.length === 0 || take <= 0) return [];
  const ids = idRows.map((row) => row.id);
  const orgId = getOrgIdOrThrow();
  const dir = direction === "asc" ? Prisma.raw("ASC") : Prisma.raw("DESC");
  const orderByMessage = Prisma.sql`
    ORDER BY COALESCE(
      ct."lastMessageAt",
      fb.last_at,
      d."updatedAt"
    ) ${dir}, d.id ASC
    OFFSET ${skip}
    LIMIT ${take}
  `;
  try {
    const ranked = await prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id
      FROM deals d
      LEFT JOIN contacts ct
        ON ct.id = d."contactId" AND ct."organizationId" = ${orgId}
      LEFT JOIN LATERAL (
        SELECT MAX(COALESCE(cv."lastMessageAt", cv."updatedAt")) AS last_at
        FROM conversations cv
        WHERE ct."lastMessageAt" IS NULL
          AND cv."organizationId" = ${orgId}
          AND cv."contactId" = d."contactId"
      ) fb ON TRUE
      WHERE d."organizationId" = ${orgId}
        AND d.id = ANY(${ids})
      ${orderByMessage}
    `;
    return ranked.map((row) => row.id);
  } catch (error) {
    if (!missingLastMessageColumn(error)) throw error;
    const ranked = await prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id
      FROM deals d
      WHERE d."organizationId" = ${orgId}
        AND d.id = ANY(${ids})
      ORDER BY d."updatedAt" ${dir}, d.id ASC
      OFFSET ${skip}
      LIMIT ${take}
    `;
    return ranked.map((row) => row.id);
  }
}

const listInclude = {
  contact: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      avatarUrl: true,
      source: true,
      // Última mensagem de chat do contato — insumo de `lastInteractionAt`
      // sem consultar `conversations` (K1).
      lastMessageAt: true,
      tags: {
        select: { tag: { select: { id: true, name: true, color: true } } },
      },
    },
  },
  tags: {
    select: { tag: { select: { id: true, name: true, color: true } } },
  },
  customFields: {
    select: { customFieldId: true, value: true },
  },
  stage: {
    select: {
      id: true,
      name: true,
      slug: true,
      number: true,
      position: true,
      color: true,
      pipelineId: true,
      pipeline: { select: { id: true, name: true, slug: true, number: true } },
    },
  },
  owner: { select: { id: true, name: true, email: true, avatarUrl: true, type: true } },
} satisfies Prisma.DealInclude;

/** Mesma lista sem `contacts.lastMessageAt` — banco ainda sem a migration. */
const listIncludeWithoutLastMessage = {
  ...listInclude,
  contact: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      avatarUrl: true,
      source: true,
      tags: {
        select: { tag: { select: { id: true, name: true, color: true } } },
      },
    },
  },
} satisfies Prisma.DealInclude;

function missingLastMessageColumn(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  if (!/lastMessageAt/i.test(message)) return false;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2022" || error.code === "P2010";
  }
  return (
    error instanceof Prisma.PrismaClientValidationError ||
    /does not exist|Unknown field/i.test(message)
  );
}

export async function getDeals(params: GetDealsParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  // Lista do Pipeline permite até 1000/página para seleção em massa.
  const perPage = Math.min(1000, Math.max(1, params.perPage ?? 20));
  const skip = (page - 1) * perPage;

  const conditions: Prisma.DealWhereInput[] = [];

  if (params.visibilityWhere && Object.keys(params.visibilityWhere).length > 0) {
    conditions.push(params.visibilityWhere);
  }

  // Pipeline soft-archived ("apagar pipeline" no CRM) não deve aparecer em
  // listagens — deal/stage continuam no banco, só somem da UI.
  conditions.push({ stage: { is: { pipeline: { is: { archivedAt: null } } } } });

  if (params.pipelineId) {
    conditions.push({ stage: { pipelineId: params.pipelineId } });
  }
  if (params.allowedPipelineIds) {
    conditions.push({ stage: { pipelineId: { in: params.allowedPipelineIds } } });
  }
  if (params.stageId) {
    conditions.push({ stageId: params.stageId });
  }
  if (params.status) {
    conditions.push({ status: params.status });
  }
  if (params.ownerId) {
    conditions.push({ ownerId: params.ownerId });
  }

  if (params.contactId) {
    conditions.push({ contactId: params.contactId });
  }

  const contactEmail = params.contactEmail?.trim().toLowerCase();
  if (contactEmail) {
    conditions.push({
      contact: { email: { equals: contactEmail, mode: "insensitive" } },
    });
  }

  const contactPhoneRaw = params.contactPhone?.trim();
  if (contactPhoneRaw) {
    const digits = contactPhoneRaw.replace(/\D/g, "");
    const phoneOr: Prisma.ContactWhereInput[] = [{ phone: { equals: contactPhoneRaw } }];
    if (digits && digits.length >= 8) {
      phoneOr.push({ phone: { endsWith: digits } });
    }
    conditions.push({
      contact: phoneOr.length === 1 ? phoneOr[0] : { OR: phoneOr },
    });
  }

  if (params.advancedFilters && Object.keys(params.advancedFilters).length > 0) {
    const advConditions = await buildDealWhereFromFilters(params.advancedFilters);
    for (const c of advConditions) conditions.push(c);
  }

  if (params.updatedSince) {
    conditions.push({ updatedAt: { gte: params.updatedSince } });
  }

  // Busca livre: mesma engine do Kanban (título, contato, número do negócio e
  // qualquer campo personalizado — inclusive CPF/RGM com máscara). Os ids saem
  // de UMA consulta, estreitada pelo que as demais condições já dizem (status,
  // funil, dono) e ordenada como a lista (mais recentes primeiro). O teto
  // acompanha a página pedida; `searchCapped` avisa quando houve corte.
  let searchCapped = false;
  const searchTerm = params.search?.trim();
  if (searchTerm) {
    const dealSearch = createDealSearch(searchTerm);
    if (dealSearch) {
      conditions.push(
        await dealSearch.prismaWhere({
          narrowSql: narrowSqlOfConditions(conditions),
          idsCap: Math.min(
            LIST_SEARCH_IDS_CAP_MAX,
            Math.max(LIST_SEARCH_IDS_CAP_MIN, skip + perPage + 1),
          ),
        }),
      );
      searchCapped = dealSearch.resolved()?.capped === true;
    }
  }

  const where: Prisma.DealWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};

  // Uma linha além da página diz se existe próxima (`hasMore`) sem contar.
  //
  // O `COUNT(*)` repete os JOINs do filtro (stages → pipelines) e custava
  // quase o mesmo que a página (produção, 05/10: 95 ms a página + 81 ms a
  // contagem, 8.490 pares). Quem não mostra "página X de Y" (buscas, diálogo
  // de duplicados, integrações que só avançam enquanto há itens) pede
  // `withTotal=0` e paga só a página. O padrão continua contando: a aba
  // Lista do frontend atual calcula a última página por `total`.
  const wantsTotal = params.withTotal !== false;
  const sortByLastInteraction = params.sort === "lastInteraction";
  const interactionDir = params.direction === "asc" ? "asc" : "desc";
  const loadPage = async (include: typeof listInclude) => {
    const counted = wantsTotal ? prisma.deal.count({ where }) : Promise.resolve(null);
    if (!sortByLastInteraction) {
      return Promise.all([
        prisma.deal.findMany({
          where,
          skip,
          take: perPage + 1,
          orderBy: [{ updatedAt: "desc" }],
          include,
        }),
        counted,
      ]);
    }
    const [ids, total] = await Promise.all([
      pageIdsByLastInteraction(where, interactionDir, skip, perPage + 1),
      counted,
    ]);
    if (ids.length === 0) return [[], total] as const;
    const rows = await prisma.deal.findMany({
      where: { id: { in: ids } },
      include,
    });
    const order = new Map(ids.map((id, index) => [id, index]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return [rows, total] as const;
  };
  let loaded: Awaited<ReturnType<typeof loadPage>>;
  try {
    loaded = await loadPage(listInclude);
  } catch (error) {
    if (!missingLastMessageColumn(error)) throw error;
    log.warn(
      { err: error },
      "[deals] contacts.lastMessageAt ausente — lista segue sem a coluna. Aplique a migration 20261006120000_contacts_last_message.",
    );
    loaded = await loadPage(
      // Mesmo formato do include normal, só sem `contact.lastMessageAt`: o tipo da
      // resposta continua o de `listInclude` para os chamadores não perderem as relações.
      listIncludeWithoutLastMessage as unknown as typeof listInclude,
    );
  }
  const [rows, counted] = loaded;
  const hasMore = rows.length > perPage;
  const items = hasMore ? rows.slice(0, perPage) : rows;
  // Sem contagem: na última página o total é exato sem consultar
  // (`skip + itens`). Página vazia depois da primeira não diz o total.
  const total: number | null =
    counted ?? (!hasMore && (items.length > 0 || page === 1) ? skip + items.length : null);

  await enrichContactsWithUserAvatarFallback(
    items.map((d) => d.contact).filter((c): c is NonNullable<typeof c> => c !== null),
  );

  const itemsWithInteraction = await attachLastInteractionAt([...items]);

  return {
    items: itemsWithInteraction,
    total,
    page,
    perPage,
    hasMore,
    ...(searchCapped ? { searchCapped: true } : {}),
  };
}

/** Ids da busca na lista: piso e teto (a página pedida empurra o teto até o máximo). */
const LIST_SEARCH_IDS_CAP_MIN = 2_000;
const LIST_SEARCH_IDS_CAP_MAX = 5_000;

/**
 * Última interação de contatos SEM `contacts.lastMessageAt` (ainda não
 * preenchido pelo backfill, ou contato que nunca teve mensagem de chat):
 * `MAX(COALESCE(conversations.lastMessageAt, conversations.updatedAt))`.
 * Contato sem conversa não volta. Só os ids pedidos; quem chama passa
 * apenas os contatos com a coluna NULL.
 */
async function loadConversationLastAtFallback(
  orgId: string,
  contactIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (contactIds.length === 0) return out;
  const grouped = await prisma.$queryRaw<
    { contactId: string; last_at: Date | null }[]
  >`
    SELECT "contactId", MAX(COALESCE("lastMessageAt", "updatedAt")) AS last_at
    FROM conversations
    WHERE "organizationId" = ${orgId}
      AND "contactId" = ANY(${[...contactIds]})
    GROUP BY "contactId"
  `;
  for (const row of grouped) {
    if (!row.contactId || !row.last_at) continue;
    const at = new Date(row.last_at).getTime();
    if (Number.isFinite(at)) out.set(row.contactId, at);
  }
  return out;
}

/**
 * Última interação do negócio na lista: a última MENSAGEM de chat do
 * contato (`contacts.lastMessageAt`, o mesmo sinal do sort
 * `lastInteraction` do board). Sem mensagem, fica o `updatedAt` do deal.
 * Alterar o card não substitui a mensagem — senão "mais antiga" só
 * reordena a hora do último toque e a página continua parecendo a lista
 * sem ordenação.
 *
 * O contato já vem no `include` da lista, então a página não consulta
 * `conversations`. Antes: um `GROUP BY "contactId"` com
 * `MAX(conversations.updatedAt)` por página — que ainda contava como
 * "interação" qualquer gravação na conversa (atribuição, distribuição).
 * Contato com a coluna NULL cai em `loadConversationLastAtFallback`.
 */
async function attachLastInteractionAt<
  T extends {
    contactId: string | null;
    updatedAt: Date;
    contact?: { lastMessageAt?: Date | null } | null;
  },
>(items: T[]): Promise<Array<T & { lastInteractionAt: string }>> {
  const lastByContact = new Map<string, number>();
  const missing = new Set<string>();
  for (const deal of items) {
    if (!deal.contactId) continue;
    const at = deal.contact?.lastMessageAt;
    if (at) lastByContact.set(deal.contactId, new Date(at).getTime());
    else missing.add(deal.contactId);
  }
  if (missing.size > 0) {
    try {
      const fallback = await loadConversationLastAtFallback(getOrgIdOrThrow(), [...missing]);
      for (const [contactId, at] of fallback) lastByContact.set(contactId, at);
    } catch (error) {
      if (!missingLastMessageColumn(error)) throw error;
      log.warn(
        { err: error },
        "[deals] conversations.lastMessageAt ausente — última interação fica no updatedAt do negócio.",
      );
    }
  }

  return items.map((deal) => {
    const dealAt = deal.updatedAt.getTime();
    const convAt = deal.contactId ? lastByContact.get(deal.contactId) : undefined;
    const last = convAt != null ? convAt : dealAt;
    return { ...deal, lastInteractionAt: new Date(last).toISOString() };
  });
}

type NestedTag = { tag: { id: string; name: string; color: string | null } };

/** Tags no shape `{ id, name, color }` — mesmo do GET /deals/:id. */
export function flattenDealListItem<
  T extends {
    tags?: NestedTag[] | null;
    contact?: { tags?: NestedTag[] | null } | null;
  },
>(deal: T) {
  const flatten = (arr?: NestedTag[] | null) => (arr ?? []).map((t) => t.tag);
  return {
    ...deal,
    tags: flatten(deal.tags),
    contact: deal.contact
      ? { ...deal.contact, tags: flatten(deal.contact.tags) }
      : deal.contact,
  };
}

const detailInclude = {
  contact: {
    select: {
      id: true, number: true, name: true, email: true, phone: true, avatarUrl: true,
      whatsappUsername: true,
      // `source` (nativo de Contact) usado pelo deal detail (frontend
      // mostra/edita inline no cabecalho fixo da sidebar via
      // InlineNativeEditor). Antes o painel tentava ler `Deal.source` que
      // nao existe no schema; passou a usar contact.source.
      source: true,
      // `updatedAt` sozinho empata: `propagateOwnerToContactAndChat` faz um
      // `updateMany` que carimba o MESMO milissegundo em todos os tickets do
      // contato. Sem desempate o Postgres devolve ordem arbitraria e o painel
      // do deal podia cair num ticket encerrado. `createdAt`/`id` tornam a
      // ordem deterministica; a preferencia pelo ticket ATIVO e aplicada
      // depois, em `sortConversationsActiveFirst` (status nao e ordenavel
      // aqui: o enum e OPEN, RESOLVED, PENDING, SNOOZED — RESOLVED nao fica
      // por ultimo — e `closedAt` e nulo em ~5.6k linhas RESOLVED legadas).
      conversations: {
        take: 20,
        orderBy: [
          { updatedAt: "desc" as const },
          { createdAt: "desc" as const },
          { id: "desc" as const },
        ],
        select: {
          id: true, number: true, externalId: true, channel: true,
          status: true, inboxName: true, closedAt: true,
          createdAt: true, updatedAt: true,
          // Última mensagem de chat: ordena o painel sem varrer `messages`
          // (`preferConversationWithLastMessage`).
          lastMessageAt: true,
          departmentId: true,
          department: {
            select: { id: true, name: true, requireTabulationOnClose: true },
          },
          assignedTo: { select: { id: true, name: true } },
        },
      },
      tags: {
        select: {
          tag: { select: { id: true, name: true, color: true } },
        },
      },
    },
  },
  tags: {
    select: {
      tag: { select: { id: true, name: true, color: true } },
    },
  },
  stage: {
    select: {
      id: true, name: true, slug: true, number: true, position: true, color: true,
      pipeline: {
        select: {
          id: true, name: true, slug: true, number: true,
          stages: {
            orderBy: { position: "asc" as const },
            select: { id: true, name: true, slug: true, number: true, color: true, position: true },
          },
        },
      },
    },
  },
  owner: { select: { id: true, name: true, email: true, avatarUrl: true, role: true, type: true } },
  activities: {
    take: 30,
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
    include: {
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  },
  notes: {
    take: 30,
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  },
} satisfies Prisma.DealInclude;

export type DealDetail = Prisma.DealGetPayload<{
  include: typeof detailInclude;
}>;

/**
 * Coloca os tickets ATIVOS (nao-RESOLVED) na frente, preservando a ordem
 * relativa vinda do banco dentro de cada grupo (`Array.prototype.sort` e
 * estavel). O consumidor principal e o painel do deal, que le
 * `conversations[0]` como "a conversa do negocio": sem isso ele podia abrir
 * um ticket encerrado enquanto o cliente respondia em outro, aberto.
 *
 * Seguro por construcao: `ensureWhatsAppConversationForContact` so reusa
 * conversa nao-RESOLVED, entao existe no maximo um ticket ativo por
 * (org, contato, canal) — confirmado no banco (0 grupos com mais de um).
 */
function sortConversationsActiveFirst<T extends { status: ConversationStatus }>(
  conversations: T[],
): T[] {
  return [...conversations].sort(
    (a, b) =>
      Number(a.status === "RESOLVED") - Number(b.status === "RESOLVED"),
  );
}

export async function getDealById(
  idOrNumber: string,
  opts?: {
    /**
     * Detalhe do painel (Kanban/Flow): sem ticket ativo, põe na frente o
     * ticket com a última mensagem de chat do contato (uma consulta a mais,
     * só nesse caso). As demais rotas não pedem.
     */
    conversationWithLastMessageFirst?: boolean;
  },
): Promise<DealDetail | null> {
  const isNumeric = /^\d+$/.test(idOrNumber);
  const orgId = getOrgIdOrThrow();
  const deal = (await prisma.deal.findUnique({
    where: isNumeric
      ? { organizationId_number: { organizationId: orgId, number: parseInt(idOrNumber, 10) } }
      : { id: idOrNumber },
    include: detailInclude,
  })) as DealDetail | null;
  if (deal?.contact) {
    deal.contact.conversations = sortConversationsActiveFirst(
      deal.contact.conversations,
    );
    const [conversations] = await Promise.all([
      opts?.conversationWithLastMessageFirst
        ? preferConversationWithLastMessage(deal.contact.conversations)
        : deal.contact.conversations,
      enrichContactsWithUserAvatarFallback([deal.contact]),
    ]);
    deal.contact.conversations = conversations;
  }
  return deal;
}

export type CreateDealInput = {
  /** Só importação: manter id do export. */
  id?: string;
  /** ID externo do lead (ex.: Kommo). */
  externalId?: string | null;
  /** Opcional: sem título vira "Negócio - #<number>" (ver createDeal). */
  title?: string | null;
  value?: number | string;
  status?: DealStatus;
  expectedClose?: Date | string | null;
  lostReason?: string | null;
  position?: number;
  contactId?: string | null;
  stageId: string;
  ownerId?: string | null;
  /** Papel do deal (PRD catálogo): default COMMERCIAL no schema. */
  dealRole?: DealRole;
  /** Só `duplicateDeal`. Criação normal deixa o default false. */
  intentionalDuplicate?: boolean;
  duplicatedFromDealId?: string | null;
};

/**
 * Próximo `Deal.number` da org corrente. Delega no contador atômico —
 * `aggregate(_max)` pela extension vira `MAX` com OFFSET e lia dezenas
 * de milhares de linhas (~344ms) além de colidir sob concorrência.
 */
export async function nextDealNumber(): Promise<number> {
  return allocateOrgNumber("Deal", getOrgIdOrThrow());
}

const REUSED_OPEN_DEAL = Symbol.for("crm.reusedOpenDeal");

/** A criação devolveu o negócio aberto que o contato já tinha neste funil. */
export function wasReusedOpenDeal(deal: object): boolean {
  return Boolean((deal as Record<symbol, unknown>)[REUSED_OPEN_DEAL]);
}

function markReusedOpenDeal<T extends object>(deal: T): T {
  Object.defineProperty(deal, REUSED_OPEN_DEAL, { value: true });
  return deal;
}

/**
 * Negócio OPEN comercial que permanece quando o funil não aceita duplicata:
 * o mais à frente na etapa; empate, o atualizado por último.
 */
export async function findCanonicalOpenDealInPipeline(
  contactId: string,
  pipelineId: string,
  db: Pick<typeof prisma, "deal"> = prisma,
) {
  return db.deal.findFirst({
    where: {
      contactId,
      status: "OPEN",
      dealRole: "COMMERCIAL",
      intentionalDuplicate: false,
      stage: { pipelineId },
    },
    orderBy: [
      { stage: { position: "desc" } },
      { updatedAt: "desc" },
      { createdAt: "asc" },
    ],
    include: listInclude,
  });
}

/** OPEN comercial com contato: entra no shared do funil, mesmo com duplicata permitida. */
async function openCommercialCreateScope(data: CreateDealInput): Promise<{
  organizationId: string;
  pipelineId: string;
  contactId: string;
} | null> {
  if (!data.contactId) return null;
  if (data.status && data.status !== "OPEN") return null;
  if (data.dealRole && data.dealRole !== "COMMERCIAL") return null;

  const stage = await prisma.stage.findUnique({
    where: { id: data.stageId },
    select: { pipelineId: true },
  });
  if (!stage) return null;
  return {
    organizationId: getOrgIdOrThrow(),
    pipelineId: stage.pipelineId,
    contactId: data.contactId,
  };
}

async function insertNewDeal(
  db: Pick<typeof prisma, "contact" | "deal">,
  data: CreateDealInput,
) {
  // Título opcional. Prioridade:
  //  1. título informado
  //  2. "Negócio {Nome do Contato}" quando há contactId
  //  3. "Negócio - #<number>" (fallback numérico, resolvido no loop)
  let rawTitle = data.title?.trim() ?? "";
  if (!rawTitle && data.contactId) {
    const contact = await db.contact.findFirst({
      where: { id: data.contactId },
      select: { name: true },
    });
    rawTitle = defaultDealTitleForContact(contact?.name) ?? "";
  }

  // Posição: o MAX(position) por estágio só roda quando o caller não informou
  // uma posição. O import em massa (`deal-import-core`) passa `position`
  // explícita de um contador por estágio em memória — sem isso eram 2.852
  // aggregates num import de 5 mil linhas (stress sa221601).
  let position = data.position;
  if (position === undefined) {
    const maxPos = await db.deal.aggregate({
      where: { stageId: data.stageId },
      _max: { position: true },
    });
    position = (maxPos._max.position ?? -1) + 1;
  }

  // `number` vem do contador atômico por org (1 statement, ~0,3ms) —
  // substitui o `MAX(number)+1` com retry que lia dezenas de milhares de
  // linhas por create (a extension de scope traduz aggregate para uma
  // subquery com OFFSET, matando o index-only scan) e gerava storm de
  // P2002 sob concorrência. A extension mantém retry de segurança para
  // P2002 residual de `number` (ver `allocateOrgNumber` em lib/prisma.ts).
  const number = await allocateOrgNumber("Deal", getOrgIdOrThrow());
  const title = rawTitle || `Negócio - #${number}`;
  return db.deal.create({
    data: withOrgFromCtx({
      ...(data.id ? { id: data.id } : {}),
      number,
      title,
      externalId: data.externalId === undefined ? undefined : data.externalId,
      value: data.value !== undefined ? data.value : undefined,
      status: data.status,
      expectedClose: data.expectedClose === undefined ? undefined : data.expectedClose,
      lostReason: data.lostReason === undefined ? undefined : data.lostReason,
      position,
      contactId: data.contactId === undefined ? undefined : data.contactId,
      stageId: data.stageId,
      ownerId: data.ownerId === undefined ? undefined : data.ownerId,
      dealRole: data.dealRole === undefined ? undefined : data.dealRole,
      ...(data.intentionalDuplicate ? { intentionalDuplicate: true } : {}),
      ...(data.duplicatedFromDealId
        ? { duplicatedFromDealId: data.duplicatedFromDealId }
        : {}),
    }),
    // Sem `contacts.lastMessageAt`: o include completo aborta o INSERT
    // inteiro enquanto a migration 20261006120000 não está no banco.
    include: listIncludeWithoutLastMessage,
  });
}

export async function createDeal(data: CreateDealInput) {
  const scope = await openCommercialCreateScope(data);
  if (scope) {
    const deal = await prisma.$transaction(
      async (tx) => {
        await lockOpenCommercialPipelineShared(
          tx,
          scope.organizationId,
          scope.pipelineId,
        );
        const forbids = await pipelineForbidsDuplicateDeals(scope.pipelineId, tx);
        if (forbids) {
          await lockOpenCommercialContactExclusive(
            tx,
            scope.organizationId,
            scope.pipelineId,
            scope.contactId,
          );
          const existing = await findCanonicalOpenDealInPipeline(
            scope.contactId,
            scope.pipelineId,
            tx,
          );
          if (existing) return markReusedOpenDeal(existing);
        }
        return insertNewDeal(tx, data);
      },
      { timeout: OPEN_COMMERCIAL_CREATE_TX_MS },
    );
    if (!wasReusedOpenDeal(deal)) {
      await invalidateBoardsForPipelines([deal.stage?.pipelineId]);
    }
    return deal;
  }

  const created = await insertNewDeal(prisma, data);
  await invalidateBoardsForPipelines([created.stage?.pipelineId]);
  return created;
}

/** Etapa terminal não serve: a duplicata nasce OPEN. */
export function duplicateTargetError(
  stage: { pipelineId: string; isWon: boolean; isLost: boolean } | null,
  pipelineId: string,
): "STAGE_NOT_FOUND" | "STAGE_PIPELINE_MISMATCH" | "TERMINAL_STAGE" | null {
  if (!stage) return "STAGE_NOT_FOUND";
  if (stage.pipelineId !== pipelineId) return "STAGE_PIPELINE_MISMATCH";
  if (stage.isWon || stage.isLost) return "TERMINAL_STAGE";
  return null;
}

/**
 * Cópia intencional: mesmo contato, título e responsável; estrutura
 * comercial vazia. Não passa por `createDeal` (esse reaproveita o aberto
 * quando o funil não aceita duplicata).
 */
export async function duplicateDeal(
  sourceId: string,
  input: { pipelineId: string; stageId: string },
) {
  const source = await prisma.deal.findUnique({
    where: { id: sourceId },
    select: {
      id: true,
      title: true,
      contactId: true,
      ownerId: true,
      dealRole: true,
    },
  });
  if (!source) throw new Error("NOT_FOUND");

  const [stage, pipeline] = await Promise.all([
    prisma.stage.findUnique({
      where: { id: input.stageId },
      select: { id: true, pipelineId: true, isWon: true, isLost: true },
    }),
    prisma.pipeline.findUnique({
      where: { id: input.pipelineId },
      select: { id: true, archivedAt: true },
    }),
  ]);
  if (!pipeline || pipeline.archivedAt) throw new Error("PIPELINE_NOT_FOUND");
  const stageError = duplicateTargetError(stage, input.pipelineId);
  if (stageError) throw new Error(stageError);

  const created = await prisma.$transaction((tx) =>
    insertNewDeal(tx, {
      title: source.title,
      contactId: source.contactId,
      ownerId: source.ownerId,
      stageId: input.stageId,
      status: "OPEN",
      value: 0,
      dealRole: source.dealRole,
      intentionalDuplicate: true,
      duplicatedFromDealId: source.id,
    }),
  );
  await invalidateBoardsForPipelines([created.stage?.pipelineId]);
  return created;
}

/**
 * Negócio aberto que o contato já tem no pipeline — o mais antigo, que é o
 * que acumulou histórico.
 *
 * Serve às integrações que podem reprocessar o mesmo lead (ver
 * `options.reuseOpenDeal` em `POST /api/leads`). O escopo é o pipeline e não
 * a etapa: um lead que avançou de etapa continua sendo o mesmo negócio.
 * Retorna no mesmo formato de `createDeal` para que quem chama devolva uma
 * resposta idêntica nos dois caminhos.
 */
export async function findOpenDealForContactInPipeline(
  contactId: string,
  pipelineId: string,
) {
  return prisma.deal.findFirst({
    where: { contactId, status: "OPEN", stage: { pipelineId } },
    orderBy: { createdAt: "asc" },
    include: listInclude,
  });
}

/**
 * Invalida o cache-aside do board dos pipelines afetados por uma escrita
 * manual (responsável, título, valor, criação/exclusão…).
 *
 * Sem isso o operador edita, o react-query refaz o GET do board e recebe
 * a variante ainda em cache — o card só reflete a mudança depois do
 * `BOARD_CACHE_TTL_SEC`.
 *
 * Awaited de propósito: o refetch do cliente sai logo após a resposta e
 * corria com o purge, reintroduzindo o card antigo por cima do update
 * otimista.
 */
export async function invalidateBoardsForPipelines(
  pipelineIds: (string | null | undefined)[],
): Promise<void> {
  try {
    const orgId = getOrgIdOrThrow();
    await Promise.all(
      Array.from(new Set(pipelineIds.filter(Boolean))).map((pipelineId) =>
        invalidateBoardData(orgId, pipelineId as string),
      ),
    );
  } catch {
    /* fora de contexto de org (jobs) — TTL curto cobre a atualização */
  }
}

async function pipelineIdOfDeal(dealId: string): Promise<string | null> {
  const row = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { stage: { select: { pipelineId: true } } },
  });
  return row?.stage?.pipelineId ?? null;
}

export type UpdateDealInput = {
  title?: string;
  externalId?: string | null;
  value?: number | string | null;
  status?: DealStatus;
  expectedClose?: Date | string | null;
  lostReason?: string | null;
  position?: number;
  contactId?: string | null;
  stageId?: string;
  ownerId?: string | null;
  orgUnitId?: string | null;
  /**
   * Quando o owner muda: também atualiza conversas abertas do contato.
   * `false` = só negócio (e contato). Default `true` (herança).
   */
  propagateToChat?: boolean;
};

export async function updateDeal(id: string, data: UpdateDealInput) {
  // Importante: usar UncheckedUpdateInput evita conflito com a extension
  // multi-tenant que injeta `organizationId` em `data` no update.
  // No checked input (`DealUpdateInput`), `organizationId` não é aceito.
  const payload: Prisma.DealUncheckedUpdateInput = {};

  if (data.title !== undefined) {
    const title = data.title.trim();
    if (!title) throw new Error("INVALID_TITLE");
    payload.title = title;
  }
  if (data.value !== undefined) {
    payload.value = data.value === null ? 0 : data.value;
  }
  if (data.status !== undefined) payload.status = data.status;
  if (data.expectedClose !== undefined) payload.expectedClose = data.expectedClose;
  if (data.lostReason !== undefined) payload.lostReason = data.lostReason;
  if (data.position !== undefined) payload.position = data.position;
  if (data.contactId !== undefined) payload.contactId = data.contactId;
  if (data.stageId !== undefined) payload.stageId = data.stageId;
  if (data.ownerId !== undefined) payload.ownerId = data.ownerId;
  if (data.orgUnitId !== undefined) payload.orgUnitId = data.orgUnitId;
  if (data.externalId !== undefined) {
    payload.externalId = data.externalId;
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("EMPTY_UPDATE");
  }

  // Troca de estágio pode ser cross-pipeline: guarda o funil de origem
  // pra invalidar os dois boards depois do commit.
  const previousPipelineId =
    data.stageId === undefined ? null : await pipelineIdOfDeal(id);

  // REGRA DE HERANÇA DE RESPONSÁVEL (ver `assignDealOwner` abaixo).
  let chatAssigneeChanges: ConversationAssigneeChange[] = [];
  let siblingPipelineIds: Array<string | null> = [];
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.deal.update({
      where: { id },
      data: payload,
      include: listInclude,
    });

    if (data.ownerId !== undefined) {
      const contactId =
        data.contactId !== undefined ? data.contactId : row.contactId;
      if (contactId) {
        const siblings = await tx.deal.findMany({
          where: { contactId, status: "OPEN", id: { not: row.id } },
          select: { id: true, stage: { select: { pipelineId: true } } },
        });
        if (siblings.length > 0) {
          await tx.deal.updateMany({
            where: { id: { in: siblings.map((s) => s.id) } },
            data: { ownerId: data.ownerId },
          });
          siblingPipelineIds = siblings.map((s) => s.stage?.pipelineId ?? null);
        }
      }
      chatAssigneeChanges = await propagateOwnerToContactAndChat(
        tx,
        contactId,
        data.ownerId,
        { conversations: data.propagateToChat !== false },
      );
    }

    return row;
  });
  if (chatAssigneeChanges.length > 0) {
    await logConversationAssigneeChanges(chatAssigneeChanges);
  }

  await invalidateBoardsForPipelines([
    updated.stage?.pipelineId,
    previousPipelineId,
    ...siblingPipelineIds,
  ]);

  return updated;
}

export type ConversationAssigneeChange = {
  conversationId: string;
  contactId: string | null;
  entityLabel: string | null;
  fromUserId: string | null;
  fromName: string | null;
  toUserId: string | null;
  toName: string | null;
};

export async function logConversationAssigneeChanges(
  changes: ConversationAssigneeChange[],
) {
  const organizationId = getOrgIdOrNull();
  for (const c of changes) {
    await logEvent({
      type: "ASSIGNEE_CHANGED",
      entityType: "CONVERSATION",
      entityId: c.conversationId,
      entityLabel: c.entityLabel,
      conversationId: c.conversationId,
      contactId: c.contactId,
      field: "assignedTo",
      oldValue: c.fromName,
      newValue: c.toName,
      meta: {
        fromUserId: c.fromUserId,
        toUserId: c.toUserId,
      },
    });
    try {
      publishConversationTimelineUpdated({
        organizationId,
        conversationId: c.conversationId,
        type: "ASSIGNEE_CHANGED",
      });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Propaga o `ownerId` do deal para o contato e as conversas desse
 * contato — regra de herança do "responsável único": quando um deal
 * é distribuído/transferido, o contato vinculado e todas as
 * conversas desse contato herdam o mesmo assignee. Evita ter
 * Atendimento/Contato/Chat em pessoas diferentes.
 *
 * Exposto como helper para que `updateDeal`, a rota bulk e o
 * executor de automações apliquem a mesma cascata.
 *
 * - `ownerId === null` → desatribui contato e conversas.
 * - `contactId === null` → no-op (não há a quem propagar).
 * - `opts.conversations === false` → só contato, não mexe no chat.
 * - Deve rodar dentro de uma transaction (`tx`) — a função não
 *   abre uma própria para poder compor com contextos maiores.
 * - Devolve as conversas que mudaram (para o caller logar no chat).
 */
export async function propagateOwnerToContactAndChat(
  tx: ScopedTx,
  contactId: string | null | undefined,
  ownerId: string | null,
  opts?: { conversations?: boolean; via?: string | null },
): Promise<ConversationAssigneeChange[]> {
  if (!contactId) return [];
  await tx.contact.update({
    where: { id: contactId },
    data: { assignedToId: ownerId },
  });
  if (opts?.conversations === false) return [];
  // Só reseta aiGreetedAt quando o assignedToId MUDA — evita flush
  // acidental quando a automação roda sem alteração real.
  //
  // IMPORTANTE (bug de NULL/SQL): tanto `NOT: { assignedToId: ownerId }`
  // quanto `assignedToId: { not: ownerId }` EXCLUEM linhas com
  // `assignedToId = NULL` (semântica de três valores do SQL: `NULL <> 'x'`
  // não é TRUE). Resultado do bug: conversa SEM responsável nunca recebia o
  // assignee da distribuição/automação → inbox seguia "Sem responsável".
  // Por isso incluímos explicitamente as conversas com `assignedToId = NULL`.
  const changedWhere: Prisma.ConversationWhereInput =
    ownerId === null
      ? { contactId, assignedToId: { not: null } }
      : {
          contactId,
          OR: [{ assignedToId: null }, { assignedToId: { not: ownerId } }],
        };

  const toChange = await tx.conversation.findMany({
    where: changedWhere,
    select: {
      id: true,
      contactId: true,
      externalId: true,
      assignedToId: true,
      assignedTo: { select: { id: true, name: true } },
    },
  });
  if (toChange.length === 0) return [];

  // Só reseta aiGreetedAt quando o novo responsável é IA — atribuição a
  // humano (ou remoção) não deve apagar o marcador de saudação.
  let newOwnerIsAi = false;
  let toName: string | null = null;
  if (ownerId) {
    const ownerRow = await tx.user.findUnique({
      where: { id: ownerId },
      select: { type: true, name: true },
    });
    newOwnerIsAi = ownerRow?.type === "AI";
    toName = ownerRow?.name ?? null;
  }

  // ATENCAO (`updatedAt` != atividade de conversa): este `updateMany` toca
  // todos os tickets do contato de uma vez, entao o `@updatedAt` do Prisma
  // grava o MESMO milissegundo em todos eles — inclusive nos ja encerrados,
  // que nao tiveram mensagem nenhuma. Quem ordenar conversa "atual" so por
  // `updatedAt desc` empata aqui e pode escolher um ticket morto.
  //
  // A correcao NAO e preservar `updatedAt` com SQL cru (brigar com o
  // `@updatedAt` deixa a coluna mentindo sobre a ultima escrita). E os
  // candidatos "atividade real" nao servem: `lastMessageAt` nao existe no
  // schema e `lastInboundAt` e nulo em ~52k conversas que TEM mensagem
  // (tickets so de outbound: campanha/HSM). Entao o criterio segue sendo
  // `updatedAt`, e a defesa mora no lado da leitura: desempate
  // deterministico + preferencia por ticket ativo (ver `detailInclude` /
  // `sortConversationsActiveFirst`).
  await tx.conversation.updateMany({
    where: { id: { in: toChange.map((c) => c.id) } },
    data: {
      assignedToId: ownerId,
      assignedVia: opts?.via ?? null,
      // Atribuição concreta consome a rota pendente; remoção de dono a
      // preserva (a conversa pode estar sendo preparada para outro motor).
      ...(ownerId !== null ? { routeMode: null } : {}),
      ...(newOwnerIsAi ? { aiGreetedAt: null } : {}),
    },
  });

  return toChange.map((c) => ({
    conversationId: c.id,
    contactId: c.contactId,
    entityLabel: c.externalId ?? null,
    fromUserId: c.assignedToId,
    fromName: c.assignedTo?.name ?? null,
    toUserId: ownerId,
    toName,
  }));
}

/**
 * Atribui o usuário a TODO o cluster do contato — deals OPEN (+ deal
 * explícito), contato e todas as conversas (inbox + pipeline).
 *
 * `via` marca a origem da atribuição ("smart" | "leads" | null).
 * Persistido em Deal.assignedVia e Conversation.assignedVia.
 */
export async function assignOwnerToContactClusterTx(
  tx: ScopedTx,
  args: {
    userId: string;
    via?: string | null;
    contactId?: string | null;
    dealId?: string | null;
    conversationId?: string | null;
  },
): Promise<{
  contactId: string | null;
  dealIds: string[];
  fromOwnerId: string | null;
  pipelineIds: (string | null)[];
  agentChangedDeals: {
    dealId: string;
    contactId: string | null;
    fromOwnerId: string | null;
  }[];
}> {
  // Replay com handoff real: handoff entre agentes IA é o que o replay
  // exercita e fica contido no sandbox. Dono humano, não — um consultor
  // acordaria com uma conversa de teste na fila dele.
  if (isReplaySandboxActive()) {
    const target = await tx.user.findUnique({
      where: { id: args.userId },
      select: { type: true },
    });
    if (target?.type !== "AI") {
      recordBlockedEffect("human_assignment", `userId=${args.userId}`);
      return {
        contactId: args.contactId ?? null,
        dealIds: [],
        fromOwnerId: null,
        pipelineIds: [],
        agentChangedDeals: [],
      };
    }
  }

  let contactId = args.contactId ?? null;
  if (!contactId && args.conversationId) {
    const conv = await tx.conversation.findUnique({
      where: { id: args.conversationId },
      select: { contactId: true },
    });
    contactId = conv?.contactId ?? null;
  }
  if (!contactId && args.dealId) {
    const deal = await tx.deal.findUnique({
      where: { id: args.dealId },
      select: { contactId: true },
    });
    contactId = deal?.contactId ?? null;
  }

  const deals =
    contactId || args.dealId
      ? await tx.deal.findMany({
          where: contactId
            ? {
                OR: [
                  { contactId, status: "OPEN" },
                  ...(args.dealId ? [{ id: args.dealId }] : []),
                ],
              }
            : { id: args.dealId! },
          select: {
            id: true,
            ownerId: true,
            contactId: true,
            stage: { select: { pipelineId: true } },
          },
        })
      : [];

  const agentChangedDeals: {
    dealId: string;
    contactId: string | null;
    fromOwnerId: string | null;
  }[] = [];
  const pipelineIds: (string | null)[] = [];
  let fromOwnerId: string | null = null;

  for (const d of deals) {
    if (fromOwnerId === null) fromOwnerId = d.ownerId;
    await tx.deal.update({
      where: { id: d.id },
      data: { ownerId: args.userId, assignedVia: args.via ?? null },
    });
    pipelineIds.push(d.stage?.pipelineId ?? null);
    if (d.ownerId !== args.userId) {
      agentChangedDeals.push({
        dealId: d.id,
        contactId: d.contactId,
        fromOwnerId: d.ownerId,
      });
    }
  }

  if (contactId) {
    await propagateOwnerToContactAndChat(tx, contactId, args.userId, { via: args.via ?? null });
  }

  return {
    contactId,
    dealIds: deals.map((d) => d.id),
    fromOwnerId,
    pipelineIds,
    agentChangedDeals,
  };
}

/**
 * Atribui um responsável a um deal e propaga a atribuição para o
 * contato e as conversas (regra de herança). Use esta função sempre
 * que for mudar `Deal.ownerId` de forma isolada (sem outros campos).
 */
export async function assignDealOwner(
  dealId: string,
  ownerId: string | null,
) {
  const deal = await prisma.$transaction(async (tx) => {
    const current = await tx.deal.findUnique({
      where: { id: dealId },
      select: { ownerId: true, contactId: true },
    });
    const row = await tx.deal.update({
      where: { id: dealId },
      data: { ownerId },
      select: {
        id: true,
        contactId: true,
        ownerId: true,
        stage: { select: { pipelineId: true } },
      },
    });
    const siblingPipelineIds: Array<string | null> = [];
    if (row.contactId) {
      const siblings = await tx.deal.findMany({
        where: { contactId: row.contactId, status: "OPEN", id: { not: row.id } },
        select: { id: true, stage: { select: { pipelineId: true } } },
      });
      if (siblings.length > 0) {
        await tx.deal.updateMany({
          where: { id: { in: siblings.map((s) => s.id) } },
          data: { ownerId },
        });
        siblingPipelineIds.push(
          ...siblings.map((s) => s.stage?.pipelineId ?? null),
        );
      }
    }
    const chatAssigneeChanges = await propagateOwnerToContactAndChat(
      tx,
      row.contactId,
      ownerId,
    );
    return {
      ...row,
      fromOwnerId: current?.ownerId ?? null,
      siblingPipelineIds,
      chatAssigneeChanges,
    };
  });

  // Sem ASSIGNEE_CHANGED na conversa, o próximo inbound trata o
  // consultor como herança e apaga o dono para o 1º atendimento da IA.
  if (deal.chatAssigneeChanges.length > 0) {
    await logConversationAssigneeChanges(deal.chatAssigneeChanges);
  }

  await invalidateBoardsForPipelines([
    deal.stage?.pipelineId,
    ...deal.siblingPipelineIds,
  ]);

  if (deal.fromOwnerId !== ownerId) {
    void import("@/services/automation-triggers")
      .then(({ fireTrigger }) =>
        fireTrigger("agent_changed", {
          dealId: deal.id,
          contactId: deal.contactId ?? undefined,
          data: { fromOwnerId: deal.fromOwnerId, toOwnerId: ownerId },
        }),
      )
      .catch(() => {});
  }

  const { chatAssigneeChanges: _logged, ...assigned } = deal;
  return assigned;
}

/**
 * Encerramento de conversa sem "manter atendente" (keepAgentOnEnd off):
 * o responsável removido do chat também sai dos deals ABERTOS do contato
 * e do próprio contato — senão o kanban segue mostrando a pessoa num
 * atendimento já encerrado, e o próximo inbound herda o nome antigo.
 *
 * Guardas (não comprometer outros vínculos):
 *   - Só limpa entidades cujo responsável É o `clearedUserId` removido —
 *     deal de outro dono (ex.: transferido manualmente antes) fica intacto.
 *   - Se outra conversa ABERTA do contato ainda está com esse responsável,
 *     não limpa nada (o vínculo segue vivo por ali).
 *
 * Logs: OWNER_CHANGED por deal (timeline do card) + CONTACT_OWNER_CHANGED
 * (feed do contato). Não dispara trigger `agent_changed` — encerramento
 * já tem seus próprios gatilhos; disparar automação extra aqui seria
 * efeito colateral fora do pedido.
 */
export async function clearContactOwnershipOnClose(args: {
  contactId: string;
  clearedUserId: string;
  actorUserId: string | null;
}): Promise<void> {
  const { contactId, clearedUserId, actorUserId } = args;

  const stillAssigned = await prisma.conversation.findFirst({
    where: {
      contactId,
      status: { not: "RESOLVED" },
      assignedToId: clearedUserId,
    },
    select: { id: true },
  });
  if (stillAssigned) return;

  const [contact, deals] = await Promise.all([
    prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        assignedToId: true,
        assignedTo: { select: { name: true } },
      },
    }),
    prisma.deal.findMany({
      where: { contactId, status: "OPEN", ownerId: clearedUserId },
      select: {
        id: true,
        owner: { select: { id: true, name: true } },
        stage: { select: { pipelineId: true } },
      },
    }),
  ]);

  const clearContact = contact?.assignedToId === clearedUserId;
  if (!clearContact && deals.length === 0) return;

  await prisma.$transaction(async (tx) => {
    if (clearContact) {
      await tx.contact.update({
        where: { id: contactId },
        data: { assignedToId: null },
      });
    }
    if (deals.length > 0) {
      await tx.deal.updateMany({
        where: { id: { in: deals.map((d) => d.id) } },
        data: { ownerId: null },
      });
    }
  });

  const fromName = contact?.assignedTo?.name ?? null;
  for (const deal of deals) {
    createDealEvent(deal.id, userIdForFk(actorUserId), "OWNER_CHANGED", {
      from: deal.owner ? { id: deal.owner.id, name: deal.owner.name } : null,
      to: null,
      source: "conversation_closed",
    }).catch(() => {});
  }

  if (clearContact) {
    await logEvent({
      type: "CONTACT_OWNER_CHANGED",
      entityType: "CONTACT",
      entityId: contactId,
      contactId,
      field: "assignedToId",
      oldValue: fromName,
      newValue: null,
      meta: { from: fromName, to: null, source: "conversation_closed" },
    }).catch(() => {});
  }

  if (deals.length > 0) {
    await invalidateBoardsForPipelines(
      deals.map((d) => d.stage?.pipelineId),
    );
  }
}

/**
 * Cura inconsistência Deal ↔ Contato ↔ Conversa: preenche só lados
 * vazios a partir de um responsável já existente (não sobrescreve donos
 * diferentes). Preferência: conversa → contato → deal aberto.
 *
 * Cobre o gap em que a distribuição/inbound atribui a conversa e o
 * early-return da automação deixa o deal com `ownerId = null` → pipeline
 * mostra "Sem responsável" mesmo com chat atribuído.
 */
export async function syncOwnershipForContact(
  contactId: string,
): Promise<string | null> {
  const [contact, openDeals, openConvs] = await Promise.all([
    prisma.contact.findUnique({
      where: { id: contactId },
      select: { assignedToId: true },
    }),
    prisma.deal.findMany({
      where: { contactId, status: "OPEN" },
      select: { id: true, ownerId: true },
    }),
    prisma.conversation.findMany({
      where: { contactId, status: { not: "RESOLVED" } },
      select: { id: true, assignedToId: true },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  const fromConv =
    openConvs.find((c) => c.assignedToId)?.assignedToId ?? null;
  const fromContact = contact?.assignedToId ?? null;
  const fromDeal = openDeals.find((d) => d.ownerId)?.ownerId ?? null;
  const ownerId = fromConv ?? fromContact ?? fromDeal;
  if (!ownerId) return null;

  const nullDealIds = openDeals.filter((d) => !d.ownerId).map((d) => d.id);
  const nullConvIds = openConvs.filter((c) => !c.assignedToId).map((c) => c.id);
  const contactNeeds = !fromContact;

  if (!contactNeeds && nullDealIds.length === 0 && nullConvIds.length === 0) {
    return ownerId;
  }

  await prisma.$transaction(async (tx) => {
    if (contactNeeds) {
      await tx.contact.update({
        where: { id: contactId },
        data: { assignedToId: ownerId },
      });
    }
    if (nullDealIds.length > 0) {
      await tx.deal.updateMany({
        where: { id: { in: nullDealIds } },
        data: { ownerId },
      });
    }
    if (nullConvIds.length > 0) {
      await tx.conversation.updateMany({
        where: { id: { in: nullConvIds } },
        data: { assignedToId: ownerId },
      });
    }
  });

  return ownerId;
}

export async function deleteDeal(id: string) {
  const pipelineId = await pipelineIdOfDeal(id);
  await prisma.deal.delete({ where: { id } });
  await invalidateBoardsForPipelines([pipelineId]);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Sincroniza `Deal.status` com o estágio de destino (modelo Kommo):
 *   - estágio `isWon`  → status WON  + closedAt
 *   - estágio `isLost` → status LOST + closedAt (+ lostReason se vier)
 *   - estágio comum    → status OPEN (reabre se estava fechado)
 * Retorna o patch a aplicar junto com a mudança de stage (vazio se o
 * status já está coerente).
 */
function buildStatusSyncPatch(
  currentStatus: DealStatus,
  targetStage: { isWon: boolean; isLost: boolean },
  lostReason?: string | null,
): Prisma.DealUncheckedUpdateInput {
  if (targetStage.isWon) {
    return currentStatus === "WON"
      ? {}
      : { status: "WON", closedAt: new Date(), lostReason: null };
  }
  if (targetStage.isLost) {
    const reason = lostReason?.trim() || null;
    if (currentStatus === "LOST") {
      // Já perdido: só atualiza o motivo se um novo foi informado.
      return reason ? { lostReason: reason } : {};
    }
    return { status: "LOST", closedAt: new Date(), lostReason: reason };
  }
  return currentStatus === "OPEN"
    ? {}
    : { status: "OPEN", closedAt: null, lostReason: null };
}

export type MoveDealOptions = {
  /** Motivo da perda — usado quando o destino é o estágio Perdido. */
  lostReason?: string | null;
};

const MOVE_DEAL_MAX_RETRIES = 3;

function isPrismaDeadlock(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? String((err as { code: unknown }).code) : "";
  if (code === "P2034") return true;
  const msg =
    "message" in err ? String((err as { message: unknown }).message) : "";
  return /deadlock detected/i.test(msg);
}

/**
 * Advisory locks por estágio em ordem lexicográfica estável.
 * Evita deadlock A↔B em `deals.position` sem travar milhares de rows
 * (FOR UPDATE em coluna grande estourava o timeout de 20s).
 */
async function lockStagesForMove(
  tx: ScopedTx,
  stageIds: string[],
): Promise<void> {
  const unique = [...new Set(stageIds.filter(Boolean))].sort();
  for (const stageId of unique) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${stageId}, 0))
    `;
  }
}

/**
 * Gap mínimo entre vizinhos para inserir um ponto médio. Float64 comporta
 * ~50 bisseções consecutivas entre inteiros adjacentes antes de esgotar;
 * abaixo do epsilon o estágio é renormalizado para 0..n-1.
 */
const POSITION_GAP_EPSILON = 1e-9;

/**
 * Vizinhos de posição em torno do índice de inserção (0-based, excluindo
 * opcionalmente o deal movido). Index-only scan ordenado — substitui o
 * "carrega o estágio inteiro" do reorder anterior.
 */
async function findPositionNeighbors(
  tx: ScopedTx,
  stageId: string,
  index: number,
  excludeDealId?: string,
): Promise<{ prev: number | null; next: number | null }> {
  const rows = await tx.deal.findMany({
    where: {
      stageId,
      ...(excludeDealId ? { id: { not: excludeDealId } } : {}),
    },
    orderBy: { position: "asc" },
    select: { position: true },
    skip: Math.max(0, index - 1),
    take: 2,
  });
  if (index === 0) {
    return { prev: null, next: rows[0]?.position ?? null };
  }
  return { prev: rows[0]?.position ?? null, next: rows[1]?.position ?? null };
}

/** Ponto médio entre vizinhos; `null` quando o gap esgotou (renormalizar). */
function midpointPosition(
  prev: number | null,
  next: number | null,
): number | null {
  if (prev === null) return next === null ? 0 : next - 1;
  if (next === null) return prev + 1;
  if (next - prev < POSITION_GAP_EPSILON) return null;
  return (prev + next) / 2;
}

/**
 * Renumera o estágio para 0..n-1 (um UPDATE com VALUES). Só roda quando o
 * gap fracionário esgota — raro (dezenas de moves consecutivos entre os
 * mesmos 2 cards).
 */
async function renormalizeStagePositions(
  tx: ScopedTx,
  stageId: string,
): Promise<void> {
  const deals = await tx.deal.findMany({
    where: { stageId },
    orderBy: { position: "asc" },
    select: { id: true },
  });
  if (deals.length === 0) return;
  const values = deals.map((d, i) => Prisma.sql`(${d.id}, ${i})`);
  await tx.$executeRaw`
    UPDATE deals AS d
    SET position = v.pos::float8
    FROM (VALUES ${Prisma.join(values)}) AS v(id, pos)
    WHERE d.id = v.id AND d.position IS DISTINCT FROM v.pos::float8
  `;
}

/**
 * Posição fracionária para inserir um deal no `index` do estágio.
 * Renormaliza o estágio se o gap entre vizinhos tiver esgotado.
 */
async function resolveInsertionPosition(
  tx: ScopedTx,
  stageId: string,
  index: number,
  excludeDealId?: string,
): Promise<number> {
  let neighbors = await findPositionNeighbors(tx, stageId, index, excludeDealId);
  let pos = midpointPosition(neighbors.prev, neighbors.next);
  if (pos === null) {
    await renormalizeStagePositions(tx, stageId);
    neighbors = await findPositionNeighbors(tx, stageId, index, excludeDealId);
    pos = midpointPosition(neighbors.prev, neighbors.next) ?? index;
  }
  return pos;
}

function customFieldValueFilled(value: string | null | undefined, type: string): boolean {
  if (value == null) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (type === "MULTI_SELECT") {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.length > 0;
    } catch {
      /* texto solto conta como preenchido */
    }
  }
  return true;
}

export class StageFieldsRequiredError extends Error {
  readonly stageName: string;
  readonly fields: { id: string; label: string }[];

  constructor(stageName: string, fields: { id: string; label: string }[]) {
    const names = fields.map((f) => f.label).join(", ");
    super(`Para entrar em "${stageName}", preencha: ${names}.`);
    this.name = "StageFieldsRequiredError";
    this.stageName = stageName;
    this.fields = fields;
  }
}

/**
 * Bloqueia a entrada na etapa quando ela exige campos do negócio vazios.
 * Reordenar dentro da mesma etapa não passa por aqui.
 */
export async function assertStageEntryFields(dealId: string, targetStageId: string) {
  const target = await prisma.stage.findUnique({
    where: { id: targetStageId },
    select: { id: true, name: true, requiredDealFieldIds: true },
  });
  const requiredIds = target?.requiredDealFieldIds ?? [];
  if (!target || requiredIds.length === 0) return;

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      stageId: true,
      customFields: {
        where: { customFieldId: { in: requiredIds } },
        select: { customFieldId: true, value: true },
      },
    },
  });
  if (!deal || deal.stageId === targetStageId) return;

  const definitions = await prisma.customField.findMany({
    where: { id: { in: requiredIds }, entity: "deal" },
    select: { id: true, label: true, name: true, type: true },
  });
  const valueByField = new Map(deal.customFields.map((row) => [row.customFieldId, row.value]));
  const missing = definitions
    .filter((field) => !customFieldValueFilled(valueByField.get(field.id), field.type))
    .map((field) => ({ id: field.id, label: field.label || field.name }));
  if (missing.length > 0) throw new StageFieldsRequiredError(target.name, missing);
}

type DealMoveSnapshot = {
  fromStageId: string;
  toStageId: string;
  fromPipelineId: string;
  toPipelineId: string;
  position: number;
};

function isoInstant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return new Date().toISOString();
}

function plainDealValue(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toNumber" in value) {
    const n = (value as { toNumber: () => number }).toNumber();
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function optionalIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

/**
 * Dono e unidade do negócio para o payload do `deal_moved` (a rota SSE
 * filtra o card por dono). Só devolve o que a linha realmente informa:
 * campo desconhecido não vira `null` (null = "sem dono").
 */
function dealMovedOwnership(
  deal: unknown,
): Pick<DealMovedPayload, "ownerId" | "orgUnitId"> {
  if (!deal || typeof deal !== "object") return {};
  const row = deal as Record<string, unknown>;
  const out: Pick<DealMovedPayload, "ownerId" | "orgUnitId"> = {};
  if (typeof row.ownerId === "string" || row.ownerId === null) {
    out.ownerId = row.ownerId;
  } else if (row.owner && typeof row.owner === "object") {
    const id = (row.owner as { id?: unknown }).id;
    if (typeof id === "string") out.ownerId = id;
  } else if (row.owner === null) {
    out.ownerId = null;
  }
  if (typeof row.orgUnitId === "string" || row.orgUnitId === null) {
    out.orgUnitId = row.orgUnitId;
  }
  return out;
}

/** Card mínimo para o cliente do funil destino, a partir do deal já lido. */
function toDealMovedCard(
  deal: unknown,
  position: number,
  updatedAt: string,
): DealMovedCard | undefined {
  if (!deal || typeof deal !== "object") return undefined;
  const row = deal as Record<string, unknown>;
  if (typeof row.id !== "string") return undefined;
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (!title) return undefined;

  const contactRaw = row.contact;
  const contact =
    contactRaw && typeof contactRaw === "object"
      ? (contactRaw as Record<string, unknown>)
      : null;
  const ownerRaw = row.owner;
  const owner =
    ownerRaw && typeof ownerRaw === "object"
      ? (ownerRaw as Record<string, unknown>)
      : null;

  const tags = Array.isArray(row.tags)
    ? row.tags.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const tag = "tag" in item ? (item as { tag?: unknown }).tag : item;
        if (!tag || typeof tag !== "object") return [];
        const t = tag as { id?: unknown; name?: unknown; color?: unknown };
        if (typeof t.id !== "string" || typeof t.name !== "string") return [];
        return [{ id: t.id, name: t.name, color: typeof t.color === "string" ? t.color : "" }];
      })
    : undefined;

  return {
    id: row.id,
    title,
    value: plainDealValue(row.value),
    status: typeof row.status === "string" ? row.status : undefined,
    lostReason:
      typeof row.lostReason === "string" || row.lostReason === null ? row.lostReason : undefined,
    position,
    expectedClose: optionalIso(row.expectedClose),
    createdAt: optionalIso(row.createdAt) ?? undefined,
    updatedAt,
    contact:
      contact && typeof contact.id === "string" && typeof contact.name === "string"
        ? {
            id: contact.id,
            name: contact.name,
            email: typeof contact.email === "string" || contact.email === null ? contact.email : null,
            phone: typeof contact.phone === "string" || contact.phone === null ? contact.phone : null,
            avatarUrl:
              typeof contact.avatarUrl === "string" || contact.avatarUrl === null
                ? contact.avatarUrl
                : null,
          }
        : null,
    owner:
      owner && typeof owner.id === "string" && typeof owner.name === "string"
        ? {
            id: owner.id,
            name: owner.name,
            avatarUrl:
              typeof owner.avatarUrl === "string" || owner.avatarUrl === null ? owner.avatarUrl : null,
            type: typeof owner.type === "string" || owner.type === null ? owner.type : null,
          }
        : null,
    ...(tags && tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Depois do commit: invalida o cache do board e só então publica.
 * Falha de Redis não desfaz o move nem falha o HTTP.
 */
function publishDealMovedAfterCacheBump(
  orgId: string,
  dealId: string,
  snapshot: DealMoveSnapshot,
  deal: unknown,
): void {
  const pipelines =
    snapshot.fromPipelineId === snapshot.toPipelineId
      ? [snapshot.toPipelineId]
      : [snapshot.toPipelineId, snapshot.fromPipelineId];
  const updatedAt = isoInstant(
    deal && typeof deal === "object" ? (deal as { updatedAt?: unknown }).updatedAt : undefined,
  );
  const payload: DealMovedPayload = {
    organizationId: orgId,
    dealId,
    fromPipelineId: snapshot.fromPipelineId,
    toPipelineId: snapshot.toPipelineId,
    fromStageId: snapshot.fromStageId,
    toStageId: snapshot.toStageId,
    position: snapshot.position,
    updatedAt,
    ...dealMovedOwnership(deal),
  };
  const card = toDealMovedCard(deal, snapshot.position, updatedAt);
  const event = card ? { ...payload, card } : payload;
  void (async () => {
    try {
      await Promise.all(pipelines.map((pipelineId) => invalidateBoardData(orgId, pipelineId)));
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), orgId, dealId },
        "[deals.moveDeal] invalidate do board falhou",
      );
    }
    publishDealMoved(event);
  })();
}

/** Select do `UPDATE` de etapa: a linha devolvida já é o estado gravado. */
export const activeDealMovedSelect = {
  id: true,
  title: true,
  value: true,
  status: true,
  lostReason: true,
  position: true,
  expectedClose: true,
  createdAt: true,
  updatedAt: true,
  stageId: true,
  ownerId: true,
  orgUnitId: true,
  contact: {
    select: { id: true, name: true, email: true, phone: true, avatarUrl: true },
  },
  owner: { select: { id: true, name: true, avatarUrl: true, type: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
  stage: { select: { pipelineId: true, isWon: true, isLost: true } },
} satisfies Prisma.DealSelect;

/** Linha já gravada, o bastante para o mesmo `deal_moved` do move manual. */
export type ActiveDealMovedRow = {
  id: string;
  title?: string | null;
  value?: unknown;
  status?: string | null;
  lostReason?: string | null;
  position?: unknown;
  expectedClose?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  stageId: string;
  ownerId?: string | null;
  orgUnitId?: string | null;
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
  tags?: Array<{ tag: { id: string; name: string; color: string | null } }>;
  stage?: { pipelineId?: string | null; isWon?: boolean | null; isLost?: boolean | null } | null;
};

/**
 * Teto de negócios por lote com um `deal_moved` por card. Acima disso só o
 * cache do board é invalidado (o quadro converge na próxima leitura): mil
 * eventos de uma vez custam mais ao SSE e ao cliente do que um refetch.
 */
export const DEAL_MOVED_BATCH_LIMIT = 50;

/** Negócio alterado em lote: de onde saiu (se mudou de etapa). */
export type DealBoardChange = {
  dealId: string;
  /** Etapa/funil de ANTES. Ausentes = o negócio não mudou de etapa (ex.: troca de responsável). */
  fromStageId?: string | null;
  fromPipelineId?: string | null;
};

/**
 * Depois que um ou mais negócios foram gravados fora do `moveDeal`
 * (troca de responsável pela transferência da conversa, automação que leva
 * a Ganho/Perdido, lote): invalida o cache do board dos funis afetados e,
 * quando o lote é pequeno (`DEAL_MOVED_BATCH_LIMIT`), publica um `deal_moved`
 * por negócio com o card já atualizado.
 *
 * - O cache é invalidado ANTES de publicar (o refetch que o evento provoca
 *   não pode ler o board antigo) e é aguardado: o HTTP só responde depois.
 * - `rows`: linhas que o UPDATE já devolveu (evita reler); o que faltar sai
 *   numa única leitura para o lote.
 * - `extraPipelineIds`: funis a purgar além dos das linhas (origem de lote,
 *   funis de negócios que ficaram fora do teto).
 * - Best-effort: falha de Redis/SSE/leitura nunca desfaz a gravação.
 */
export async function syncBoardsAfterDealChanges(args: {
  orgId?: string | null;
  changes: DealBoardChange[];
  rows?: ReadonlyMap<string, ActiveDealMovedRow>;
  extraPipelineIds?: Iterable<string | null | undefined>;
}): Promise<{ invalidatedPipelines: string[]; published: number }> {
  const none = { invalidatedPipelines: [] as string[], published: 0 };
  const orgId = args.orgId ?? getOrgIdOrNull();
  if (!orgId) return none;
  const changes = args.changes.filter((c) => c.dealId);
  const extra = Array.from(args.extraPipelineIds ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  if (changes.length === 0 && extra.length === 0) return none;

  const withinLimit = changes.length > 0 && changes.length <= DEAL_MOVED_BATCH_LIMIT;
  const rows = new Map<string, ActiveDealMovedRow>(args.rows ?? []);
  if (withinLimit) {
    const missing = changes.filter((c) => !rows.has(c.dealId)).map((c) => c.dealId);
    if (missing.length > 0) {
      try {
        const read = await prisma.deal.findMany({
          where: { id: { in: missing } },
          select: activeDealMovedSelect,
        });
        for (const row of read as ActiveDealMovedRow[]) rows.set(row.id, row);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), orgId },
          "[deals.syncBoardsAfterDealChanges] leitura dos negócios falhou — só invalida",
        );
      }
    }
  }

  const pipelines = new Set<string>(extra);
  for (const c of changes) {
    if (c.fromPipelineId) pipelines.add(c.fromPipelineId);
    const toPipelineId = rows.get(c.dealId)?.stage?.pipelineId;
    if (toPipelineId) pipelines.add(toPipelineId);
  }
  try {
    await Promise.all([...pipelines].map((pipelineId) => invalidateBoardData(orgId, pipelineId)));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "[deals.syncBoardsAfterDealChanges] invalidate do board falhou",
    );
  }

  let published = 0;
  if (!withinLimit) return { invalidatedPipelines: [...pipelines], published };
  for (const c of changes) {
    const row = rows.get(c.dealId);
    const toPipelineId = row?.stage?.pipelineId;
    const position = row ? Number(row.position) : Number.NaN;
    if (!row || !row.stageId || !toPipelineId || !Number.isFinite(position)) continue;
    const updatedAt = isoInstant(row.updatedAt);
    const card = toDealMovedCard(row, position, updatedAt);
    const payload: DealMovedPayload = {
      organizationId: orgId,
      dealId: c.dealId,
      fromPipelineId: c.fromPipelineId ?? toPipelineId,
      toPipelineId,
      fromStageId: c.fromStageId ?? row.stageId,
      toStageId: row.stageId,
      position,
      updatedAt,
      ...dealMovedOwnership(row),
    };
    publishDealMoved(card ? { ...payload, card } : payload);
    published += 1;
  }
  return { invalidatedPipelines: [...pipelines], published };
}

export async function moveDeal(
  dealId: string,
  targetStageId: string,
  position: number,
  options?: MoveDealOptions,
) {
  // Mudança de fase (incl. GANHO/PERDIDO) não encerra conversa.
  if (!Number.isInteger(position) || position < 0) {
    throw new Error("INVALID_POSITION");
  }

  // Deal não tem pipelineId direto — o funil vem do estágio atual.
  const dealPeek = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, stage: { select: { pipelineId: true } } },
  });
  if (!dealPeek) throw new Error("NOT_FOUND");

  // Preview do estágio destino pra validar lostReason no funil DESTINO
  // (não no de origem) — a UI de troca de pipeline decide o motivo depois
  // que o usuário escolheu o funil, então a política vale para o destino.
  const targetPeek = await prisma.stage.findUnique({
    where: { id: targetStageId },
    select: { pipelineId: true },
  });
  if (!targetPeek) throw new Error("STAGE_NOT_FOUND");

  // Campo obrigatório da etapa destino — antes da transação, igual ao motivo de perda.
  await assertStageEntryFields(dealId, targetStageId);

  // Valida o motivo ANTES de abrir a transação (evita rollback se o destino
  // for o estágio Perdido e o motivo livre tiver sido bloqueado pela setting).
  if (options?.lostReason) {
    await assertLostReasonAllowed(options.lostReason, targetPeek.pipelineId);
  }

  let becameWon = false;
  let becameLost = false;
  // Timeout 20s: sob carga (webhooks + AI) o default 5s estourava em
  // `updateMany` de posição → P2028 → HTTP 500 em /deals/:id/move (~6s).
  // Hidratação (`listInclude`) fica FORA da TX pra liberar locks cedo.
  // Retry em P2034/deadlock: moves concorrentes ainda podem colidir; a
  // ordem de lock reduz, o retry absorve o residual.
  let lastMoveErr: unknown;
  let moveSnapshot: DealMoveSnapshot | null = null;
  for (let attempt = 0; attempt < MOVE_DEAL_MAX_RETRIES; attempt++) {
    try {
      moveSnapshot = await prisma.$transaction(
        async (tx) => {
          // Trava o deal movido antes de ler estágios — evita TOCTOU com
          // outro move do mesmo card.
          await tx.$queryRaw`
            SELECT d.id FROM deals d WHERE d.id = ${dealId} FOR UPDATE
          `;

          const deal = await tx.deal.findUnique({
            where: { id: dealId },
            select: { id: true, stageId: true, position: true, status: true },
          });
          if (!deal) throw new Error("NOT_FOUND");

          const targetStage = await tx.stage.findUnique({
            where: { id: targetStageId },
            select: {
              id: true,
              pipelineId: true,
              isWon: true,
              isLost: true,
            },
          });
          if (!targetStage) throw new Error("STAGE_NOT_FOUND");

          const dealStage = await tx.stage.findUnique({
            where: { id: deal.stageId },
            select: { pipelineId: true },
          });
          if (!dealStage) throw new Error("STAGE_NOT_FOUND");
          // Cross-pipeline permitido: quando o funil muda, a reordenação de
          // posições continua funcionando (origem decrementa, destino incrementa
          // — ambos escopados por stageId, então não há colisão entre funis).

          if (targetStage.isLost) {
            const pipe = await tx.pipeline.findUnique({
              where: { id: targetStage.pipelineId },
              select: { lossReasonRequired: true },
            });
            if (pipe?.lossReasonRequired && !options?.lostReason?.trim()) {
              throw new Error("LOST_REASON_REQUIRED");
            }
          }

          const oldStageId = deal.stageId;
          const statusPatch = buildStatusSyncPatch(
            deal.status,
            targetStage,
            options?.lostReason,
          );
          becameWon = deal.status !== "WON" && targetStage.isWon;
          becameLost = deal.status !== "LOST" && targetStage.isLost;

          // Lock order estável (advisory) nas colunas tocadas.
          await lockStagesForMove(tx, [oldStageId, targetStageId]);

          let newPos: number;
          if (oldStageId === targetStageId) {
            // Indexação fracionária: grava o ponto médio entre os vizinhos
            // do índice alvo — 1 UPDATE na linha movida. Antes reescrevia
            // TODAS as posições do estágio (bulk VALUES) a cada drag.
            const siblings = await tx.deal.count({
              where: { stageId: targetStageId, id: { not: dealId } },
            });
            const clamped = Math.min(position, siblings);
            newPos = await resolveInsertionPosition(
              tx,
              targetStageId,
              clamped,
              dealId,
            );
            await tx.deal.update({
              where: { id: dealId },
              data: { position: newPos, ...statusPatch },
            });
          } else {
            // Cross-stage: idem — ponto médio no destino, SEM shift em massa
            // (`position+1` no destino e `position-1` na origem custavam ~900ms
            // por move em estágios grandes; posições esparsas na origem
            // preservam a ordem sem nenhum UPDATE adicional).
            const targetSiblings = await tx.deal.count({
              where: { stageId: targetStageId },
            });
            const clamped = Math.min(position, targetSiblings);
            newPos = await resolveInsertionPosition(
              tx,
              targetStageId,
              clamped,
            );

            await tx.deal.update({
              where: { id: dealId },
              data: { stageId: targetStageId, position: newPos, ...statusPatch },
            });
          }

          return {
            fromStageId: oldStageId,
            toStageId: targetStageId,
            fromPipelineId: dealStage.pipelineId,
            toPipelineId: targetStage.pipelineId,
            position: newPos,
          };
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      lastMoveErr = undefined;
      break;
    } catch (err) {
      moveSnapshot = null;
      lastMoveErr = err;
      if (!isPrismaDeadlock(err) || attempt >= MOVE_DEAL_MAX_RETRIES - 1) {
        throw err;
      }
      // backoff curto antes de retry (deadlock é transitório)
      await new Promise((r) => setTimeout(r, 25 + attempt * 40));
    }
  }
  if (lastMoveErr) throw lastMoveErr;

  const result = await prisma.deal.findUnique({
    where: { id: dealId },
    include: listInclude,
  });

  // Pós-commit (fire-and-forget; import dinâmico evita ciclo de módulos):
  if (becameWon) {
    void import("@/services/product-fulfillment").then((m) => m.onDealWon(dealId));
    // Catálogo por capacidades (PRD): operação pós-venda agnóstica.
    void import("@/services/fulfillment").then((m) => m.onCommercialDealWon(dealId));
  } else if (becameLost) {
    void import("@/services/product-fulfillment").then((m) =>
      m.onDealReverted(dealId),
    );
  }
  // Funil B2C de candidatos: reserva/contratação ao entrar nos estágios da vaga.
  void import("@/services/product-fulfillment").then((m) =>
    m.onCandidateStageMove(dealId, targetStageId).catch((err) => {
      log.warn(
        { dealId, targetStageId, err: err instanceof Error ? err.message : String(err) },
        "[deals.moveDeal] onCandidateStageMove falhou",
      );
    }),
  );

  // COMMIT já aconteceu. Invalida o cache e só então publica `deal_moved`.
  // Sem org (job fora de contexto) não publica — o barramento descartaria
  // e o TTL cobre o board. Falha de Redis não volta o card.
  if (moveSnapshot) {
    try {
      const orgId = getOrgIdOrThrow();
      publishDealMovedAfterCacheBump(orgId, dealId, moveSnapshot, result);
    } catch {
      /* fora de contexto de org — TTL curto cobre a atualização */
    }
  }

  return result;
}

/**
 * Resolve o estágio terminal (Ganho ou Perdido) do pipeline informado
 * (ou do pipeline ATUAL do deal, quando `pipelineId` não é passado) e o
 * patch de movimentação pra ele (append no fim da coluna). Retorna {}
 * quando o deal já está no terminal certo do MESMO pipeline atual, ou o
 * pipeline destino (legado) não tem o estágio fixo.
 *
 * `pipelineId` explícito (automação "Ganho"/"Perda") permite mover o
 * deal para o terminal de um pipeline DIFERENTE do atual — nesse caso o
 * no-op não se aplica (o estágio atual pertence a outro funil).
 */
async function buildTerminalStageMovePatch(
  tx: ScopedTx,
  deal: { stageId: string },
  kind: "won" | "lost",
  pipelineId?: string | null,
): Promise<Prisma.DealUncheckedUpdateInput> {
  const current = await tx.stage.findUnique({
    where: { id: deal.stageId },
    select: { pipelineId: true, isWon: true, isLost: true },
  });
  if (!current) return {};

  const targetPipelineId = pipelineId ?? current.pipelineId;
  if (
    targetPipelineId === current.pipelineId &&
    (kind === "won" ? current.isWon : current.isLost)
  ) {
    return {};
  }

  const target = await tx.stage.findFirst({
    where: { pipelineId: targetPipelineId, ...(kind === "won" ? { isWon: true } : { isLost: true }) },
    select: { id: true },
  });
  if (!target) return {};

  const max = await tx.deal.aggregate({
    where: { stageId: target.id },
    _max: { position: true },
  });
  return { stageId: target.id, position: (max._max.position ?? -1) + 1 };
}

export type MarkDealTerminalOptions = {
  /** Move o deal para o estágio terminal DESTE pipeline (automação). Sem
   *  isso, usa o pipeline atual do deal (comportamento manual/kanban). */
  pipelineId?: string | null;
};

export async function markDealWon(id: string, opts?: MarkDealTerminalOptions) {
  // Só o negócio. NÃO encerrar conversa: fila segue encerrar + keepAgentOnEnd,
  // independente de GANHO/PERDIDO.
  const result = await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.findUnique({ where: { id }, select: { stageId: true } });
    if (!deal) throw new Error("NOT_FOUND");
    const movePatch = await buildTerminalStageMovePatch(tx, deal, "won", opts?.pipelineId);
    return tx.deal.update({
      where: { id },
      data: {
        status: "WON",
        closedAt: new Date(),
        lostReason: null,
        ...movePatch,
      },
      include: listInclude,
    });
  });
  // Pós-commit (fire-and-forget; import dinâmico evita ciclo deals<->fulfillment).
  void import("@/services/product-fulfillment").then((m) => m.onDealWon(id));
  // Catálogo por capacidades (PRD): operação pós-venda agnóstica.
  void import("@/services/fulfillment").then((m) => m.onCommercialDealWon(id));
  await invalidateBoardsForPipelines([result.stage?.pipelineId]);
  return result;
}

export async function markDealLost(
  id: string,
  lostReason?: string | null,
  opts?: MarkDealTerminalOptions,
) {
  // Só o negócio. NÃO encerrar conversa — ver markDealWon.
  const reason = lostReason?.trim() || null;

  const dealPeek = await prisma.deal.findUnique({
    where: { id },
    select: { stageId: true, stage: { select: { pipelineId: true } } },
  });
  if (!dealPeek) throw new Error("NOT_FOUND");
  const pipelineId = opts?.pipelineId ?? dealPeek.stage.pipelineId;

  const pipe = await prisma.pipeline.findUnique({
    where: { id: pipelineId },
    select: { lossReasonRequired: true },
  });
  if (pipe?.lossReasonRequired && !reason) {
    throw new Error("LOST_REASON_REQUIRED");
  }

  if (opts?.pipelineId) {
    // Automação (node "Perda"): sempre catálogo do pipeline informado —
    // ignora `lossReasonAllowOther` (sem opção "Outro" nesse fluxo).
    const { assertLostReasonAllowedForPipeline } = await import("@/services/loss-reasons");
    await assertLostReasonAllowedForPipeline(pipelineId, reason, false);
  } else {
    await assertLostReasonAllowed(reason, pipelineId);
  }

  const result = await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.findUnique({ where: { id }, select: { stageId: true } });
    if (!deal) throw new Error("NOT_FOUND");
    const movePatch = await buildTerminalStageMovePatch(tx, deal, "lost", opts?.pipelineId);
    return tx.deal.update({
      where: { id },
      data: {
        status: "LOST",
        closedAt: new Date(),
        lostReason: reason,
        ...movePatch,
      },
      include: listInclude,
    });
  });
  // Perda: estorna alocações (no-op se não houver; cobre "desistência" no funil B2C).
  void import("@/services/product-fulfillment").then((m) => m.onDealReverted(id));
  await invalidateBoardsForPipelines([
    result.stage?.pipelineId,
    dealPeek.stage.pipelineId,
  ]);
  return result;
}

export async function reopenDeal(id: string) {
  // Reabrir SÓ troca o status (LOST/WON → OPEN) e mantém o `stageId` atual.
  //
  // Antes movíamos o deal automaticamente para o "último estágio operacional"
  // do pipeline (findFirst com `isWon=false AND isLost=false ORDER BY position
  // desc`) — o que na prática empurrava deals reabertos direto pra etapa
  // quase-final do funil (ex.: "Formalização feita" na Dna Work), sem
  // registrar `STAGE_CHANGED` na timeline. Comportamento surpreendente e
  // sem auditoria — ver incidente 2026-08-05.
  //
  // Agora o deal fica onde estava e o operador decide o destino via
  // automação (trigger `message_received` com filtro `stage == Perdido`, por
  // exemplo) ou movendo manualmente no kanban — ambos caminhos JÁ registram
  // `STAGE_CHANGED` corretamente (automation-executor L1124 / route deals).
  const result = await prisma.deal.update({
    where: { id },
    data: {
      status: "OPEN",
      closedAt: null,
      lostReason: null,
    },
    include: listInclude,
  });
  // Reabertura: estorna alocações consumidas no ganho (lança inversos).
  void import("@/services/product-fulfillment").then((m) => m.onDealReverted(id));
  await invalidateBoardsForPipelines([result.stage?.pipelineId]);
  return result;
}

/**
 * Cards por coluna no board: padrão 50, teto 200 (K4; eram 100 e 500). O
 * resto da coluna vem pelo "carregar mais" por cursor. Fonte única em
 * `board-cache-variant.ts` (a chave do cache normaliza com os mesmos números).
 */
const MAX_BOARD_COLUMN_LIMIT = BOARD_MAX_PER_STAGE;
/**
 * TTL do cache-aside do board. Curto o bastante pra manter o quadro
 * "fresco" (novos leads via webhook aparecem em ≤ este intervalo), longo
 * o bastante pra colapsar a rajada de cargas idênticas sob carga.
 *
 * 30s (antes 8s): a query base do board custa ~2,4s; com TTL de 8s ela
 * recomputava a cada 8s sob uso contínuo, gerando picos periódicos de CPU
 * (oscilação 13→140% em 24/jul/26). `moveDeal` invalida explicitamente, então
 * a ação manual do operador continua refletindo na hora — o TTL só cobre o
 * fluxo de leitura/webhook, onde 30s de staleness é aceitável.
 */
const BOARD_CACHE_TTL_SEC = 45;

/**
 * Critério de ordenação dos cards dentro de cada coluna do board.
 *
 * - `position` (default): ordem manual definida por drag-and-drop.
 *   Preserva o comportamento histórico do Kanban (cada deal carrega
 *   um inteiro `position` mantido pelas mutações de DnD).
 * - `createdAt`: ordena pelo timestamp de criação do deal. Usado pelas
 *   opções "Criação: mais recente" / "Criação: mais antigo" do menu
 *   kebab do Kanban no frontend (`_v2-client.tsx`). Cobre TODOS os
 *   cards da coluna porque o orderBy roda antes do `take` do Prisma —
 *   ao contrário do sort client-side antigo, que só ordenava os deals
 *   já carregados (default 50 por coluna).
 * - `lastInteraction`: ordena pela última MENSAGEM de chat do contato
 *   vinculado ao deal — `contacts.lastMessageAt`, coluna mantida no mesmo
 *   ponto que `conversations.lastMessageAt` (K1). Antes era
 *   `MAX(conversations.updatedAt)` do contato, calculado por card a cada
 *   carga e renovado por gravações que não são mensagem (atribuição,
 *   varredura de distribuição). Contato com a coluna NULL (backfill
 *   pendente ou sem mensagem de chat) cai, só ele, em
 *   `MAX(COALESCE(conversations.lastMessageAt, conversations.updatedAt))`
 *   (`boardLastInteractionSql`). Deals sem contato/conversa ficam no fim
 *   (`nulls last`) em ambas as direções; `position` é tiebreaker.
 */
export type BoardSortField = "position" | "createdAt" | "lastInteraction";
export type BoardSortDirection = "asc" | "desc";

function buildBoardDealOrderBy(
  sortField: BoardSortField | undefined,
  sortDirection: BoardSortDirection | undefined,
): Prisma.DealOrderByWithRelationInput[] {
  if (sortField === "createdAt") {
    const dir: BoardSortDirection = sortDirection === "desc" ? "desc" : "asc";
    // `position` como tiebreaker mantém ordem estável quando vários
    // deals têm o mesmo timestamp (importações em lote, seeds).
    // `id` fecha a ordem total (igual ao `boardRankOrderBySql`): sem ele,
    // empate em `position` deixava o corte da página indefinido.
    return [{ createdAt: dir }, { position: "asc" }, { id: "asc" }];
  }
  // `lastInteraction` não cai aqui — segue por caminho próprio em
  // `loadBoardStagesByLastInteraction`. Fallback estável.
  return [{ position: "asc" }, { id: "asc" }];
}

/** Campos do Deal incluídos em cada card do board. Reusado pelo caminho
 *  default (Prisma include) e pelo caminho `lastInteraction`
 *  (findMany separado dos IDs paginados). */
const BOARD_DEAL_INCLUDE = {
  contact: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      avatarUrl: true,
    },
  },
  owner: { select: { id: true, name: true, avatarUrl: true, type: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
  activities: {
    where: { completed: false },
    select: { id: true, scheduledAt: true },
    take: 5,
  },
} satisfies Prisma.DealInclude;

type BoardStageWithDeals = Prisma.StageGetPayload<{
  include: { deals: { include: typeof BOARD_DEAL_INCLUDE } };
}>;

/** Etapa "crua" (sem deals) como sai de `prisma.stage.findMany`. */
type BoardStageRaw = Omit<BoardStageWithDeals, "deals">;

/**
 * Teto de consultas por etapa em voo no caminho de fallback (where que o
 * tradutor SQL não cobre). O pool da API tem 20 conexões por processo
 * (`prisma-base.ts`); antes o `Promise.all` de N etapas + totais + métricas
 * + enriquecimentos chegava a ~18 conexões numa única carga do board.
 */
const BOARD_STAGE_FALLBACK_CONCURRENCY = 4;

/**
 * `map` assíncrono com no máximo `limit` promessas em voo. Fila mínima sem
 * dependência nova; preserva a ordem de `items` no resultado.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i] as T, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Tradução do `Prisma.DealWhereInput` do board para SQL cru parametrizado.
//
// O board monta o where com peças conhecidas: status (default `OPEN` ou
// `ALL`), visibilidade (`ownerId` / `OR ownerId null` / `ownerId not null`),
// escopo de funil (`stageId in/notIn`, `stage.pipelineId notIn`) e, no POST
// com filtros avançados, campos escalares e relações (tags, contato…).
//
// Só o subconjunto escalar é traduzido. Qualquer chave/operador fora da
// lista devolve `null` e o board cai no caminho antigo (uma consulta Prisma
// por etapa, agora com concorrência limitada) — nunca aproxima semântica.
//
// Nomes de coluna vêm SEMPRE destas tabelas (constantes); valores viajam
// como parâmetros do `Prisma.sql`. Nada do usuário entra no texto do SQL.
// ---------------------------------------------------------------------------

/** Colunas texto/cuid de `deals` (nome Prisma → coluna no banco). */
const BOARD_DEAL_TEXT_COLUMNS: Readonly<Record<string, string>> = {
  id: "id",
  ownerId: "ownerId",
  contactId: "contactId",
  stageId: "stageId",
  lostReason: "lostReason",
  orgUnitId: "orgUnitId",
  assignedVia: "assignedVia",
  externalId: "external_id",
};
/** Colunas enum: o parâmetro precisa de cast (`$1::"DealStatus"`). */
const BOARD_DEAL_ENUM_COLUMNS: Readonly<
  Record<string, { column: string; pgType: string }>
> = {
  status: { column: "status", pgType: "DealStatus" },
  dealRole: { column: "dealRole", pgType: "DealRole" },
};
/** Colunas de data (filtros avançados `createdAt`/`updatedAt`/`closedAt`). */
const BOARD_DEAL_DATE_COLUMNS: Readonly<Record<string, string>> = {
  createdAt: "createdAt",
  updatedAt: "updatedAt",
  closedAt: "closedAt",
  expectedClose: "expectedClose",
};

const SQL_TRUE = Prisma.sql`TRUE`;
const SQL_FALSE = Prisma.sql`FALSE`;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function sqlAndAll(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) return SQL_TRUE;
  if (parts.length === 1) return parts[0] as Prisma.Sql;
  return Prisma.join(parts, " AND ", "(", ")");
}

function sqlOrAll(parts: Prisma.Sql[]): Prisma.Sql {
  if (parts.length === 0) return SQL_FALSE;
  if (parts.length === 1) return parts[0] as Prisma.Sql;
  return Prisma.join(parts, " OR ", "(", ")");
}

/** Referência de coluna de `deals` (alias `d`). `column` vem da whitelist. */
function dealCol(column: string): Prisma.Sql {
  return Prisma.raw(`d."${column}"`);
}

/**
 * Filtro escalar de texto/enum: `valor`, `null`, `{ equals, in, notIn,
 * not: null }`. `not: <valor>` tem tratamento de NULL próprio no Prisma →
 * não traduz (fallback).
 */
function translateScalarFilter(
  col: Prisma.Sql,
  value: unknown,
  pgType: string | null,
): Prisma.Sql | null {
  const cast = pgType ? Prisma.raw(`::"${pgType}"`) : Prisma.empty;
  const castArr = pgType ? Prisma.raw(`::"${pgType}"[]`) : Prisma.empty;
  if (value === null) return Prisma.sql`${col} IS NULL`;
  if (typeof value === "string") return Prisma.sql`${col} = ${value}${cast}`;
  if (!isPlainObject(value)) return null;
  const parts: Prisma.Sql[] = [];
  for (const [op, v] of Object.entries(value)) {
    if (v === undefined) continue;
    switch (op) {
      case "equals":
        if (v === null) parts.push(Prisma.sql`${col} IS NULL`);
        else if (typeof v === "string") parts.push(Prisma.sql`${col} = ${v}${cast}`);
        else return null;
        break;
      case "not":
        if (v === null) parts.push(Prisma.sql`${col} IS NOT NULL`);
        else return null;
        break;
      case "in":
      case "notIn": {
        if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return null;
        if (v.length === 0) {
          // Prisma: `in: []` não casa nada; `notIn: []` casa tudo.
          parts.push(op === "in" ? SQL_FALSE : SQL_TRUE);
          break;
        }
        const inSql = Prisma.sql`${col} = ANY(${v as string[]}${castArr})`;
        parts.push(op === "in" ? inSql : Prisma.sql`NOT (${inSql})`);
        break;
      }
      default:
        return null;
    }
  }
  return sqlAndAll(parts);
}

function toDateParam(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Filtro de data: `Date`, `null` ou `{ equals, gt, gte, lt, lte, not: null }`. */
function translateDateFilter(col: Prisma.Sql, value: unknown): Prisma.Sql | null {
  if (value === null) return Prisma.sql`${col} IS NULL`;
  const direct = toDateParam(value);
  if (direct) return Prisma.sql`${col} = ${direct}`;
  if (!isPlainObject(value)) return null;
  const parts: Prisma.Sql[] = [];
  for (const [op, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (op === "not" && v === null) {
      parts.push(Prisma.sql`${col} IS NOT NULL`);
      continue;
    }
    if (op === "equals" && v === null) {
      parts.push(Prisma.sql`${col} IS NULL`);
      continue;
    }
    const d = toDateParam(v);
    if (!d) return null;
    switch (op) {
      case "equals":
        parts.push(Prisma.sql`${col} = ${d}`);
        break;
      case "gt":
        parts.push(Prisma.sql`${col} > ${d}`);
        break;
      case "gte":
        parts.push(Prisma.sql`${col} >= ${d}`);
        break;
      case "lt":
        parts.push(Prisma.sql`${col} < ${d}`);
        break;
      case "lte":
        parts.push(Prisma.sql`${col} <= ${d}`);
        break;
      default:
        return null;
    }
  }
  return sqlAndAll(parts);
}

/**
 * Relação `stage`: só `pipelineId` (`{ pipelineId }` ou `{ is: { pipelineId } }`),
 * via subconsulta em `stages` — é o que `funnelDealWhere` e os filtros
 * avançados produzem. Qualquer outra chave → fallback.
 */
function translateStageFilter(value: unknown): Prisma.Sql | null {
  if (!isPlainObject(value)) return null;
  let inner: Record<string, unknown> = value;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length === 1 && keys[0] === "is") {
    if (!isPlainObject(value.is)) return null;
    inner = value.is;
  } else if (keys.includes("is") || keys.includes("isNot")) {
    return null;
  }
  const parts: Prisma.Sql[] = [];
  for (const [k, v] of Object.entries(inner)) {
    if (v === undefined) continue;
    if (k !== "pipelineId") return null;
    const cond = translateScalarFilter(Prisma.raw(`st."pipelineId"`), v, null);
    if (!cond) return null;
    parts.push(cond);
  }
  return Prisma.sql`d."stageId" IN (SELECT st.id FROM stages st WHERE ${sqlAndAll(parts)})`;
}

/**
 * Relação `tags` (`tags_on_deals`): `some`/`none` com `{}` ou só `tagId`
 * (`valor`, `{ in }`, `{ equals }`) — o que os filtros de tag produzem
 * (`kanban-filters.ts`: qualquer / todas / nenhuma / sem tag). `every` e
 * outras chaves → fallback.
 */
function translateTagsFilter(value: unknown): Prisma.Sql | null {
  if (!isPlainObject(value)) return null;
  const parts: Prisma.Sql[] = [];
  for (const [op, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    if ((op !== "some" && op !== "none") || !isPlainObject(inner)) return null;
    const conds: Prisma.Sql[] = [];
    for (const [k, v] of Object.entries(inner)) {
      if (v === undefined) continue;
      if (k !== "tagId") return null;
      const cond = translateScalarFilter(Prisma.raw(`tg."tagId"`), v, null);
      if (!cond) return null;
      conds.push(cond);
    }
    const exists = Prisma.sql`EXISTS (SELECT 1 FROM tags_on_deals tg WHERE tg."dealId" = d.id AND ${sqlAndAll(conds)})`;
    parts.push(op === "some" ? exists : Prisma.sql`NOT ${exists}`);
  }
  return parts.length > 0 ? sqlAndAll(parts) : null;
}

/** Colunas texto de `contacts` usadas pelos filtros do board. */
const BOARD_CONTACT_TEXT_COLUMNS: Readonly<Record<string, string>> = {
  source: "source",
  adUtmSource: "ad_utm_source",
  phone: "phone",
  email: "email",
  // Filtro "Mensagem recebida/enviada" em coluna pronta (K1).
  lastMessageDirection: "lastMessageDirection",
};

/** Colunas de data de `contacts` usadas pelos filtros do board. */
const BOARD_CONTACT_DATE_COLUMNS: Readonly<Record<string, string>> = {
  // Contato ainda sem a coluna pronta (`IS NULL`) no filtro de direção (K1).
  lastMessageAt: "lastMessageAt",
};

/**
 * Relação `conversations` do contato: `some`/`none` só com `status`
 * (`"RESOLVED"` ou `{ not: "RESOLVED" }`) e `lastMessageDirection` — o que o
 * caminho antigo do filtro de direção produz (`kanban-filters.ts`). Qualquer
 * outra chave → fallback. Sem filtro por organização, como no Prisma: o
 * índice `(contactId, status)` atende.
 */
function translateContactConversationsFilter(value: unknown): Prisma.Sql | null {
  if (!isPlainObject(value)) return null;
  const parts: Prisma.Sql[] = [];
  for (const [op, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    if ((op !== "some" && op !== "none") || !isPlainObject(inner)) return null;
    const conds: Prisma.Sql[] = [];
    for (const [k, v] of Object.entries(inner)) {
      if (v === undefined) continue;
      if (k === "status") {
        if (v === "RESOLVED") conds.push(Prisma.sql`cv.status = 'RESOLVED'`);
        else if (isPlainObject(v) && Object.keys(v).length === 1 && v.not === "RESOLVED") {
          conds.push(Prisma.sql`cv.status <> 'RESOLVED'`);
        } else return null;
      } else if (k === "lastMessageDirection") {
        if (v !== "in" && v !== "out") return null;
        conds.push(Prisma.sql`cv."lastMessageDirection" = ${v}`);
      } else {
        return null;
      }
    }
    const exists = Prisma.sql`EXISTS (SELECT 1 FROM conversations cv WHERE cv."contactId" = ct.id AND ${sqlAndAll(conds)})`;
    parts.push(op === "some" ? exists : Prisma.sql`NOT ${exists}`);
  }
  return parts.length > 0 ? sqlAndAll(parts) : null;
}

/** Where de `contacts` (alias `ct`) só com colunas da lista e AND/OR. */
function translateContactWhere(where: unknown): Prisma.Sql | null {
  if (!isPlainObject(where)) return null;
  const parts: Prisma.Sql[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    let frag: Prisma.Sql | null;
    if (key === "AND" || key === "OR") {
      const list = Array.isArray(value) ? value : [value];
      const subs: Prisma.Sql[] = [];
      for (const w of list) {
        const sub = translateContactWhere(w);
        if (!sub) return null;
        subs.push(sub);
      }
      frag = key === "AND" ? sqlAndAll(subs) : sqlOrAll(subs);
    } else if (hasOwn(BOARD_CONTACT_TEXT_COLUMNS, key)) {
      frag = translateScalarFilter(
        Prisma.raw(`ct."${BOARD_CONTACT_TEXT_COLUMNS[key] as string}"`),
        value,
        null,
      );
    } else if (hasOwn(BOARD_CONTACT_DATE_COLUMNS, key)) {
      frag = translateDateFilter(
        Prisma.raw(`ct."${BOARD_CONTACT_DATE_COLUMNS[key] as string}"`),
        value,
      );
    } else if (key === "conversations") {
      frag = translateContactConversationsFilter(value);
    } else {
      frag = null;
    }
    if (!frag) return null;
    parts.push(frag);
  }
  return sqlAndAll(parts);
}

/**
 * Relação `contact` (to-one): `{ is: {...} }` ou o objeto direto — "o
 * negócio TEM contato e o contato casa". É o que origem, UTM e "tem
 * telefone/e-mail" produzem. `is: null`, `isNot` e busca por texto
 * (`contains`) → fallback.
 */
function translateContactFilter(value: unknown): Prisma.Sql | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  let inner: unknown = value;
  if (keys.includes("is") || keys.includes("isNot")) {
    if (keys.length !== 1 || keys[0] !== "is") return null;
    inner = value.is;
  }
  const cond = translateContactWhere(inner);
  if (!cond) return null;
  return Prisma.sql`EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = d."contactId" AND ct."organizationId" = d."organizationId" AND ${cond})`;
}

/**
 * Traduz o where do board para um fragmento SQL (alias `d` = `deals`).
 * Retorna `null` quando encontra algo fora do subconjunto suportado — o
 * caller usa o caminho Prisma por etapa. `{}`/`undefined` → `TRUE`.
 */
export function translateDealWhereToSql(
  where: Prisma.DealWhereInput | null | undefined,
): Prisma.Sql | null {
  if (!where) return SQL_TRUE;
  if (!isPlainObject(where)) return null;
  const parts: Prisma.Sql[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    let frag: Prisma.Sql | null;
    if (key === "AND" || key === "OR") {
      const list = Array.isArray(value) ? value : [value];
      const subs: Prisma.Sql[] = [];
      for (const w of list) {
        const s = translateDealWhereToSql(w as Prisma.DealWhereInput);
        if (!s) return null;
        subs.push(s);
      }
      frag = key === "AND" ? sqlAndAll(subs) : sqlOrAll(subs);
    } else if (key === "NOT") {
      frag = null;
    } else if (hasOwn(BOARD_DEAL_TEXT_COLUMNS, key)) {
      frag = translateScalarFilter(
        dealCol(BOARD_DEAL_TEXT_COLUMNS[key] as string),
        value,
        null,
      );
    } else if (hasOwn(BOARD_DEAL_ENUM_COLUMNS, key)) {
      const spec = BOARD_DEAL_ENUM_COLUMNS[key] as { column: string; pgType: string };
      frag = translateScalarFilter(dealCol(spec.column), value, spec.pgType);
    } else if (hasOwn(BOARD_DEAL_DATE_COLUMNS, key)) {
      frag = translateDateFilter(
        dealCol(BOARD_DEAL_DATE_COLUMNS[key] as string),
        value,
      );
    } else if (key === "stage") {
      frag = translateStageFilter(value);
    } else if (key === "tags") {
      frag = translateTagsFilter(value);
    } else if (key === "contact") {
      frag = translateContactFilter(value);
    } else {
      frag = null;
    }
    if (!frag) return null;
    parts.push(frag);
  }
  return sqlAndAll(parts);
}

/**
 * Teto de ids pré-resolvidos quando o where tem filtro que o tradutor não
 * cobre (conversa, janela 24 h, campo personalizado, busca). Acima disso o
 * board volta ao caminho por etapa.
 */
const BOARD_PRERESOLVE_CAP = 20_000;

/** Ids pré-resolvidos: fragmento SQL para a janela + total por etapa. */
type PreResolvedBoardWhere = {
  sql: Prisma.Sql;
  countsByStage: Map<string, number>;
};

/**
 * Where não traduzível: UMA consulta Prisma (`select id, stageId`; as
 * relações viram subconsultas no mesmo SELECT) resolve os negócios que
 * casam nas etapas do board, e a janela por etapa roda sobre
 * `d.id = ANY(ids)`. Antes, um `findMany` com include POR ETAPA (4 em voo),
 * cada um com ~6 SELECTs no motor do Prisma. Semântica idêntica: quem
 * avalia o where é o Prisma. Os totais por etapa saem da mesma lista — o
 * `groupBy` com o mesmo filtro caro não roda. `null` = passou do teto.
 */
async function preResolveBoardWhere(
  dealWhere: Prisma.DealWhereInput,
  stageIds: readonly string[],
  cap: number = BOARD_PRERESOLVE_CAP,
): Promise<PreResolvedBoardWhere | null> {
  if (stageIds.length === 0) return { sql: SQL_FALSE, countsByStage: new Map() };
  const rows = await prisma.deal.findMany({
    where: { AND: [dealWhere, { stageId: { in: [...stageIds] } }] },
    select: { id: true, stageId: true },
    take: cap + 1,
  });
  if (rows.length > cap) return null;
  const countsByStage = new Map<string, number>();
  for (const r of rows) countsByStage.set(r.stageId, (countsByStage.get(r.stageId) ?? 0) + 1);
  return {
    sql: rows.length === 0 ? SQL_FALSE : Prisma.sql`d.id = ANY(${rows.map((r) => r.id)})`,
    countsByStage,
  };
}

/**
 * Where do board em SQL para as etapas dadas. `direct` = traduzido direto
 * (só nesse caso o cursor de `lastInteraction` vale). `sql: null` = nem
 * traduz nem cabe no teto → caminho por etapa.
 */
type BoardWhereResolver = (stageIds: readonly string[]) => Promise<{
  sql: Prisma.Sql | null;
  direct: boolean;
  /**
   * Where Prisma COMPLETO (busca incluída, com os ids resolvidos) para o
   * caminho por etapa, quando `sql` é `null`. Sem busca, o próprio `dealWhere`.
   */
  where: Prisma.DealWhereInput;
}>;

/**
 * Restrição em SQL (alias `d`) com o que dá para traduzir de uma lista de
 * condições em AND — as que não traduzem ficam de fora. Serve só para estreitar
 * a consulta de ids da busca: as condições continuam no where final, então
 * estreitar nunca muda o resultado, só reduz candidatos.
 */
function narrowSqlOfConditions(
  conditions: readonly Prisma.DealWhereInput[],
): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  for (const c of conditions) {
    const sql = translateDealWhereToSql(c);
    if (sql) parts.push(sql);
  }
  return parts.length > 0 ? sqlAndAll(parts) : null;
}

/** Condições de primeiro nível de um where (o `AND` vira lista; senão, ele mesmo). */
function andConditionsOf(where: Prisma.DealWhereInput): Prisma.DealWhereInput[] {
  if (Array.isArray(where.AND)) return where.AND;
  return where.AND ? [where.AND] : [where];
}

/**
 * Resolvedor com memória: a pré-resolução roda no máximo uma vez por carga.
 *
 * Busca livre (`search`): quando o resto do where traduz para SQL, o predicado
 * da busca (subconsultas, sem lista de ids) entra NA MESMA consulta da janela
 * (`direct`) — cursor de `lastInteraction`, contagem por etapa e "carregar
 * mais" valem como sem busca. Se o resto não traduz, os ids da busca saem de
 * uma consulta só e o Prisma avalia o where inteiro (visibilidade incluída).
 */
function createBoardWhereResolver(
  dealWhere: Prisma.DealWhereInput,
  search: DealSearch | null = null,
): {
  resolve: BoardWhereResolver;
  /** Resultado da pré-resolução (`undefined` = não rodou; `null` = teto). */
  preResolved: () => PreResolvedBoardWhere | null | undefined;
  directSql: Prisma.Sql | null;
  /** Where Prisma completo da última resolução (antes dela, o `dealWhere`). */
  fullWhere: () => Prisma.DealWhereInput;
} {
  const baseSql = translateDealWhereToSql(dealWhere);
  const directSql = baseSql && search ? sqlAndAll([baseSql, search.sql]) : baseSql;
  let pre: Promise<PreResolvedBoardWhere | null> | undefined;
  let settled: PreResolvedBoardWhere | null | undefined;
  let fullWhere = dealWhere;
  return {
    directSql,
    preResolved: () => settled,
    fullWhere: () => fullWhere,
    resolve: async (stageIds) => {
      if (directSql) return { sql: directSql, direct: true, where: dealWhere };
      if (search) {
        const narrow = narrowSqlOfConditions([
          ...andConditionsOf(dealWhere),
          { stageId: { in: [...stageIds] } },
        ]);
        fullWhere = {
          AND: [dealWhere, await search.prismaWhere({ narrowSql: narrow })],
        };
      }
      pre ??= preResolveBoardWhere(fullWhere, stageIds).then((r) => (settled = r));
      const r = await pre;
      return { sql: r?.sql ?? null, direct: false, where: fullWhere };
    },
  };
}

type BoardRankedRow = {
  id: string;
  stageId: string;
  rn: number;
  /**
   * Total de negócios da etapa que casam com o where (`COUNT(*) OVER
   * (PARTITION BY "stageId")` da mesma janela) — K3: a contagem por etapa
   * não é mais uma consulta à parte.
   */
  total?: number | bigint | null;
  /** Só no ranking por `lastInteraction` (chave do cursor da etapa). */
  last_at?: Date | string | null;
};

/** `ORDER BY` da janela por etapa; `id` como último desempate estável. */
function boardRankOrderBySql(
  sortField: BoardSortField | undefined,
  sortDirection: BoardSortDirection,
): Prisma.Sql {
  if (sortField === "createdAt") {
    return sortDirection === "desc"
      ? Prisma.sql`d."createdAt" DESC, d."position" ASC, d.id ASC`
      : Prisma.sql`d."createdAt" ASC, d."position" ASC, d.id ASC`;
  }
  return Prisma.sql`d."position" ASC, d.id ASC`;
}

/**
 * UMA consulta para todas as colunas: `ROW_NUMBER() OVER (PARTITION BY
 * "stageId" ORDER BY …) <= maxPerStage`. Devolve (id, stageId, rn, total); a
 * hidratação (contato, dono, tags, atividades) é um `findMany` por `id IN`.
 * `total` = `COUNT(*) OVER (PARTITION BY "stageId")`: o total da etapa sai da
 * mesma passada (etapa sem negócio não devolve linha → total 0).
 *
 * Antes: N `findMany` (um por etapa, cada um com include) em `Promise.all`,
 * e a contagem num `groupBy` do Prisma à parte (2–3 LEFT JOIN em `stages`).
 */
export function buildRankedBoardDealsSql(args: {
  orgId: string;
  stageIds: string[];
  whereSql: Prisma.Sql;
  orderBy: Prisma.Sql;
  maxPerStage: number;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT r.id, r."stageId", r.rn, r.total
    FROM (
      SELECT
        d.id,
        d."stageId",
        ROW_NUMBER() OVER (
          PARTITION BY d."stageId"
          ORDER BY ${args.orderBy}
        )::int AS rn,
        COUNT(*) OVER (PARTITION BY d."stageId")::int AS total
      FROM deals d
      WHERE d."organizationId" = ${args.orgId}
        AND d."stageId" = ANY(${args.stageIds})
        AND (${args.whereSql})
    ) r
    WHERE r.rn <= ${args.maxPerStage}
    ORDER BY r."stageId", r.rn
  `;
}

/**
 * Teto de deals por etapa antes de ordenar por última interação. Pega os N
 * mais recentemente mexidos (`deal.updatedAt` desc — bom proxy de atividade)
 * e reordena esse recorte por recência de conversa. Uma coluna com mais de
 * N deals perde exatidão só no fim da ordenação (irrelevante — o board
 * mostra ~dezenas de cards). Mantido em 2.500, o valor calibrado em
 * 2e3fda3.
 */
const LAST_INTERACTION_STAGE_SCAN_CAP = 2_500;

function stagesAllowedByFilter<T extends { id: string }>(
  stages: T[],
  filters?: AdvancedDealFilters,
): T[] {
  const ids = filters?.stageIds;
  if (!ids?.length) return stages;
  const allow = new Set(ids);
  return stages.filter((stage) => allow.has(stage.id));
}

/**
 * `last_at` (última interação) de cada candidato `c` do board, em SQL:
 * `contacts.lastMessageAt` pela PK e, SÓ quando a coluna está NULL, o
 * fallback em `conversations` — o `ct."lastMessageAt" IS NULL` dentro do
 * LATERAL vira filtro de uma vez por linha, então contato já preenchido não
 * toca em `conversations`. Devolve os JOINs e a expressão.
 */
function boardLastInteractionSql(orgId: string): { joins: Prisma.Sql; lastAt: Prisma.Sql } {
  return {
    joins: Prisma.sql`
      LEFT JOIN contacts ct
        ON ct.id = c."contactId" AND ct."organizationId" = ${orgId}
      LEFT JOIN LATERAL (
        SELECT MAX(COALESCE(cv."lastMessageAt", cv."updatedAt")) AS last_at
        FROM conversations cv
        WHERE ct.id IS NOT NULL
          AND ct."lastMessageAt" IS NULL
          AND cv."organizationId" = ${orgId}
          AND cv."contactId" = c."contactId"
      ) fb ON TRUE`,
    lastAt: Prisma.sql`COALESCE(ct."lastMessageAt", fb.last_at)`,
  };
}

/**
 * `lastInteraction` em UMA consulta: candidatos por etapa (janela por
 * `updatedAt` até `scanCap`), última mensagem do contato desses candidatos
 * (`boardLastInteractionSql`: coluna pronta em `contacts`, fallback em
 * `conversations` só para quem está NULL) e segunda janela por etapa na
 * ordem final.
 *
 * Antes: `LEFT JOIN LATERAL (SELECT MAX(cv."updatedAt") …)` para todo
 * candidato (78–382 ms × ~14.800 em produção, 05/10).
 */
export function buildLastInteractionRankedSql(args: {
  orgId: string;
  stageIds: string[];
  whereSql: Prisma.Sql;
  direction: BoardSortDirection;
  scanCap: number;
  maxPerStage: number;
}): Prisma.Sql {
  const dir = args.direction === "desc" ? Prisma.raw("DESC") : Prisma.raw("ASC");
  const li = boardLastInteractionSql(args.orgId);
  return Prisma.sql`
    WITH candidates AS (
      SELECT
        d.id,
        d."stageId",
        d."contactId",
        d."position",
        ROW_NUMBER() OVER (
          PARTITION BY d."stageId"
          ORDER BY d."updatedAt" DESC, d.id DESC
        )::int AS scan_rn,
        COUNT(*) OVER (PARTITION BY d."stageId")::int AS total
      FROM deals d
      WHERE d."organizationId" = ${args.orgId}
        AND d."stageId" = ANY(${args.stageIds})
        AND (${args.whereSql})
    ),
    scored AS (
      SELECT c.id, c."stageId", c."position", c.total, ${li.lastAt} AS last_at
      FROM candidates c
      ${li.joins}
      WHERE c.scan_rn <= ${args.scanCap}
    ),
    ranked AS (
      SELECT
        s.id,
        s."stageId",
        s.last_at,
        s.total,
        ROW_NUMBER() OVER (
          PARTITION BY s."stageId"
          ORDER BY s.last_at ${dir} NULLS LAST, s."position" ASC, s.id ASC
        )::int AS rn
      FROM scored s
    )
    SELECT r.id, r."stageId", r.rn, r.last_at, r.total
    FROM ranked r
    WHERE r.rn <= ${args.maxPerStage}
    ORDER BY r."stageId", r.rn
  `;
}

/** Totais por etapa lidos das linhas ranqueadas (`total` da janela). */
function collectRankedTotals(
  rows: readonly BoardRankedRow[],
  totalsOut: Map<string, number> | undefined,
): void {
  if (!totalsOut) return;
  for (const row of rows) {
    if (row.total == null || totalsOut.has(row.stageId)) continue;
    totalsOut.set(row.stageId, Number(row.total));
  }
}

/**
 * Contagem por etapa em SQL — para quem não passa pela janela ranqueada (o
 * "Carregar mais" por cursor). Mesmo where traduzido do board, sem JOIN:
 * `stageId = ANY(etapas)` já escopa o funil.
 */
export function buildBoardStageTotalsSql(args: {
  orgId: string;
  stageIds: string[];
  whereSql: Prisma.Sql;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT d."stageId", COUNT(*)::int AS total
    FROM deals d
    WHERE d."organizationId" = ${args.orgId}
      AND d."stageId" = ANY(${args.stageIds})
      AND (${args.whereSql})
    GROUP BY d."stageId"
  `;
}

function boardLimitByStage(
  stagesRaw: readonly BoardStageRaw[],
  perStage: number,
  offsetByStage: Record<string, number>,
): Map<string, number> {
  return new Map(
    stagesRaw.map((s) => [s.id, perStage + (offsetByStage[s.id] ?? 0)] as const),
  );
}

/** Linhas ranqueadas → ids por etapa, já cortados no limite de cada uma. */
function groupRankedIdsByStage(
  rows: readonly BoardRankedRow[],
  limitByStage: Map<string, number>,
): Map<string, string[]> {
  const byStage = new Map<string, { id: string; rn: number }[]>();
  for (const row of rows) {
    const limit = limitByStage.get(row.stageId);
    if (limit == null || row.rn > limit) continue;
    const list = byStage.get(row.stageId) ?? [];
    list.push({ id: row.id, rn: row.rn });
    byStage.set(row.stageId, list);
  }
  const out = new Map<string, string[]>();
  for (const [stageId, list] of byStage) {
    out.set(
      stageId,
      list.sort((a, b) => a.rn - b.rn).map((r) => r.id),
    );
  }
  return out;
}

/**
 * `findMany` completo (include do card) só dos ids já paginados, e remonta
 * cada etapa na ordem de `idsByStage`.
 */
async function hydrateBoardStages(
  stagesRaw: readonly BoardStageRaw[],
  idsByStage: Map<string, string[]>,
): Promise<BoardStageWithDeals[]> {
  const allIds = Array.from(idsByStage.values()).flat();
  const dealsLoaded =
    allIds.length === 0
      ? []
      : await prisma.deal.findMany({
          where: { id: { in: allIds } },
          include: BOARD_DEAL_INCLUDE,
        });
  const dealById = new Map(dealsLoaded.map((d) => [d.id, d]));
  return stagesRaw.map((stage) => {
    const ids = idsByStage.get(stage.id) ?? [];
    const deals = ids
      .map((id) => dealById.get(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d));
    return { ...stage, deals };
  });
}

/**
 * O único jeito de ainda cair no `findMany` por etapa: filtro que o tradutor
 * SQL não cobre E mais de `BOARD_PRERESOLVE_CAP` negócios casando. Fica no
 * log para sabermos se acontece em produção (era o caminho dos 3 formatos de
 * `findMany` por etapa que somavam 67,5 M linhas na main).
 */
function logBoardPerStageFallback(pipelineId: string, sortField: BoardSortField | undefined): void {
  log.info(
    { pipelineId, sort: sortField ?? "position", cap: BOARD_PRERESOLVE_CAP },
    "[board] caminho por etapa (filtro fora do tradutor e acima do teto de pré-resolução)",
  );
}

/** Envolve uma consulta para medi-la (ver `loadBoardStagesRanked`). */
type MeasureQuery = <T>(fn: () => Promise<T>) => Promise<T>;
const runQuery: MeasureQuery = (fn) => fn();

/** Caminho novo do board (sort `position`/`createdAt`): 1 janela + 1 hidratação. */
async function loadBoardStagesRanked(
  stagesRaw: readonly BoardStageRaw[],
  whereSql: Prisma.Sql,
  sortField: BoardSortField | undefined,
  sortDirection: BoardSortDirection,
  perStage: number,
  offsetByStage: Record<string, number>,
  /** Saída opcional: total por etapa vindo da mesma janela (K3). */
  totalsOut?: Map<string, number>,
  /** Mede a consulta da janela (`search.apply` do Server-Timing, só com busca). */
  measure: MeasureQuery = runQuery,
): Promise<BoardStageWithDeals[]> {
  if (stagesRaw.length === 0) return [];
  const orgId = getOrgIdOrThrow();
  const limitByStage = boardLimitByStage(stagesRaw, perStage, offsetByStage);
  const rows = await measure(() =>
    prisma.$queryRaw<BoardRankedRow[]>(
      buildRankedBoardDealsSql({
        orgId,
        stageIds: stagesRaw.map((s) => s.id),
        whereSql,
        orderBy: boardRankOrderBySql(sortField, sortDirection),
        maxPerStage: Math.max(...limitByStage.values()),
      }),
    ),
  );
  collectRankedTotals(rows, totalsOut);
  return hydrateBoardStages(stagesRaw, groupRankedIdsByStage(rows, limitByStage));
}

/**
 * Caminho antigo do board (fallback quando o where não traduz para SQL):
 * um `findMany` por etapa, agora com no máximo
 * `BOARD_STAGE_FALLBACK_CONCURRENCY` em voo.
 */
async function loadBoardStagesPerStage(
  stagesRaw: readonly BoardStageRaw[],
  dealWhere: Prisma.DealWhereInput,
  dealOrderBy: Prisma.DealOrderByWithRelationInput[],
  perStage: number,
  offsetByStage: Record<string, number>,
): Promise<BoardStageWithDeals[]> {
  const dealsByStage = await mapWithConcurrency(
    stagesRaw,
    BOARD_STAGE_FALLBACK_CONCURRENCY,
    (stage) => {
      const extra = offsetByStage[stage.id] ?? 0;
      return prisma.deal.findMany({
        // AND explícito: o `stageId` da etapa não sobrescreve o `stageId`
        // que o filtro de etapa (ou a visibilidade de funil) pôs no where.
        where: { AND: [dealWhere, { stageId: stage.id }] },
        orderBy: dealOrderBy,
        take: perStage + extra,
        include: BOARD_DEAL_INCLUDE,
      });
    },
  );
  return stagesRaw.map((stage, i) => ({
    ...stage,
    deals: dealsByStage[i] ?? [],
  }));
}

/**
 * Caminho do board quando `sortField === "lastInteraction"`.
 *
 * Por que separado: o Prisma não suporta ordenar `Deal` por agregação
 * de uma relação distante (`Deal → Contact → Conversations`).
 *
 *   - Where traduzível → `buildLastInteractionRankedSql` (uma consulta) e
 *     hidratação dos ids paginados.
 *   - Fallback (where com relações/operadores não traduzidos): candidatos
 *     por etapa via findMany (concorrência limitada), UMA consulta da última
 *     mensagem por contato, ordena/pagina em memória.
 */
async function loadBoardStagesByLastInteraction(
  pipelineId: string,
  dealWhere: Prisma.DealWhereInput,
  perStage: number,
  offsetByStage: Record<string, number>,
  direction: BoardSortDirection,
  /**
   * Saída opcional: `last_at` de cada card ranqueado pelo SQL (insumo do
   * cursor da etapa). O fallback em memória não preenche — sem cursor,
   * o cliente pagina pelo `offsetByStage` antigo.
   */
  lastAtOut?: Map<string, Date | null>,
  /** Filtro de etapa: só as etapas escolhidas viram coluna (`stagesAllowedByFilter`). */
  advancedFilters?: AdvancedDealFilters,
  /** Resolvedor do where compartilhado com `computeBoardData` (totais). */
  whereResolver: BoardWhereResolver = createBoardWhereResolver(dealWhere).resolve,
  /**
   * Saída opcional: total por etapa vindo da janela (K3). Só é preenchido no
   * caminho em SQL; no fallback por etapa fica vazio e quem chama conta.
   */
  totals?: { fromSql: boolean; byStage: Map<string, number> },
  /** Mede a consulta da janela (`search.apply` do Server-Timing, só com busca). */
  measure: MeasureQuery = runQuery,
): Promise<BoardStageWithDeals[]> {
  const orgId = getOrgIdOrThrow();
  const stagesRaw = stagesAllowedByFilter(
    await prisma.stage.findMany({
      where: { pipelineId },
      orderBy: { position: "asc" },
    }),
    advancedFilters,
  );
  if (stagesRaw.length === 0) return [];
  const limitByStage = boardLimitByStage(stagesRaw, perStage, offsetByStage);
  const maxPerStage = Math.max(...limitByStage.values());

  // Where traduzido direto, ou ids pré-resolvidos. Só o traduzido direto
  // devolve `last_at` para o cursor: o "Carregar mais" por cursor
  // (`getBoardColumnPages`) só aceita where traduzível — com ids
  // pré-resolvidos o cliente segue pelo `offsetByStage`, como antes.
  const {
    sql: whereSql,
    direct,
    where: fallbackWhere,
  } = await whereResolver(stagesRaw.map((s) => s.id));
  if (whereSql) {
    const rows = await measure(() =>
      prisma.$queryRaw<BoardRankedRow[]>(
        buildLastInteractionRankedSql({
          orgId,
          stageIds: stagesRaw.map((s) => s.id),
          whereSql,
          direction,
          scanCap: Math.max(maxPerStage, LAST_INTERACTION_STAGE_SCAN_CAP),
          maxPerStage,
        }),
      ),
    );
    if (totals) {
      totals.fromSql = true;
      collectRankedTotals(rows, totals.byStage);
    }
    if (lastAtOut && direct) {
      for (const row of rows) {
        if (row.last_at === undefined) continue;
        lastAtOut.set(row.id, row.last_at === null ? null : new Date(row.last_at));
      }
    }
    return hydrateBoardStages(stagesRaw, groupRankedIdsByStage(rows, limitByStage));
  }

  logBoardPerStageFallback(pipelineId, "lastInteraction");
  return hydrateBoardStages(
    stagesRaw,
    await loadLastInteractionIdsPerStage(
      stagesRaw,
      fallbackWhere,
      limitByStage,
      direction,
    ),
  );
}

/** Fallback do `lastInteraction` (ver `loadBoardStagesByLastInteraction`). */
async function loadLastInteractionIdsPerStage(
  stagesRaw: readonly BoardStageRaw[],
  dealWhere: Prisma.DealWhereInput,
  limitByStage: Map<string, number>,
  direction: BoardSortDirection,
): Promise<Map<string, string[]>> {
  const orgId = getOrgIdOrThrow();

  // 1) Candidatos por etapa (mesmos filtros do board), os mais recentes
  //    primeiro. Indexado; não traz conversa nenhuma aqui.
  const candidatesByStage = await mapWithConcurrency(
    stagesRaw,
    BOARD_STAGE_FALLBACK_CONCURRENCY,
    (stage) => {
      const limit = limitByStage.get(stage.id) ?? 0;
      return prisma.deal.findMany({
        where: { AND: [dealWhere, { stageId: stage.id }] },
        select: { id: true, contactId: true, position: true },
        orderBy: { updatedAt: "desc" },
        take: Math.max(limit, LAST_INTERACTION_STAGE_SCAN_CAP),
      });
    },
  );

  // 2) UMA consulta para o board inteiro: última mensagem por contato
  //    (`contacts.lastMessageAt`; fallback em `conversations` só para quem
  //    está com a coluna NULL — mesma regra do caminho em SQL).
  const contactIds = [
    ...new Set(
      candidatesByStage
        .flat()
        .map((d) => d.contactId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const lastByContact = new Map<string, number>();
  if (contactIds.length > 0) {
    const grouped = await prisma.$queryRaw<
      { contactId: string; last_at: Date | null }[]
    >`
      SELECT ct.id AS "contactId", COALESCE(ct."lastMessageAt", fb.last_at) AS last_at
      FROM contacts ct
      LEFT JOIN LATERAL (
        SELECT MAX(COALESCE(cv."lastMessageAt", cv."updatedAt")) AS last_at
        FROM conversations cv
        WHERE ct."lastMessageAt" IS NULL
          AND cv."organizationId" = ${orgId}
          AND cv."contactId" = ct.id
      ) fb ON TRUE
      WHERE ct."organizationId" = ${orgId}
        AND ct.id = ANY(${contactIds})
        AND COALESCE(ct."lastMessageAt", fb.last_at) IS NOT NULL
    `;
    for (const g of grouped) {
      if (g.contactId && g.last_at) {
        lastByContact.set(g.contactId, new Date(g.last_at).getTime());
      }
    }
  }

  // 3) Ordena/pagina cada etapa em memória: last_at (dir, NULLS LAST) e
  //    desempate estável por position.
  const dirMul = direction === "desc" ? -1 : 1;
  const paginatedIdsByStage = new Map<string, string[]>();
  stagesRaw.forEach((stage, i) => {
    const limit = limitByStage.get(stage.id) ?? 0;
    const sorted = [...(candidatesByStage[i] ?? [])].sort((a, b) => {
      const la = a.contactId ? lastByContact.get(a.contactId) : undefined;
      const lb = b.contactId ? lastByContact.get(b.contactId) : undefined;
      if (la != null && lb != null && la !== lb) return (la - lb) * dirMul;
      if (la != null && lb == null) return -1; // NULLS LAST
      if (la == null && lb != null) return 1;
      return a.position - b.position;
    });
    paginatedIdsByStage.set(
      stage.id,
      sorted.slice(0, limit).map((d) => d.id),
    );
  });
  return paginatedIdsByStage;
}

export type BoardLimitOptions = {
  /**
   * Quantos cards retornar por coluna: padrão `BOARD_DEFAULT_PER_STAGE` (50),
   * teto `BOARD_MAX_PER_STAGE` (200). As rotas aceitam `perStage` ou `limit`.
   */
  perStage?: number;
  /** Offset por etapa: stageId -> quantos pular. Permite "Carregar mais". */
  offsetByStage?: Record<string, number>;
  /** Campo de ordenação dentro de cada coluna. Default: `position`. */
  sortField?: BoardSortField;
  /** Direção da ordenação. Default: `asc`. */
  sortDirection?: BoardSortDirection;
};

/**
 * Resolve TODOS os IDs de deals que batem nos mesmos critérios do board
 * (status + visibilidade + filtros avançados), opcionalmente escopados a uma
 * única etapa. Usado pela edição em massa "selecionar todos" — diferente do
 * `getBoardData`, não há limite por coluna; varre o pipeline inteiro até `cap`.
 *
 * Reaproveita exatamente `buildDealWhereFromFilters` (mesma engine do POST do
 * board), garantindo que "todos os que batem no filtro" = o que o usuário vê.
 *
 * `cap` protege contra operações gigantes (default e teto = 5000, igual ao
 * limite de `dealIds` aceito pela rota de bulk). `capped=true` sinaliza que
 * havia mais que `cap` — o caller decide avisar o usuário.
 */
export async function resolveBoardDealIds(
  pipelineId: string,
  opts: {
    visibilityOwnerId?: string | null;
    statusFilter?: DealStatus | "ALL";
    filters?: AdvancedDealFilters;
    stageId?: string;
    cap?: number;
    extraWhere?: Prisma.DealWhereInput | null;
  } = {},
): Promise<{ ids: string[]; capped: boolean }> {
  const cap = Math.max(1, Math.min(opts.cap ?? 5000, 5000));
  const conditions: Prisma.DealWhereInput[] = [];

  if (opts.statusFilter && opts.statusFilter !== "ALL") {
    conditions.push({ status: opts.statusFilter });
  } else if (!opts.statusFilter) {
    conditions.push({ status: "OPEN" });
  }
  if (opts.visibilityOwnerId) {
    conditions.push({ ownerId: opts.visibilityOwnerId });
  }
  if (opts.filters && Object.keys(opts.filters).length > 0) {
    const advConditions = await buildDealWhereFromFilters(opts.filters);
    for (const c of advConditions) conditions.push(c);
  }
  if (opts.extraWhere && Object.keys(opts.extraWhere).length > 0) {
    conditions.push(opts.extraWhere);
  }
  // Escopo: etapa específica ou pipeline inteiro (via relação stage.pipelineId).
  if (opts.stageId) {
    conditions.push({ stageId: opts.stageId, stage: { is: { pipelineId } } });
  } else {
    conditions.push({ stage: { is: { pipelineId } } });
  }

  const where: Prisma.DealWhereInput =
    conditions.length === 1 ? conditions[0] : { AND: conditions };

  const rows = await prisma.deal.findMany({
    where,
    select: { id: true },
    take: cap + 1,
    orderBy: { position: "asc" },
  });
  const capped = rows.length > cap;
  return { ids: rows.slice(0, cap).map((r) => r.id), capped };
}

/**
 * Board com cache-aside de TTL curto (coalescing).
 *
 * `computeBoardData` (abaixo) é a query mais cara do app. Sob rajada de
 * cargas idênticas (mesmo usuário/funil recarregando via invalidações do
 * react-query enquanto webhooks criam deals), o `cache.wrap` + stampede
 * lock colapsam N execuções de ~13s numa só por `variant` a cada
 * `BOARD_CACHE_TTL_SEC`. Staleness ≤ TTL; `moveDeal` invalida
 * explicitamente pra que a ação manual do operador não sofra flicker.
 *
 * O payload cacheado é serializado em JSON (Datas → ISO), exatamente o
 * mesmo shape que o handler já emite via `NextResponse.json`.
 */
export async function getBoardData(
  pipelineId: string,
  /**
   * Filtro de visibilidade (preferido). Aceita também o legado
   * `visibilityOwnerId: string` — convertido para `{ ownerId }`.
   */
  visibilityWhere?: Prisma.DealWhereInput | string | null,
  statusFilter?: DealStatus | "ALL",
  advancedFilters?: AdvancedDealFilters,
  limitOptions?: BoardLimitOptions,
) {
  const orgId = getOrgIdOrThrow();
  const normalizedWhere =
    typeof visibilityWhere === "string"
      ? { ownerId: visibilityWhere }
      : visibilityWhere ?? null;
  const variant = canonicalBoardVariant({
    pipelineId,
    visibilityWhere: normalizedWhere,
    statusFilter,
    advancedFilters,
    limitOptions,
  });
  return cache.wrap(
    await boardDataKey(orgId, pipelineId, variant),
    BOARD_CACHE_TTL_SEC,
    () =>
      computeBoardData(
        pipelineId,
        normalizedWhere,
        statusFilter,
        advancedFilters,
        limitOptions,
      ),
  );
}

/**
 * Board já serializado (JSON), para a rota devolver como está — B3 / P-4.
 *
 * - Acerto: o texto sai do Redis (gunzip no threadpool) direto para a
 *   resposta. Antes: gunzip + `JSON.parse` do board inteiro + filtro de
 *   etapas + `JSON.stringify` de novo na rota.
 * - Erro: `computeBoardData`, filtro de etapas do papel e UM
 *   `JSON.stringify`; o mesmo texto vai para o Redis e para a resposta.
 *   Antes eram dois (o `set` do cache e o `NextResponse.json`).
 *
 * A variante é canônica (`board-cache-variant.ts`) e inclui `stageScope`,
 * porque o filtro `canViewStage` agora roda antes de guardar. Chave
 * própria (`…:json`): o fallback em memória guarda texto, não objeto.
 */
export async function getBoardJson(
  pipelineId: string,
  visibilityWhere: Prisma.DealWhereInput | null | undefined,
  statusFilter: DealStatus | "ALL" | undefined,
  advancedFilters: AdvancedDealFilters | undefined,
  limitOptions: BoardLimitOptions | undefined,
  opts: {
    /** Etapas que o papel do usuário vê (`canViewStage`). */
    stageVisible?: (stageId: string) => boolean;
    /** Texto estável do recorte acima (`boardStageScope`) — entra na chave. */
    stageScope?: string;
    timing?: ServerTiming;
  } = {},
): Promise<{ json: string; source: TextCacheSource }> {
  const orgId = getOrgIdOrThrow();
  const timing = opts.timing;
  const t0 = performance.now();
  const variant = canonicalBoardVariant({
    pipelineId,
    visibilityWhere: visibilityWhere ?? null,
    statusFilter,
    advancedFilters,
    limitOptions,
    stageScope: opts.stageScope ?? null,
  });
  const key = `${await boardDataKey(orgId, pipelineId, variant)}:json`;
  let loaderMs = 0;
  const { text, source } = await cache.wrapText(key, BOARD_CACHE_TTL_SEC, async () => {
    const l0 = performance.now();
    try {
      const board = await computeBoardData(
        pipelineId,
        visibilityWhere ?? null,
        statusFilter,
        advancedFilters,
        limitOptions,
        timing,
      );
      const visible = opts.stageVisible
        ? board.filter((s) => opts.stageVisible!(s.id))
        : board;
      return timing
        ? timing.timeSync("ser", () => JSON.stringify(visible))
        : JSON.stringify(visible);
    } finally {
      loaderMs = performance.now() - l0;
    }
  });
  // `cache` = chave (versões no Redis) + GET + lock + gzip/SET, sem o loader.
  timing?.add("cache", performance.now() - t0 - loaderMs, source);
  return { json: text, source };
}

/**
 * `where` dos cards do board: status (padrão `OPEN`), visibilidade do
 * usuário e filtros avançados, sempre em AND. O board inteiro e o
 * “Carregar mais” por cursor usam ESTE where — a visibilidade não tem como
 * divergir entre a 1ª carga e as páginas seguintes.
 */
async function buildBoardDealWhere(
  visibilityWhere: Prisma.DealWhereInput | null | undefined,
  statusFilter: DealStatus | "ALL" | undefined,
  advancedFilters: AdvancedDealFilters | undefined,
  timing?: ServerTiming,
): Promise<{
  /** Where sem a busca livre (ela entra em SQL, ver `createBoardWhereResolver`). */
  where: Prisma.DealWhereInput;
  search: DealSearch | null;
}> {
  const conditions: Prisma.DealWhereInput[] = [];

  if (statusFilter && statusFilter !== "ALL") {
    conditions.push({ status: statusFilter });
  } else if (!statusFilter) {
    conditions.push({ status: "OPEN" });
  }
  if (visibilityWhere && Object.keys(visibilityWhere).length > 0) {
    conditions.push(visibilityWhere);
  }

  let search: DealSearch | null = null;
  if (advancedFilters && Object.keys(advancedFilters).length > 0) {
    // A busca livre sai do where Prisma: vira predicado SQL dentro da consulta
    // do board (sem pré-consultas nem lista de ids). Os demais filtros e a
    // visibilidade seguem no where, sempre em AND com ela.
    const { search: searchTerm, ...rest } = advancedFilters;
    if (searchTerm?.trim()) search = createDealSearch(searchTerm, { timing });
    // pipelineId/statuses no advancedFilters não substituem visibilidade —
    // ficam como condições adicionais (AND).
    const advConditions = await buildDealWhereFromFilters(rest);
    for (const c of advConditions) conditions.push(c);
  }

  const where: Prisma.DealWhereInput =
    conditions.length === 0
      ? {}
      : conditions.length === 1
        ? (conditions[0] as Prisma.DealWhereInput)
        : { AND: conditions };
  return { where, search };
}

async function computeBoardData(
  pipelineId: string,
  visibilityWhere?: Prisma.DealWhereInput | null,
  statusFilter?: DealStatus | "ALL",
  advancedFilters?: AdvancedDealFilters,
  limitOptions?: BoardLimitOptions,
  /** Tempos por fase (`Server-Timing` da rota). */
  timing?: ServerTiming,
) {
  const now = new Date();
  const phase = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    timing ? timing.time(name, fn) : fn();

  const { where: dealWhere, search } = await phase("filters", () =>
    buildBoardDealWhere(visibilityWhere, statusFilter, advancedFilters, timing),
  );
  // Consulta final com a busca dentro: `search.apply` (Server-Timing).
  const measureSearch: MeasureQuery = <T,>(fn: () => Promise<T>): Promise<T> =>
    search && timing ? timing.time("search.apply", fn) : fn();

  const perStage = normalizeBoardPerStage(limitOptions?.perStage);
  const offsetByStage = normalizeBoardOffsets(limitOptions?.offsetByStage);
  const sortField = limitOptions?.sortField;
  const sortDirection: BoardSortDirection =
    limitOptions?.sortDirection === "desc" ? "desc" : "asc";
  const cursorSort = normalizeBoardCursorSort(sortField, sortDirection);
  // `lastInteraction`: a chave de ordenação (`last_at`) só existe no SQL;
  // o caminho ranqueado devolve por card para montar o cursor da etapa.
  const lastAtByDealId = new Map<string, Date | null>();
  // Construído uma vez e reusado nas 2 queries de deals (stages.deals
  // + branch de "Carregar mais"). Default cai em `position asc` =
  // comportamento histórico.
  const dealOrderBy = buildBoardDealOrderBy(sortField, sortDirection);

  // ⚡ [jul/26] Métricas de etapa dependem SÓ do pipelineId (não das
  // colunas/cards). Disparamos aqui, ANTES do findMany de stages, pra que
  // rodem em paralelo com a query mais pesada do board. Já é cache-aside
  // (TTL 60s), então normalmente resolve "de graça"; aguardamos no
  // Promise.all lá embaixo. Não usar `await` aqui — a promise fica em voo.
  const metricsPromise = getStageMetrics(pipelineId);

  // Contagem por etapa (K3): sai da MESMA janela que ranqueia os cards
  // (`COUNT(*) OVER (PARTITION BY "stageId")`), com o mesmo where — direto
  // em SQL ou sobre os ids pré-resolvidos. Antes era um `groupBy` do Prisma à
  // parte, com `stage.pipelineId` no where (2–3 LEFT JOIN repetidos em
  // `stages`; ~61 mil chamadas de 30–77 ms em produção, 05/10).
  //
  // O `groupBy` só sobrevive no caminho por etapa (where que nem traduz nem
  // cabe no teto da pré-resolução), onde não existe janela.
  const whereResolver = createBoardWhereResolver(dealWhere, search);
  type TotalsRow = { stageId: string; _count: { _all: number } };
  const groupByTotals = (): Promise<TotalsRow[]> =>
    prisma.deal.groupBy({
      by: ["stageId"],
      // `fullWhere`: com busca, já traz os ids resolvidos pelo caminho por etapa.
      where: { ...whereResolver.fullWhere(), stage: { pipelineId } },
      _count: { _all: true },
    });
  const sqlTotals = { fromSql: false, byStage: new Map<string, number>() };
  const resolveTotals = async (): Promise<TotalsRow[]> => {
    if (!sqlTotals.fromSql) return groupByTotals();
    return [...sqlTotals.byStage].map(([stageId, n]) => ({ stageId, _count: { _all: n } }));
  };

  let stages: BoardStageWithDeals[];

  if (sortField === "lastInteraction") {
    // Caminho dedicado: ordena pela última mensagem do contato
    // (`contacts.lastMessageAt`). Já aplica `offsetByStage` internamente (não cai no
    // branch de "Carregar mais" abaixo).
    stages = await phase("cards", () =>
      loadBoardStagesByLastInteraction(
        pipelineId,
        dealWhere,
        perStage,
        offsetByStage,
        sortDirection,
        lastAtByDealId,
        advancedFilters,
        whereResolver.resolve,
        sqlTotals,
        measureSearch,
      ),
    );
  } else {
    // 1) Etapas leves; 2) cards de TODAS as colunas numa consulta só
    // (`ROW_NUMBER() OVER (PARTITION BY "stageId" ORDER BY …)`) e uma
    // hidratação por `id IN`. Antes: um `findMany` com include por etapa em
    // `Promise.all` — N etapas + totais + métricas + enriquecimentos
    // chegavam a ~18 das 20 conexões do pool numa carga só.
    //
    // Tags e contato (origem, UTM, telefone/e-mail) viram EXISTS no SQL.
    // O resto que o tradutor não cobre (conversa, janela 24 h, campos
    // personalizados, busca) é resolvido em ids numa consulta só
    // (`preResolveBoardWhereSql`); o caminho por etapa (4 consultas em voo)
    // fica só para mais de 20 mil negócios casando.
    //
    // Com filtro de etapa, só as etapas escolhidas viram coluna.
    const stagesRaw = stagesAllowedByFilter(
      await phase("stages", () =>
        prisma.stage.findMany({
          where: { pipelineId },
          orderBy: { position: "asc" },
        }),
      ),
      advancedFilters,
    );
    stages = await phase("cards", async () => {
      const { sql: whereSql, where: fallbackWhere } = await whereResolver.resolve(
        stagesRaw.map((s) => s.id),
      );
      if (whereSql) sqlTotals.fromSql = true;
      else logBoardPerStageFallback(pipelineId, sortField);
      return whereSql
        ? loadBoardStagesRanked(
            stagesRaw,
            whereSql,
            sortField,
            sortDirection,
            perStage,
            offsetByStage,
            sqlTotals.byStage,
            measureSearch,
          )
        : loadBoardStagesPerStage(
            stagesRaw,
            fallbackWhere,
            dealOrderBy,
            perStage,
            offsetByStage,
          );
    });
  }

  // ⚡ [jul/26] Antes estas etapas eram AWAITADAS em série (totais →
  // produtos → última mensagem → métricas → avatares): a latência do board
  // virava a SOMA de ~5 round-trips ao Postgres. São independentes entre
  // si, então rodam em paralelo — `loadBoardCardEnrichment` dispara as
  // consultas dos cards no mesmo tick; `metricsPromise` já voa desde antes
  // do findMany de stages. Os totais já vieram com os cards (K3).
  const [totalsGroups, metrics, enrichCard] = await phase("enrich", () =>
    Promise.all([resolveTotals(), metricsPromise, loadBoardCardEnrichment(stages, now)]),
  );
  const buildStart = performance.now();

  const totalsByStage = new Map<string, number>();
  for (const g of totalsGroups) totalsByStage.set(g.stageId, g._count._all);

  const metricsMap = new Map(metrics.map((m) => [m.stageId, m]));

  // Stage `isIncoming` (Leads de entrada) é a fase de captura e DEVE
  // ficar sempre visível. Antes filtrávamos por `stage.deals.length > 0`,
  // mas esse array é a slice PÓS-filtro (status=OPEN padrão, visibility,
  // filtros avançados). Qualquer filtro ativo escondia a coluna inteira
  // mesmo havendo leads no banco — bug reportado: "existem leads em
  // leads de entrada, mas a fase do funil não aparece".
  const built = stages
    .map((stage) => {
      const metric = metricsMap.get(stage.id);
      // Janela em SQL: etapa sem linha = nenhum negócio casando (total 0).
      const totalCount =
        totalsByStage.get(stage.id) ?? (sqlTotals.fromSql ? 0 : stage.deals.length);
      // `extra` agora representa "quantos cards adicionais foram pedidos".
      // O total carregado é o tamanho real do array.
      const loadedCount = stage.deals.length;
      const hasMore = loadedCount < totalCount;
      // Cursor depois do último card carregado: o “Carregar mais” pede só os
      // próximos N desta etapa (`getBoardColumnPages`). `null` = nada a
      // carregar, ou ordenação sem cursor neste caminho (cliente usa o
      // `offsetByStage` antigo).
      const lastDeal = stage.deals[stage.deals.length - 1];
      const nextCursor =
        hasMore && lastDeal
          ? boardCursorAfterDeal(cursorSort.sort, cursorSort.direction, lastDeal, lastAtByDealId)
          : null;
      return {
        ...stage,
        conversionRate: metric?.conversionRate ?? 0,
        avgDaysInStage: metric?.avgDaysInStage ?? 0,
        totalCount,
        loadedCount,
        hasMore,
        nextCursor,
        deals: stage.deals.map((deal) => enrichCard(stage, deal)),
      };
    });
  timing?.add("build", performance.now() - buildStart);
  return built;
}

/**
 * Não lidas, canal e prévia de mensagens dos contatos do board numa consulta
 * (ver o comentário em `loadBoardCardEnrichment`). Só valores como
 * parâmetro; o recorte de mensagem de chat é o de
 * `lib/conversation-last-message.ts`.
 */
export function buildBoardCardPreviewSql(args: {
  orgId: string;
  contactIds: readonly string[];
  awaitingCap: number;
}): Prisma.Sql {
  const lastOf = (direction: "in" | "out", limit: Prisma.Sql) => Prisma.sql`
          (SELECT m.id, m."externalId", m.content, m."createdAt", m.direction,
                  m."sendStatus", m."sendError"
           FROM messages m
           WHERE m."conversationId" = conv.id
             AND m."organizationId" = ${args.orgId}
             AND m.direction = ${direction}
             AND m."isPrivate" = false
             AND m."messageType" NOT IN (${Prisma.join([...NON_CHAT_MESSAGE_TYPES])})
             AND m."messageType" NOT LIKE 'event%'
           -- Desempate no mesmo segundo (timestamp do WhatsApp em s).
           ORDER BY m."createdAt" DESC, m.id DESC
           LIMIT ${limit})`;
  const inLimit = Prisma.sql`CASE WHEN pc.unread > 0 THEN ${args.awaitingCap}::int ELSE 1 END`;
  return Prisma.sql`
    WITH conv AS (
      SELECT c.id, c."contactId", c.channel, c."unreadCount", c."updatedAt"
      FROM conversations c
      WHERE c."contactId" = ANY(${[...args.contactIds]})
        AND c."organizationId" = ${args.orgId}
    ),
    per_contact AS (
      SELECT
        "contactId",
        COALESCE(SUM("unreadCount"), 0)::int AS unread,
        (ARRAY_AGG(channel ORDER BY "updatedAt" DESC))[1] AS channel
      FROM conv
      GROUP BY "contactId"
    ),
    picked AS (
      SELECT conv."contactId", lm.*
      FROM conv
      INNER JOIN per_contact pc ON pc."contactId" = conv."contactId"
      CROSS JOIN LATERAL (
        ${lastOf("in", inLimit)}
        UNION ALL
        ${lastOf("out", Prisma.sql`1`)}
      ) lm
    ),
    ranked AS (
      SELECT
        p.*,
        ROW_NUMBER() OVER (
          PARTITION BY p."contactId", p.direction
          ORDER BY p."createdAt" DESC, p.id DESC
        )::int AS rn
      FROM picked p
    )
    SELECT
      pc."contactId",
      pc.channel,
      pc.unread AS "unreadCount",
      r.id AS "msgId",
      r."externalId" AS "msgExternalId",
      r.content AS "msgContent",
      r."createdAt" AS "msgCreatedAt",
      r.direction AS "msgDirection",
      r."sendStatus" AS "msgSendStatus",
      r."sendError" AS "msgSendError",
      r.rn
    FROM per_contact pc
    LEFT JOIN ranked r
      ON r."contactId" = pc."contactId"
     AND r.rn <= CASE
           WHEN r.direction = 'in' AND pc.unread > 0 THEN ${args.awaitingCap}::int
           ELSE 1
         END
    ORDER BY pc."contactId", r.rn
  `;
}

/**
 * Enriquecimento dos cards do board: produto, última mensagem (qualquer
 * lado e do cliente), não lidas, canal, prévia “N aguardando” e avatar.
 *
 * Recebe as etapas JÁ paginadas (só os cards que vão sair) e devolve a
 * função que monta o card final. Usado pelo board inteiro
 * (`computeBoardData`) e pelo “Carregar mais” por cursor
 * (`getBoardColumnPages`) — o card tem o mesmo formato nos dois.
 *
 * As 2 consultas (produtos e prévia) + avatar saem juntas (`Promise.all`); as promessas são
 * criadas antes do primeiro `await`, então quem chama pode pôr esta função
 * num `Promise.all` com outras consultas sem serializar nada.
 */
async function loadBoardCardEnrichment(
  stages: readonly BoardStageWithDeals[],
  now: Date,
) {
  // IDs/contatos derivados das colunas já carregadas — insumo das
  // consultas de enriquecimento abaixo.
  const allDealIds = stages.flatMap((s) => s.deals.map((d) => d.id));
  const allContactIds = [
    ...new Set(
      stages
        .flatMap((s) => s.deals)
        .map((d) => d.contactId)
        .filter((id): id is string => !!id),
    ),
  ];
  // Preview "N aguardando" só faz sentido em etapas abertas — Ganho/Perdido
  // não mostram o footer de inbound. Excluir esses contactIds do SQL pesado
  // de awaitingMsgs (ROW_NUMBER em messages) quando status=ALL.
  const openStageContactIds = [
    ...new Set(
      stages
        .filter((s) => !s.isWon && !s.isLost)
        .flatMap((s) => s.deals)
        .map((d) => d.contactId)
        .filter((id): id is string => !!id),
    ),
  ];
  const allContacts = stages
    .flatMap((s) => s.deals)
    .map((d) => d.contact)
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // ⚡ [jul/26] Antes estas etapas eram AWAITADAS em série (totais →
  // produtos → última mensagem → métricas → avatares): a latência do board
  // virava a SOMA de ~5 round-trips ao Postgres. São todas independentes
  // entre si (só dependem de stages/IDs já resolvidos, ou apenas do
  // pipelineId), então rodam em paralelo com Promise.all — a latência passa
  // a ser ~o MAIOR round-trip, não a soma. Semanticamente idêntico: são
  // leituras sem efeito colateral entre si. `metricsPromise`/`totalsPromise`
  // já voam desde antes do findMany de stages.
  const orgIdForBoard = getOrgIdOrThrow();

  // Nome/tipo do produto por deal.
  const productsPromise: Promise<{ dealId: string; name: string; type: string }[]> =
    allDealIds.length > 0
      ? prisma.$queryRaw<{ dealId: string; name: string; type: string }[]>`
          SELECT dp."dealId", p.name, p.type
          FROM deal_products dp
          INNER JOIN products p ON p.id = dp."productId"
          WHERE dp."dealId" = ANY(${allDealIds})
            AND dp."organizationId" = ${orgIdForBoard}
            AND p."organizationId" = ${orgIdForBoard}
          ORDER BY dp."createdAt" ASC
        `
      : Promise.resolve([]);

  // Não lidas + canal + prévia de mensagens por contato — UMA consulta (K2).
  // Obs.: o "responsável" do contato e do chat são derivados de
  // `Deal.owner` via regra de herança (ver `propagateOwnerToContactAndChat`),
  // então não precisamos carregá-los separadamente aqui.
  //
  // Antes eram duas: `contact_unread`/`latest_channel` em `conversations` e
  // uma janela `ROW_NUMBER() OVER (PARTITION BY contato, direção)` sobre
  // TODAS as mensagens de todos os contatos do board — o Postgres lia e
  // ordenava o histórico inteiro para ficar com até 6 linhas por contato
  // (produção, 05/10: 31.833 + 29.017 chamadas, 19,4 M linhas).
  //
  // Agora, por conversa do contato, um LATERAL busca pelo índice
  // `messages("conversationId", "createdAt")` de trás para a frente e para
  // em poucas linhas: as últimas do cliente (até AWAITING_PREVIEW_CAP quando
  // o contato tem não lidas; 1 quando não tem) e a última nossa. A janela
  // final ranqueia só essas linhas. Semântica: unread = soma; canal = conversa
  // de `updatedAt` mais recente; `rn = 1` de cada direção disputa a última
  // mensagem do contato; `rn <= cap` de `in` alimenta o "N aguardando".
  //
  // Preview do card = última msg real de chat (cliente/agente). Exclui nota
  // interna, rascunho IA e eventos de call — senão o kanban/Flow mostra
  // "Lead/Conversa distribuída…" no lugar do Oi. `NOT LIKE 'event%'` vale
  // para as duas direções: mensagens de evento nascem com `direction: "out"`
  // (`conversation-events.ts`).
  //
  // Única diferença visível: contato SEM não lidas cuja última mensagem do
  // cliente é só espaços em branco não mostra mais a anterior no "aguardando"
  // (antes vinham sempre 5 do cliente; agora 1 quando não há não lidas).
  /**
   * Uma linha por (contato, direção, posição); contato com conversa mas sem
   * mensagem de chat devolve uma linha só com `unreadCount`/`channel`.
   */
  type BoardPreviewRow = {
    contactId: string;
    channel: string | null;
    unreadCount: number;
    msgId: string | null;
    msgExternalId: string | null;
    msgContent: string | null;
    msgCreatedAt: Date | null;
    msgDirection: string | null;
    msgSendStatus: string | null;
    msgSendError: string | null;
    rn: number | null;
  };
  type BoardMsgRow = BoardPreviewRow & { msgId: string; msgCreatedAt: Date; msgDirection: string };
  const AWAITING_PREVIEW_CAP = 5;
  const previewPromise: Promise<BoardPreviewRow[]> =
    allContactIds.length > 0
      ? prisma.$queryRaw<BoardPreviewRow[]>(
          buildBoardCardPreviewSql({
            orgId: orgIdForBoard,
            contactIds: allContactIds,
            awaitingCap: AWAITING_PREVIEW_CAP,
          }),
        )
      : Promise.resolve([]);

  const [dealProducts, previewRows] = await Promise.all([
    productsPromise,
    previewPromise,
    // Enriquecimento de avatar (fallback PURAMENTE VISUAL — foto do User
    // homônimo quando o Contact não tem avatarUrl). Independe das demais;
    // roda no mesmo lote. Muta `allContacts` em memória e resolve void.
    enrichContactsWithUserAvatarFallback(allContacts),
  ]);

  const productMap = new Map<string, string>();
  const productTypeMap = new Map<string, string>();
  for (const dp of dealProducts) {
    if (!productMap.has(dp.dealId)) {
      productMap.set(dp.dealId, dp.name);
      productTypeMap.set(dp.dealId, dp.type);
    }
  }

  const lastMsgMap = new Map<
    string,
    {
      id: string;
      externalId: string | null;
      content: string;
      createdAt: Date;
      direction: string;
      sendStatus: string | null;
      sendError: string | null;
    }
  >();
  const lastInMap = new Map<string, { content: string; createdAt: Date }>();
  const unreadMap = new Map<string, number>();
  const channelMap = new Map<string, { channel: string; updatedAt: Date }>();
  const msgRows: BoardMsgRow[] = [];
  for (const row of previewRows) {
    if (!row.contactId) continue;
    if (!unreadMap.has(row.contactId)) {
      unreadMap.set(row.contactId, row.unreadCount ?? 0);
      if (row.channel) {
        channelMap.set(row.contactId, {
          channel: row.channel,
          updatedAt: new Date(0),
        });
      }
    }
    if (row.msgId != null && row.msgCreatedAt != null && row.msgDirection != null) {
      msgRows.push(row as BoardMsgRow);
    }
  }

  // contactId → inbound mais recentes (rn=1 = mais nova). Cortamos por
  // unreadCount no map do deal (footer "N aguardando"). Só etapas abertas:
  // Ganho/Perdido não mostram o footer de inbound.
  const awaitingByContact = new Map<
    string,
    Array<{ content: string; createdAt: Date }>
  >();
  const openStageContactSet = new Set(openStageContactIds);
  // Linhas chegam ordenadas por (contactId, rn); rn=1 de cada direção
  // disputa a última mensagem — a mais nova por (createdAt, id) vence,
  // igual ao `DISTINCT ON … ORDER BY createdAt DESC, id DESC` antigo.
  const newestByContact = new Map<string, BoardMsgRow>();
  for (const row of msgRows) {
    const isIn = row.msgDirection === "in";
    if (row.rn === 1) {
      const current = newestByContact.get(row.contactId);
      const rowTime = new Date(row.msgCreatedAt).getTime();
      const currentTime = current
        ? new Date(current.msgCreatedAt).getTime()
        : -Infinity;
      if (
        !current ||
        rowTime > currentTime ||
        (rowTime === currentTime && row.msgId > current.msgId)
      ) {
        newestByContact.set(row.contactId, row);
      }
      if (isIn && row.msgContent != null) {
        lastInMap.set(row.contactId, {
          content: row.msgContent,
          createdAt: row.msgCreatedAt,
        });
      }
    }
    if (
      isIn &&
      openStageContactSet.has(row.contactId) &&
      row.msgContent?.trim()
    ) {
      const list = awaitingByContact.get(row.contactId) ?? [];
      list.push({ content: row.msgContent, createdAt: row.msgCreatedAt });
      awaitingByContact.set(row.contactId, list);
    }
  }
  // Mesma regra do `last_msg` antigo: a vencedora é a mais nova de qualquer
  // lado; sem `content` (mídia) o card fica sem `lastMessage` — não cai na
  // mais nova da outra direção.
  for (const [contactId, row] of newestByContact) {
    if (row.msgContent == null) continue;
    lastMsgMap.set(contactId, {
      id: row.msgId,
      externalId: row.msgExternalId ?? null,
      content: row.msgContent,
      createdAt: row.msgCreatedAt,
      direction: row.msgDirection ?? "in",
      sendStatus: row.msgSendStatus ?? null,
      sendError: row.msgSendError ?? null,
    });
  }

  return (
    stage: Pick<BoardStageRaw, "rottingDays">,
    deal: BoardStageWithDeals["deals"][number],
  ) => {
    const threshold = addDays(deal.updatedAt, stage.rottingDays);
    const isRotting = now.getTime() > threshold.getTime();
    const lastMsg = deal.contactId ? lastMsgMap.get(deal.contactId) : undefined;
    const unread = deal.contactId
      ? (unreadMap.get(deal.contactId) ?? 0)
      : 0;
    const awaitingRaw = deal.contactId
      ? (awaitingByContact.get(deal.contactId) ?? [])
      : [];
    // Mais antigas → mais novas no tooltip (leitura cronológica).
    // Quantidade = min(unread, cap); se unread=0 mas última é inbound,
    // mantém só a última no preview (comportamento antigo).
    const awaitingTake =
      unread > 0
        ? Math.min(unread, AWAITING_PREVIEW_CAP)
        : lastMsg?.direction === "in"
          ? 1
          : 0;
    const awaitingMessages =
      awaitingTake > 0
        ? awaitingRaw
            .slice(0, awaitingTake)
            .slice()
            .reverse()
            .map((m) => ({
              content: m.content,
              createdAt: m.createdAt,
            }))
        : [];
    const tags = deal.tags?.map((t: { tag: { id: string; name: string; color: string } }) => t.tag) ?? [];
    const pendingActivities = deal.activities?.length ?? 0;
    const hasOverdueActivity = deal.activities?.some(
      (a) => a.scheduledAt && new Date(a.scheduledAt).getTime() < now.getTime()
    ) ?? false;
    return {
      ...deal,
      activities: undefined,
      isRotting,
      productName: productMap.get(deal.id) ?? null,
      productType: (productTypeMap.get(deal.id) as "PRODUCT" | "SERVICE") ?? null,
      tags,
      pendingActivities,
      hasOverdueActivity,
      unreadCount: unread,
      lastMessage: lastMsg
        ? {
            id: lastMsg.id,
            externalId: lastMsg.externalId,
            content: lastMsg.content,
            createdAt: lastMsg.createdAt,
            direction: lastMsg.direction,
            sendStatus: lastMsg.sendStatus,
            sendError: lastMsg.sendError,
          }
        : null,
      awaitingMessages,
      lastInboundMessage: deal.contactId
        ? lastInMap.get(deal.contactId) ?? null
        : null,
      channel: deal.contactId
        ? channelMap.get(deal.contactId)?.channel ?? null
        : null,
    };
  };
}

// ---------------------------------------------------------------------------
// "Carregar mais" de uma coluna por cursor (keyset) — P-14 / BD-17.
//
// Antes: cada clique refazia o board INTEIRO com `perStage + extra` na
// coluna expandida (`offsetByStage`) e, como o offset entra na variante do
// cache, criava uma chave nova por clique. Agora o cliente manda o
// `nextCursor` da etapa e recebe só os próximos N cards dela — sem cache
// (nada de chave por página) e com o MESMO where do board
// (`buildBoardDealWhere`). O `offsetByStage` continua aceito no POST /board
// para clientes antigos. Semântica e formato: `board-column-cursor.ts`.
// ---------------------------------------------------------------------------

/** Cards por página do "Carregar mais" quando o cliente não informa. */
const DEFAULT_BOARD_COLUMN_PAGE = 20;
/** Etapas por requisição (um funil tem dezenas de etapas, não centenas). */
const MAX_BOARD_COLUMNS_PER_REQUEST = 60;

export type BoardColumnPageErrorCode =
  | "invalid_request"
  | "invalid_cursor"
  | "cursor_unsupported";

/** Erro do cliente na paginação por cursor — a rota responde 400 com `code`. */
export class BoardColumnPageError extends Error {
  constructor(
    readonly code: BoardColumnPageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardColumnPageError";
  }
}

export type BoardColumnPageRequest = {
  stageId: string;
  /** `nextCursor` da etapa (do board ou da página anterior). */
  cursor: string;
  /** Quantos cards devolver (padrão 20, teto `MAX_BOARD_COLUMN_LIMIT`). */
  limit?: number;
};

function boardCursorAfterDeal(
  sort: BoardCursorSort,
  direction: BoardCursorDirection,
  deal: { id: string; position: number; createdAt: Date },
  lastAtByDealId: ReadonlyMap<string, Date | null>,
): string | null {
  if (sort === "lastInteraction") {
    // Sem o `last_at` do SQL não há chave completa → sem cursor.
    if (!lastAtByDealId.has(deal.id)) return null;
    return encodeBoardColumnCursor({
      sort,
      direction,
      position: deal.position,
      id: deal.id,
      lastAt: lastAtByDealId.get(deal.id) ?? null,
    });
  }
  return encodeBoardColumnCursor({
    sort,
    direction,
    position: deal.position,
    id: deal.id,
    createdAt: sort === "createdAt" ? new Date(deal.createdAt) : undefined,
  });
}

/**
 * Página de UMA etapa em `lastInteraction`: mesmos candidatos do board (os
 * `scanCap` deals mais recentemente mexidos da etapa), mesma ordem
 * (`last_at <dir> NULLS LAST, position, id`) e só o que vem depois do
 * cursor. Devolve `last_at` para montar o cursor seguinte.
 */
export function buildLastInteractionColumnPageSql(args: {
  orgId: string;
  stageId: string;
  whereSql: Prisma.Sql;
  direction: BoardSortDirection;
  scanCap: number;
  cursor: BoardColumnCursor;
  take: number;
}): Prisma.Sql {
  const desc = args.direction === "desc";
  const dir = desc ? Prisma.raw("DESC") : Prisma.raw("ASC");
  const afterPosition = Prisma.sql`(r."position", r.id) > (${args.cursor.position}::double precision, ${args.cursor.id})`;
  const lastAt = args.cursor.lastAt ?? null;
  // NULLS LAST nas duas direções: depois de um card com `last_at` vêm os de
  // `last_at` "pior", os empatados adiante na posição e todos os sem conversa;
  // depois de um card sem conversa, só os sem conversa adiante na posição.
  const keyset =
    lastAt === null
      ? Prisma.sql`(r.last_at IS NULL AND ${afterPosition})`
      : desc
        ? Prisma.sql`(r.last_at < ${lastAt} OR (r.last_at = ${lastAt} AND ${afterPosition}) OR r.last_at IS NULL)`
        : Prisma.sql`(r.last_at > ${lastAt} OR (r.last_at = ${lastAt} AND ${afterPosition}) OR r.last_at IS NULL)`;
  const li = boardLastInteractionSql(args.orgId);
  return Prisma.sql`
    WITH candidates AS (
      SELECT d.id, d."contactId", d."position"
      FROM deals d
      WHERE d."organizationId" = ${args.orgId}
        AND d."stageId" = ${args.stageId}
        AND (${args.whereSql})
      ORDER BY d."updatedAt" DESC, d.id DESC
      LIMIT ${args.scanCap}
    ),
    ranked AS (
      SELECT c.id, c."position", ${li.lastAt} AS last_at
      FROM candidates c
      ${li.joins}
    )
    SELECT r.id, r.last_at
    FROM ranked r
    WHERE ${keyset}
    ORDER BY r.last_at ${dir} NULLS LAST, r."position" ASC, r.id ASC
    LIMIT ${args.take}
  `;
}

/**
 * Próximos cards de uma ou mais etapas, a partir do cursor de cada uma.
 *
 * Custo de uma etapa: 1 consulta das etapas pedidas + 1 contagem em SQL
 * (total atual das etapas pedidas) + 1 página de deals (`lastInteraction`: 1
 * ranking + 1 hidratação) + o enriquecimento dos cards devolvidos (2
 * consultas + avatar), feito UMA vez para todas as etapas do pedido. Não
 * passa pelo cache do board.
 *
 * Etapa que não é do pipeline (ou não existe) é ignorada — fica fora da
 * resposta. Quem chama (a rota) filtra antes as etapas que o usuário não
 * pode ver.
 */
export async function getBoardColumnPages(
  pipelineId: string,
  visibilityWhere: Prisma.DealWhereInput | string | null | undefined,
  statusFilter: DealStatus | "ALL" | undefined,
  advancedFilters: AdvancedDealFilters | undefined,
  opts: {
    sortField?: BoardSortField;
    sortDirection?: BoardSortDirection;
    columns: readonly BoardColumnPageRequest[];
  },
) {
  const now = new Date();
  const { sort, direction } = normalizeBoardCursorSort(
    opts.sortField,
    opts.sortDirection,
  );

  if (opts.columns.length === 0 || opts.columns.length > MAX_BOARD_COLUMNS_PER_REQUEST) {
    throw new BoardColumnPageError(
      "invalid_request",
      `Informe de 1 a ${MAX_BOARD_COLUMNS_PER_REQUEST} etapas.`,
    );
  }
  // Valida tudo antes da primeira consulta.
  const requests = new Map<string, { cursor: BoardColumnCursor; limit: number }>();
  for (const col of opts.columns) {
    if (typeof col?.stageId !== "string" || col.stageId.length === 0) {
      throw new BoardColumnPageError("invalid_request", "Etapa inválida.");
    }
    if (requests.has(col.stageId)) continue;
    const cursor = parseBoardColumnCursor(col.cursor, sort, direction);
    if (!cursor) {
      throw new BoardColumnPageError("invalid_cursor", "Cursor inválido.");
    }
    const rawLimit =
      typeof col.limit === "number" && Number.isFinite(col.limit)
        ? Math.floor(col.limit)
        : DEFAULT_BOARD_COLUMN_PAGE;
    requests.set(col.stageId, {
      cursor,
      limit: Math.min(MAX_BOARD_COLUMN_LIMIT, Math.max(1, rawLimit)),
    });
  }

  const normalizedWhere =
    typeof visibilityWhere === "string"
      ? { ownerId: visibilityWhere }
      : visibilityWhere ?? null;
  const { where: baseWhere, search } = await buildBoardDealWhere(
    normalizedWhere,
    statusFilter,
    advancedFilters,
  );
  // Where em SQL: obrigatório para a página de `lastInteraction`; nas outras
  // ordenações serve só à contagem (abaixo). A busca livre entra como predicado
  // (subconsultas); só o caminho por Prisma (`position`/`createdAt`) pede os ids.
  const baseSql = translateDealWhereToSql(baseWhere);
  const translatedWhere = baseSql && search ? sqlAndAll([baseSql, search.sql]) : baseSql;
  const whereSql = sort === "lastInteraction" ? translatedWhere : null;
  if (sort === "lastInteraction" && !whereSql) {
    throw new BoardColumnPageError(
      "cursor_unsupported",
      "Paginação por cursor indisponível para este filtro com ordenação por última interação.",
    );
  }

  const stagesRaw = await prisma.stage.findMany({
    where: { pipelineId, id: { in: [...requests.keys()] } },
    orderBy: { position: "asc" },
  });

  // Where Prisma COMPLETO, só quando um caminho precisa dele (página por
  // `position`/`createdAt` via findMany, ou `groupBy` de totais sem tradução).
  // Com busca, os ids saem de UMA consulta estreitada pelas etapas pedidas.
  const needsPrismaWhere = sort !== "lastInteraction" || !translatedWhere;
  const dealWhere: Prisma.DealWhereInput =
    search && needsPrismaWhere
      ? {
          AND: [
            baseWhere,
            await search.prismaWhere({
              narrowSql: narrowSqlOfConditions([
                ...andConditionsOf(baseWhere),
                { stageId: { in: stagesRaw.map((s) => s.id) } },
              ]),
            }),
          ],
        }
      : baseWhere;

  // Total ATUAL de cada etapa pedida (o do board pode ter até 45 s de cache):
  // o cliente recalcula "faltam N" sem recarregar o board. Em voo junto com
  // as páginas. Where traduzível → uma contagem em SQL sem JOIN (K3); senão
  // o `groupBy` do Prisma, que é quem sabe avaliar o filtro.
  const totalsPromise: Promise<{ stageId: string; _count: { _all: number } }[]> =
    stagesRaw.length === 0
      ? Promise.resolve([])
      : translatedWhere
        ? prisma
            .$queryRaw<{ stageId: string; total: number | bigint }[]>(
              buildBoardStageTotalsSql({
                orgId: getOrgIdOrThrow(),
                stageIds: stagesRaw.map((s) => s.id),
                whereSql: translatedWhere,
              }),
            )
            .then((rows) =>
              rows.map((r) => ({ stageId: r.stageId, _count: { _all: Number(r.total) } })),
            )
        : prisma.deal.groupBy({
            by: ["stageId"],
            where: {
              AND: [dealWhere, { stageId: { in: stagesRaw.map((s) => s.id) } }],
            },
            _count: { _all: true },
          });
  totalsPromise.catch(() => undefined);

  const hasMoreByStage = new Map<string, boolean>();
  const lastAtByDealId = new Map<string, Date | null>();
  let stages: BoardStageWithDeals[];

  if (sort === "lastInteraction" && whereSql) {
    const orgId = getOrgIdOrThrow();
    const idsByStage = new Map<string, string[]>();
    await mapWithConcurrency(
      stagesRaw,
      BOARD_STAGE_FALLBACK_CONCURRENCY,
      async (stage) => {
        const req = requests.get(stage.id)!;
        const rows = await prisma.$queryRaw<
          { id: string; last_at: Date | string | null }[]
        >(
          buildLastInteractionColumnPageSql({
            orgId,
            stageId: stage.id,
            whereSql,
            direction,
            scanCap: LAST_INTERACTION_STAGE_SCAN_CAP,
            cursor: req.cursor,
            take: req.limit + 1,
          }),
        );
        hasMoreByStage.set(stage.id, rows.length > req.limit);
        const page = rows.slice(0, req.limit);
        for (const row of page) {
          lastAtByDealId.set(row.id, row.last_at == null ? null : new Date(row.last_at));
        }
        idsByStage.set(
          stage.id,
          page.map((row) => row.id),
        );
      },
    );
    stages = await hydrateBoardStages(stagesRaw, idsByStage);
  } else {
    const orderBy = boardColumnOrderBy(sort, direction);
    const dealsByStage = await mapWithConcurrency(
      stagesRaw,
      BOARD_STAGE_FALLBACK_CONCURRENCY,
      (stage) => {
        const req = requests.get(stage.id)!;
        return prisma.deal.findMany({
          // AND explícito: `stageId` da etapa nunca sobrescreve um `stageId`
          // que a visibilidade de funil já tenha posto no where.
          where: {
            AND: [dealWhere, { stageId: stage.id }, boardColumnKeysetWhere(req.cursor)],
          },
          orderBy,
          take: req.limit + 1,
          include: BOARD_DEAL_INCLUDE,
        });
      },
    );
    stages = stagesRaw.map((stage, i) => {
      const limit = requests.get(stage.id)!.limit;
      const rows = dealsByStage[i] ?? [];
      hasMoreByStage.set(stage.id, rows.length > limit);
      return { ...stage, deals: rows.slice(0, limit) };
    });
  }

  const [totalsGroups, enrichCard] = await Promise.all([
    totalsPromise,
    loadBoardCardEnrichment(stages, now),
  ]);
  const totalsByStage = new Map<string, number>();
  for (const g of totalsGroups) totalsByStage.set(g.stageId, g._count._all);

  return stages.map((stage) => {
    const hasMore = hasMoreByStage.get(stage.id) ?? false;
    const lastDeal = stage.deals[stage.deals.length - 1];
    return {
      stageId: stage.id,
      deals: stage.deals.map((deal) => enrichCard(stage, deal)),
      totalCount: totalsByStage.get(stage.id) ?? 0,
      hasMore,
      nextCursor:
        hasMore && lastDeal
          ? boardCursorAfterDeal(sort, direction, lastDeal, lastAtByDealId)
          : null,
    };
  });
}

/**
 * Internos do board expostos SÓ para testes (equivalência consulta única ×
 * caminho por etapa, SQL gerado). Não usar fora de `*.test.ts`.
 */
export const __boardInternal = {
  mapWithConcurrency,
  preResolveBoardWhere,
  BOARD_PRERESOLVE_CAP,
  loadBoardStagesRanked,
  loadBoardStagesPerStage,
  loadBoardStagesByLastInteraction,
  loadLastInteractionIdsPerStage,
  hydrateBoardStages,
  boardRankOrderBySql,
  buildBoardDealOrderBy,
  BOARD_STAGE_FALLBACK_CONCURRENCY,
  LAST_INTERACTION_STAGE_SCAN_CAP,
};
