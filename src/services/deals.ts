import {
  Prisma,
  type ConversationStatus,
  type DealRole,
  type DealStatus,
} from "@prisma/client";

import { defaultDealTitleForContact } from "@/lib/display-name";
import { prisma, type ScopedTx } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull, getOrgIdOrThrow, type ContextActor } from "@/lib/request-context";
import { sseBus } from "@/lib/sse-bus";
import { getOrgSettingBool } from "@/lib/org-settings";
import { logEvent, withAutomationOriginMeta } from "@/services/activity-log";
import { getStageMetrics } from "@/services/analytics";
import { enrichContactsWithUserAvatarFallback } from "@/lib/contact-avatar-fallback";
import { cache } from "@/lib/cache";
import { boardDataKey, invalidateBoardData } from "@/lib/cache/keys";
import {
  buildDealSearchOr,
  buildDealWhereFromFilters,
  type AdvancedDealFilters,
} from "@/services/kanban-filters";

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
    console.warn(
      "[deals/assertLostReasonAllowed] Falha lendo allowOther; permitindo:",
      (e as Error)?.message ?? e,
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

  // Extrai field/old/new do meta (convencao herdada do log antigo).
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

  // Fire-and-forget para o novo log — falhas nao afetam o legado.
  void logEvent({
    type,
    entityType: "DEAL",
    entityId: dealId,
    dealId,
    field,
    oldValue,
    newValue,
    meta,
    ...(actorOverride ? { actor: actorOverride } : {}),
  });

  return prisma.dealEvent
    .create({ data: withOrgFromCtx({ dealId, userId, type, meta: metaJson }) })
    .catch(() =>
      prisma.dealEvent.create({
        data: withOrgFromCtx({ dealId, userId: null, type, meta: metaJson }),
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
  visibilityWhere?: Prisma.DealWhereInput;
  /**
   * Escopo de funis por usuário. `null/undefined` → sem restrição; array
   * (mesmo vazio) → restringe deals aos estágios desses funis.
   */
  allowedPipelineIds?: string[] | null;
  /** Mesma engine do POST /board — filtros avançados (tags, datas, custom…). */
  advancedFilters?: AdvancedDealFilters;
};

const listInclude = {
  contact: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true } },
  stage: {
    select: {
      id: true,
      name: true,
      position: true,
      color: true,
      pipelineId: true,
    },
  },
  owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
} satisfies Prisma.DealInclude;

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

  const search = params.search?.trim();
  if (search) {
    // Mesma engine de busca livre do Kanban (título, contato, número do
    // negócio e qualquer campo personalizado — inclusive CPF/RGM com máscara).
    const or = await buildDealSearchOr(search);
    if (or.length > 0) conditions.push({ OR: or });
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

  const where: Prisma.DealWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};

  const [items, total] = await Promise.all([
    prisma.deal.findMany({
      where,
      skip,
      take: perPage,
      orderBy: [{ updatedAt: "desc" }],
      include: listInclude,
    }),
    prisma.deal.count({ where }),
  ]);

  await enrichContactsWithUserAvatarFallback(
    items.map((d) => d.contact).filter((c): c is NonNullable<typeof c> => c !== null),
  );

  return { items, total, page, perPage };
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
        orderBy: [
          { updatedAt: "desc" as const },
          { createdAt: "desc" as const },
          { id: "desc" as const },
        ],
        select: {
          id: true, number: true, externalId: true, channel: true,
          status: true, inboxName: true, closedAt: true,
          createdAt: true, updatedAt: true,
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
  owner: { select: { id: true, name: true, email: true, avatarUrl: true, role: true } },
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

export async function getDealById(idOrNumber: string): Promise<DealDetail | null> {
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
    await enrichContactsWithUserAvatarFallback([deal.contact]);
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
};

/**
 * Calcula o proximo `Deal.number` da org corrente. O schema declara
 * `@@unique([organizationId, number])` e o campo nao tem default — antes
 * era autoincrement global, mas multi-tenancy partiu por org e Postgres
 * sequences nao suportam particionamento. A extension Prisma escopa o
 * aggregate por org via getOrgIdOrThrow(), entao isso ja vem isolado.
 *
 * Em caso de corrida (dois creates simultaneos resolvendo o mesmo
 * `max+1`), o caller deve fazer retry em P2002 — ver `createDeal` abaixo.
 */
export async function nextDealNumber(): Promise<number> {
  const r = await prisma.deal.aggregate({ _max: { number: true } });
  return (r._max.number ?? 0) + 1;
}

const DEAL_NUMBER_MAX_RETRIES = 5;

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

export async function createDeal(data: CreateDealInput) {
  // Título opcional. Prioridade:
  //  1. título informado
  //  2. "Negócio {Nome do Contato}" quando há contactId
  //  3. "Negócio - #<number>" (fallback numérico, resolvido no loop)
  let rawTitle = data.title?.trim() ?? "";
  if (!rawTitle && data.contactId) {
    const contact = await prisma.contact.findFirst({
      where: { id: data.contactId },
      select: { name: true },
    });
    rawTitle = defaultDealTitleForContact(contact?.name) ?? "";
  }

  const maxPos = await prisma.deal.aggregate({
    where: { stageId: data.stageId },
    _max: { position: true },
  });
  const position = data.position ?? (maxPos._max.position ?? -1) + 1;

  // `number` e mandatorio (sem default) e unico por org. Tentamos
  // alocar max+1 e repetimos em P2002 para cobrir corridas concorrentes
  // (ex.: dois usuarios da mesma org criando deal no mesmo segundo).
  let lastErr: unknown;
  for (let attempt = 0; attempt < DEAL_NUMBER_MAX_RETRIES; attempt++) {
    const number = await nextDealNumber();
    const title = rawTitle || `Negócio - #${number}`;
    try {
      const created = await prisma.deal.create({
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
        }),
        include: listInclude,
      });
      await invalidateBoardsForPipelines([created.stage?.pipelineId]);
      return created;
    } catch (err) {
      lastErr = err;
      if (isPrismaUniqueViolation(err)) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("Falha ao alocar Deal.number apos retries");
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
async function invalidateBoardsForPipelines(
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
   * Quando o owner muda: também atualiza conversas do contato.
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
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.deal.update({
      where: { id },
      data: payload,
      include: listInclude,
    });

    if (data.ownerId !== undefined) {
      const contactId =
        data.contactId !== undefined ? data.contactId : row.contactId;
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
  ]);

  return updated;
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
export type ConversationAssigneeChange = {
  conversationId: string;
  contactId: string | null;
  entityLabel: string | null;
  fromUserId: string | null;
  fromName: string | null;
  toUserId: string | null;
  toName: string | null;
};

async function logConversationAssigneeChanges(
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
      sseBus.publish("conversation_timeline_updated", {
        organizationId,
        conversationId: c.conversationId,
        type: "ASSIGNEE_CHANGED",
      });
    } catch {
      /* best-effort */
    }
  }
}

export async function propagateOwnerToContactAndChat(
  tx: ScopedTx,
  contactId: string | null | undefined,
  ownerId: string | null,
  opts?: { conversations?: boolean },
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
 * Atribui um responsável a um deal e propaga a atribuição para o
 * contato e as conversas (regra de herança). Use esta função sempre
 * que for mudar `Deal.ownerId` de forma isolada (sem outros campos).
 */
export async function assignDealOwner(
  dealId: string,
  ownerId: string | null,
) {
  const deal = await prisma.$transaction(async (tx) => {
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
    await propagateOwnerToContactAndChat(tx, row.contactId, ownerId);
    return row;
  });

  await invalidateBoardsForPipelines([deal.stage?.pipelineId]);

  return deal;
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
    createDealEvent(deal.id, actorUserId, "OWNER_CHANGED", {
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

export async function moveDeal(
  dealId: string,
  targetStageId: string,
  position: number,
  options?: MoveDealOptions,
) {
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

  // Valida o motivo ANTES de abrir a transação (evita rollback se o destino
  // for o estágio Perdido e o motivo livre tiver sido bloqueado pela setting).
  if (options?.lostReason) {
    await assertLostReasonAllowed(options.lostReason, targetPeek.pipelineId);
  }

  let becameWon = false;
  let becameLost = false;
  // Preserva o pipeline de ORIGEM para invalidação de cache pós-move.
  let fromPipelineId: string | null = dealPeek.stage.pipelineId;
  // Timeout 20s: sob carga (webhooks + AI) o default 5s estourava em
  // `updateMany` de posição → P2028 → HTTP 500 em /deals/:id/move (~6s).
  // Hidratação (`listInclude`) fica FORA da TX pra liberar locks cedo.
  // Retry em P2034/deadlock: moves concorrentes ainda podem colidir; a
  // ordem de lock reduz, o retry absorve o residual.
  let lastMoveErr: unknown;
  for (let attempt = 0; attempt < MOVE_DEAL_MAX_RETRIES; attempt++) {
    try {
      await prisma.$transaction(
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
          fromPipelineId = dealStage.pipelineId;
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

          if (oldStageId === targetStageId) {
            // Indexação fracionária: grava o ponto médio entre os vizinhos
            // do índice alvo — 1 UPDATE na linha movida. Antes reescrevia
            // TODAS as posições do estágio (bulk VALUES) a cada drag.
            const siblings = await tx.deal.count({
              where: { stageId: targetStageId, id: { not: dealId } },
            });
            const clamped = Math.min(position, siblings);
            const newPos = await resolveInsertionPosition(
              tx,
              targetStageId,
              clamped,
              dealId,
            );
            await tx.deal.update({
              where: { id: dealId },
              data: { position: newPos, ...statusPatch },
            });
            return;
          }

          // Cross-stage: idem — ponto médio no destino, SEM shift em massa
          // (`position+1` no destino e `position-1` na origem custavam ~900ms
          // por move em estágios grandes; posições esparsas na origem
          // preservam a ordem sem nenhum UPDATE adicional).
          const targetSiblings = await tx.deal.count({
            where: { stageId: targetStageId },
          });
          const clamped = Math.min(position, targetSiblings);
          const newPos = await resolveInsertionPosition(
            tx,
            targetStageId,
            clamped,
          );

          await tx.deal.update({
            where: { id: dealId },
            data: { stageId: targetStageId, position: newPos, ...statusPatch },
          });
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      lastMoveErr = undefined;
      break;
    } catch (err) {
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
      console.warn("[deals.moveDeal] onCandidateStageMove falhou:", {
        dealId,
        targetStageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }),
  );

  // Invalida o cache-aside do board pra que a ação manual do operador
  // reflita de imediato (sem esperar o TTL), evitando "flicker" do card
  // voltando à coluna de origem. Cobre origem e destino (cross-pipeline).
  try {
    const orgId = getOrgIdOrThrow();
    void invalidateBoardData(orgId, targetPeek.pipelineId);
    if (fromPipelineId && fromPipelineId !== targetPeek.pipelineId) {
      void invalidateBoardData(orgId, fromPipelineId);
    }
  } catch {
    /* fora de contexto de org (jobs) — TTL curto cobre a atualização */
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

/** Limite default de cards exibidos por coluna no board. */
const DEFAULT_BOARD_COLUMN_LIMIT = 100;
const MAX_BOARD_COLUMN_LIMIT = 500;
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
 *   já carregados (default 100 por coluna).
 * - `lastInteraction`: ordena pela última interação na conversa do
 *   contato vinculado ao deal (`MAX(Conversation.updatedAt)` do
 *   contato). Como o Deal não tem campo desnormalizado, esse sort
 *   percorre um caminho próprio (`loadBoardStagesByLastInteraction`):
 *   busca IDs leves de todos os deals que casam com o filtro,
 *   agrega o último `updatedAt` por contato via `groupBy`, ordena
 *   e pagina em memória, e só então faz o `findMany` completo dos
 *   IDs paginados. Deals sem contato/conversa ficam no fim
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
    return [{ createdAt: dir }, { position: "asc" }];
  }
  // `lastInteraction` não cai aqui — segue por caminho próprio em
  // `loadBoardStagesByLastInteraction`. Fallback estável.
  return [{ position: "asc" }];
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
  owner: { select: { id: true, name: true, avatarUrl: true } },
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

/**
 * Caminho alternativo do board quando `sortField === "lastInteraction"`.
 *
 * Por que separado: o Prisma não suporta ordenar `Deal` por agregação
 * de uma relação distante (`Deal → Contact → Conversations`). A
 * solução é fazer em 3 passos:
 *
 *   1) Lista leve de IDs candidatos por stage (apenas
 *      `id, stageId, contactId, position`) respeitando o `where`.
 *   2) `groupBy contactId _max: updatedAt` em `Conversation` para
 *      obter o último timestamp por contato.
 *   3) Ordenar/paginar em memória por stage e buscar os deals
 *      completos via `findMany({ where: { id: { in: ids } } })`.
 *
 * Custos: 3 queries Prisma (vs 1 do caminho default), mas a 1ª e a 2ª
 * trazem só colunas leves. Para até alguns milhares de deals por org
 * o overhead é desprezível. Se ficar pesado, o passo recomendado é
 * desnormalizar `Deal.lastInteractionAt` e migrar pro caminho default.
 */
async function loadBoardStagesByLastInteraction(
  pipelineId: string,
  dealWhere: Prisma.DealWhereInput,
  perStage: number,
  offsetByStage: Record<string, number>,
  direction: BoardSortDirection,
): Promise<BoardStageWithDeals[]> {
  const stagesRaw = await prisma.stage.findMany({
    where: { pipelineId },
    orderBy: { position: "asc" },
  });
  if (stagesRaw.length === 0) return [];

  const stageIds = stagesRaw.map((s) => s.id);
  const candidates = await prisma.deal.findMany({
    where: { ...dealWhere, stageId: { in: stageIds } },
    select: { id: true, stageId: true, contactId: true, position: true },
  });

  const contactIds = Array.from(
    new Set(
      candidates
        .map((c) => c.contactId)
        .filter((id): id is string => id !== null),
    ),
  );

  const lastByContact = new Map<string, Date>();
  if (contactIds.length > 0) {
    const groups = await prisma.conversation.groupBy({
      by: ["contactId"],
      where: { contactId: { in: contactIds } },
      _max: { updatedAt: true },
    });
    for (const g of groups) {
      if (g._max.updatedAt) lastByContact.set(g.contactId, g._max.updatedAt);
    }
  }

  // Agrupa candidatos por stage e ordena cada grupo.
  type Candidate = (typeof candidates)[number];
  const byStage = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = byStage.get(c.stageId);
    if (arr) arr.push(c);
    else byStage.set(c.stageId, [c]);
  }
  const cmp = (a: Candidate, b: Candidate) => {
    const aLast = a.contactId ? lastByContact.get(a.contactId) : undefined;
    const bLast = b.contactId ? lastByContact.get(b.contactId) : undefined;
    // Nulls last em AMBAS as direções: deals sem conversa nunca devem
    // ficar no topo, independentemente de "mais recente" ou "mais antigo".
    if (!aLast && !bLast) return a.position - b.position;
    if (!aLast) return 1;
    if (!bLast) return -1;
    const diff = aLast.getTime() - bLast.getTime();
    if (diff !== 0) return direction === "desc" ? -diff : diff;
    return a.position - b.position;
  };

  const paginatedIdsByStage = new Map<string, string[]>();
  for (const [stageId, items] of byStage) {
    items.sort(cmp);
    const extra = offsetByStage[stageId] ?? 0;
    const limit = perStage + extra;
    paginatedIdsByStage.set(stageId, items.slice(0, limit).map((d) => d.id));
  }

  const allPaginatedIds = Array.from(paginatedIdsByStage.values()).flat();
  const dealsLoaded =
    allPaginatedIds.length === 0
      ? []
      : await prisma.deal.findMany({
          where: { id: { in: allPaginatedIds } },
          include: BOARD_DEAL_INCLUDE,
        });
  const dealById = new Map(dealsLoaded.map((d) => [d.id, d]));

  return stagesRaw.map((stage) => {
    const ids = paginatedIdsByStage.get(stage.id) ?? [];
    const deals = ids
      .map((id) => dealById.get(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d));
    return { ...stage, deals };
  });
}

export type BoardLimitOptions = {
  /** Quantos cards retornar por coluna. */
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
  const variant = JSON.stringify({
    v: normalizedWhere ?? null,
    s: statusFilter ?? null,
    f: advancedFilters ?? null,
    l: limitOptions ?? null,
  });
  return cache.wrap(
    boardDataKey(orgId, pipelineId, variant),
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

async function computeBoardData(
  pipelineId: string,
  visibilityWhere?: Prisma.DealWhereInput | null,
  statusFilter?: DealStatus | "ALL",
  advancedFilters?: AdvancedDealFilters,
  limitOptions?: BoardLimitOptions,
) {
  const now = new Date();

  const conditions: Prisma.DealWhereInput[] = [];

  if (statusFilter && statusFilter !== "ALL") {
    conditions.push({ status: statusFilter });
  } else if (!statusFilter) {
    conditions.push({ status: "OPEN" });
  }
  if (visibilityWhere && Object.keys(visibilityWhere).length > 0) {
    conditions.push(visibilityWhere);
  }

  if (advancedFilters && Object.keys(advancedFilters).length > 0) {
    // pipelineId/statuses no advancedFilters não substituem visibilidade —
    // ficam como condições adicionais (AND).
    const advConditions = await buildDealWhereFromFilters(advancedFilters);
    for (const c of advConditions) conditions.push(c);
  }

  const dealWhere: Prisma.DealWhereInput =
    conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0] : { AND: conditions };

  const perStage = Math.min(
    MAX_BOARD_COLUMN_LIMIT,
    Math.max(1, limitOptions?.perStage ?? DEFAULT_BOARD_COLUMN_LIMIT),
  );
  const offsetByStage = limitOptions?.offsetByStage ?? {};
  const sortField = limitOptions?.sortField;
  const sortDirection: BoardSortDirection =
    limitOptions?.sortDirection === "desc" ? "desc" : "asc";
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

  // ⚡ COUNT por etapa em paralelo com o SELECT de cards. Antes o groupBy
  // esperava `stages` só pra montar `stageId IN (...)` — agora escopa por
  // `stage.pipelineId` (mesmo resultado) e sobe junto com a query pesada.
  const totalsPromise: Promise<{ stageId: string; _count: { _all: number } }[]> =
    prisma.deal.groupBy({
      by: ["stageId"],
      where: { ...dealWhere, stage: { pipelineId } },
      _count: { _all: true },
    });

  let stages: BoardStageWithDeals[];

  if (sortField === "lastInteraction") {
    // Caminho dedicado: ordena por `MAX(Conversation.updatedAt)` do
    // contato. Já aplica `offsetByStage` internamente (não cai no
    // branch de "Carregar mais" abaixo).
    stages = await loadBoardStagesByLastInteraction(
      pipelineId,
      dealWhere,
      perStage,
      offsetByStage,
      sortDirection,
    );
  } else {
    // 1) Etapas leves + 2) cards por coluna em paralelo (LIMIT por stage).
    // Nested `include.deals.take` gerava um plano único pesado em funis
    // grandes (ex.: ~40k OPEN); N queries indexadas `stageId+status+position`
    // com LIMIT rodam juntas e costumam ser bem mais baratas.
    const stagesRaw = await prisma.stage.findMany({
      where: { pipelineId },
      orderBy: { position: "asc" },
    });
    const dealsByStage = await Promise.all(
      stagesRaw.map((stage) => {
        const extra = offsetByStage[stage.id] ?? 0;
        return prisma.deal.findMany({
          where: { ...dealWhere, stageId: stage.id },
          orderBy: dealOrderBy,
          take: perStage + extra,
          include: BOARD_DEAL_INCLUDE,
        });
      }),
    );
    stages = stagesRaw.map((stage, i) => ({
      ...stage,
      deals: dealsByStage[i] ?? [],
    }));
  }

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

  // Última mensagem + não lidas + canal por contato.
  // Obs.: o "responsável" do contato e do chat são derivados de
  // `Deal.owner` via regra de herança (ver `propagateOwnerToContactAndChat`),
  // então não precisamos carregá-los separadamente aqui.
  //
  // Antes: findMany conversations + nested messages take 1 por conv — N+1
  // em SQL gerado. Agora: 1 query com DISTINCT ON (mesmo padrão do inbox).
  // Semântica: unread = soma; channel = conv mais recente por updatedAt;
  // lastMessage = msg mais recente do contato (qualquer conv).
  type BoardConvRow = {
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
  };
  /** Últimas inbound por contato (até 5) — preview “N aguardando” no card. */
  type BoardAwaitingMsgRow = {
    contactId: string;
    content: string;
    createdAt: Date;
    rn: number;
  };
  const AWAITING_PREVIEW_CAP = 5;
  const convsPromise: Promise<BoardConvRow[]> =
    allContactIds.length > 0
      ? prisma.$queryRaw<BoardConvRow[]>`
          WITH contact_unread AS (
            SELECT "contactId", SUM("unreadCount")::int AS unread
            FROM conversations
            WHERE "contactId" = ANY(${allContactIds})
              AND "organizationId" = ${orgIdForBoard}
            GROUP BY "contactId"
          ),
          latest_channel AS (
            SELECT DISTINCT ON ("contactId")
              "contactId", channel
            FROM conversations
            WHERE "contactId" = ANY(${allContactIds})
              AND "organizationId" = ${orgIdForBoard}
            ORDER BY "contactId", "updatedAt" DESC
          ),
          last_msg AS (
            SELECT DISTINCT ON (c."contactId")
              c."contactId",
              m.id AS "msgId",
              m."externalId" AS "msgExternalId",
              m.content AS "msgContent",
              m."createdAt" AS "msgCreatedAt",
              m.direction AS "msgDirection",
              m."sendStatus" AS "msgSendStatus",
              m."sendError" AS "msgSendError"
            FROM conversations c
            INNER JOIN messages m ON m."conversationId" = c.id
            WHERE c."contactId" = ANY(${allContactIds})
              AND c."organizationId" = ${orgIdForBoard}
              AND m."organizationId" = ${orgIdForBoard}
              -- Preview do card = última msg real de chat (cliente/agente).
              -- Exclui nota interna, rascunho IA e eventos de call — senão o
              -- kanban/Flow mostra "Lead/Conversa distribuída…" no lugar do Oi.
              AND m."isPrivate" = false
              AND m."messageType" NOT IN (
                'note',
                'ai_draft',
                'whatsapp_call',
                'whatsapp_call_recording'
              )
              AND m."messageType" NOT LIKE 'event%'
              AND m.direction IN ('in', 'out')
            ORDER BY c."contactId", m."createdAt" DESC
          )
          SELECT
            cu."contactId",
            lc.channel,
            COALESCE(cu.unread, 0) AS "unreadCount",
            lm."msgId",
            lm."msgExternalId",
            lm."msgContent",
            lm."msgCreatedAt",
            lm."msgDirection",
            lm."msgSendStatus",
            lm."msgSendError"
          FROM contact_unread cu
          LEFT JOIN latest_channel lc ON lc."contactId" = cu."contactId"
          LEFT JOIN last_msg lm ON lm."contactId" = cu."contactId"
        `
      : Promise.resolve([]);

  const awaitingMsgsPromise: Promise<BoardAwaitingMsgRow[]> =
    openStageContactIds.length > 0
      ? prisma.$queryRaw<BoardAwaitingMsgRow[]>`
          SELECT
            ranked."contactId",
            ranked.content,
            ranked."createdAt",
            ranked.rn
          FROM (
            SELECT
              c."contactId",
              m.content,
              m."createdAt",
              ROW_NUMBER() OVER (
                PARTITION BY c."contactId"
                ORDER BY m."createdAt" DESC
              )::int AS rn
            FROM conversations c
            INNER JOIN messages m ON m."conversationId" = c.id
            WHERE c."contactId" = ANY(${openStageContactIds})
              AND c."organizationId" = ${orgIdForBoard}
              AND m."organizationId" = ${orgIdForBoard}
              AND m."isPrivate" = false
              AND m.direction = 'in'
              AND m."messageType" NOT IN (
                'note',
                'ai_draft',
                'whatsapp_call',
                'whatsapp_call_recording'
              )
          ) ranked
          WHERE ranked.rn <= ${AWAITING_PREVIEW_CAP}
        `
      : Promise.resolve([]);

  const [totalsGroups, dealProducts, convs, awaitingMsgRows, metrics] =
    await Promise.all([
      totalsPromise,
      productsPromise,
      convsPromise,
      awaitingMsgsPromise,
      metricsPromise,
      // Enriquecimento de avatar (fallback PURAMENTE VISUAL — foto do User
      // homônimo quando o Contact não tem avatarUrl). Independe das demais;
      // roda no mesmo lote. Muta `allContacts` em memória e resolve void.
      enrichContactsWithUserAvatarFallback(allContacts),
    ]);

  const totalsByStage = new Map<string, number>();
  for (const g of totalsGroups) totalsByStage.set(g.stageId, g._count._all);

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
  const unreadMap = new Map<string, number>();
  const channelMap = new Map<string, { channel: string; updatedAt: Date }>();
  for (const row of convs) {
    if (!row.contactId) continue;
    unreadMap.set(row.contactId, row.unreadCount ?? 0);
    if (row.channel) {
      channelMap.set(row.contactId, {
        channel: row.channel,
        updatedAt: new Date(0),
      });
    }
    if (row.msgId != null && row.msgContent != null && row.msgCreatedAt != null) {
      lastMsgMap.set(row.contactId, {
        id: row.msgId,
        externalId: row.msgExternalId ?? null,
        content: row.msgContent,
        createdAt: row.msgCreatedAt,
        direction: row.msgDirection ?? "in",
        sendStatus: row.msgSendStatus ?? null,
        sendError: row.msgSendError ?? null,
      });
    }
  }

  // contactId → inbound mais recentes (rn=1 = mais nova). Cortamos por
  // unreadCount no map do deal (footer "N aguardando").
  const awaitingByContact = new Map<
    string,
    Array<{ content: string; createdAt: Date }>
  >();
  for (const row of awaitingMsgRows) {
    if (!row.contactId || !row.content?.trim()) continue;
    const list = awaitingByContact.get(row.contactId) ?? [];
    list.push({ content: row.content, createdAt: row.createdAt });
    awaitingByContact.set(row.contactId, list);
  }

  const metricsMap = new Map(metrics.map((m) => [m.stageId, m]));

  // Stage `isIncoming` (Leads de entrada) é a fase de captura e DEVE
  // ficar sempre visível. Antes filtrávamos por `stage.deals.length > 0`,
  // mas esse array é a slice PÓS-filtro (status=OPEN padrão, visibility,
  // filtros avançados). Qualquer filtro ativo escondia a coluna inteira
  // mesmo havendo leads no banco — bug reportado: "existem leads em
  // leads de entrada, mas a fase do funil não aparece".
  return stages
    .map((stage) => {
      const metric = metricsMap.get(stage.id);
      const totalCount = totalsByStage.get(stage.id) ?? stage.deals.length;
      // `extra` agora representa "quantos cards adicionais foram pedidos".
      // O total carregado é o tamanho real do array.
      const loadedCount = stage.deals.length;
      const hasMore = loadedCount < totalCount;
      return {
        ...stage,
        conversionRate: metric?.conversionRate ?? 0,
        avgDaysInStage: metric?.avgDaysInStage ?? 0,
        totalCount,
        loadedCount,
        hasMore,
        deals: stage.deals.map((deal) => {
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
            channel: deal.contactId
              ? channelMap.get(deal.contactId)?.channel ?? null
              : null,
          };
        }),
      };
    });
}
