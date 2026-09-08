import type {
  CampaignStatus,
  CampaignType,
  Prisma,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { resolveCampaignSendRate } from "@/lib/campaign-send-rate";
import { csvDate, toCsv } from "@/lib/csv-stringify";
import {
  describeMetaError,
  extractMetaErrorCode,
  isMetaNonConversationErrorCode,
} from "@/lib/meta-whatsapp/error-catalog";
import type { SegmentFilters } from "./segments";

export type FailureErrorCodeFilter = number | "other";

const EXPORT_MAX_ROWS = 50_000;

function parseErrorCodeFilter(
  raw: string | null | undefined,
): FailureErrorCodeFilter | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === "other") return "other";
  const code = Number(value);
  return Number.isFinite(code) ? code : undefined;
}

function recipientListWhere(params: {
  campaignId: string;
  status?: string;
  errorCode?: FailureErrorCodeFilter;
}): Prisma.CampaignRecipientWhereInput {
  const where: Prisma.CampaignRecipientWhereInput = {
    campaignId: params.campaignId,
  };
  if (params.status) where.status = params.status as never;
  if (params.errorCode === "other") {
    where.NOT = {
      OR: [
        { errorMessage: { contains: "(code ", mode: "insensitive" } },
        { errorMessage: { contains: "(cód.", mode: "insensitive" } },
      ],
    };
  } else if (typeof params.errorCode === "number") {
    where.OR = [
      {
        errorMessage: {
          contains: `(code ${params.errorCode}`,
          mode: "insensitive",
        },
      },
      {
        errorMessage: {
          contains: `(cód. ${params.errorCode}`,
          mode: "insensitive",
        },
      },
    ];
  }
  return where;
}

export type GetCampaignsParams = {
  status?: CampaignStatus;
  type?: CampaignType;
  search?: string;
  page?: number;
  perPage?: number;
};

export async function getCampaigns(params: GetCampaignsParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const skip = (page - 1) * perPage;

  const where: Prisma.CampaignWhereInput = {};
  if (params.status) where.status = params.status;
  if (params.type) where.type = params.type;

  // Busca por nome da campanha ou nome do segmento (mesma semântica que a
  // listagem de /campaigns aplicava no cliente antes da paginação server-side).
  const search = params.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { segment: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.campaign.findMany({
      where,
      skip,
      take: perPage,
      orderBy: { createdAt: "desc" },
      include: {
        channel: { select: { id: true, name: true, provider: true } },
        segment: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
      },
    }),
    prisma.campaign.count({ where }),
  ]);

  return { items, total, page, perPage, totalPages: Math.ceil(total / perPage) || 1 };
}

function tagIdsFromFilters(filters: unknown): string[] {
  if (!filters || typeof filters !== "object") return [];
  const ids = (filters as { tagIds?: unknown }).tagIds;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export async function getCampaignById(id: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      channel: { select: { id: true, name: true, provider: true, type: true, config: true } },
      segment: { select: { id: true, name: true, filters: true } },
      automation: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
  if (!campaign) return null;

  // Mesma fonte do worker: segmento salvo tem prioridade sobre filtros ad-hoc.
  const audienceFilters = campaign.segment
    ? campaign.segment.filters
    : campaign.filters;
  const tagIds = tagIdsFromFilters(audienceFilters);
  const tagRows =
    tagIds.length > 0
      ? await prisma.tag.findMany({
          where: { id: { in: tagIds } },
          select: { id: true, name: true },
        })
      : [];
  const tagNameById = new Map(tagRows.map((t) => [t.id, t.name]));
  const audienceTags = tagIds.map((tagId) => ({
    id: tagId,
    name: tagNameById.get(tagId) ?? tagId,
  }));

  const { segment, ...rest } = campaign;
  return {
    ...rest,
    segment: segment ? { id: segment.id, name: segment.name } : null,
    audienceTags,
  };
}

export type CreateCampaignInput = {
  name: string;
  type: CampaignType;
  /** Obrigatório quando `useLastConversationChannel` é false. */
  channelId?: string | null;
  useLastConversationChannel?: boolean;
  segmentId?: string;
  filters?: SegmentFilters;
  templateName?: string;
  templateLanguage?: string;
  templateComponents?: unknown;
  textContent?: string;
  automationId?: string;
  sendRate?: number;
  scheduledAt?: Date;
  createdById: string;
};

export async function createCampaign(input: CreateCampaignInput) {
  const useLast = Boolean(input.useLastConversationChannel);
  return prisma.campaign.create({
    data: withOrgFromCtx({
      name: input.name,
      type: input.type,
      useLastConversationChannel: useLast,
      channelId: useLast ? null : input.channelId,
      segmentId: input.segmentId ?? null,
      filters: input.filters
        ? (input.filters as unknown as Prisma.InputJsonValue)
        : undefined,
      templateName: input.templateName,
      templateLanguage: input.templateLanguage,
      templateComponents: input.templateComponents
        ? (input.templateComponents as Prisma.InputJsonValue)
        : undefined,
      textContent: input.textContent,
      automationId: input.automationId ?? null,
      sendRate: resolveCampaignSendRate(input.sendRate),
      scheduledAt: input.scheduledAt ?? null,
      createdById: input.createdById,
    }),
  });
}

export async function updateCampaign(
  id: string,
  data: Partial<Omit<CreateCampaignInput, "createdById">>,
) {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) throw new Error("Campanha não encontrada.");
  if (campaign.status !== "DRAFT") throw new Error("Só campanhas em rascunho podem ser editadas.");

  const patch: Prisma.CampaignUpdateInput = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.type !== undefined) patch.type = data.type;
  if (data.useLastConversationChannel === true) {
    patch.useLastConversationChannel = true;
    patch.channel = { disconnect: true };
  } else if (data.channelId) {
    patch.useLastConversationChannel = false;
    patch.channel = { connect: { id: data.channelId } };
  } else if (data.useLastConversationChannel === false) {
    patch.useLastConversationChannel = false;
  }
  if (data.segmentId !== undefined)
    patch.segment = data.segmentId ? { connect: { id: data.segmentId } } : { disconnect: true };
  if (data.filters !== undefined)
    patch.filters = data.filters as unknown as Prisma.InputJsonValue;
  if (data.templateName !== undefined) patch.templateName = data.templateName;
  if (data.templateLanguage !== undefined) patch.templateLanguage = data.templateLanguage;
  if (data.templateComponents !== undefined)
    patch.templateComponents = data.templateComponents as Prisma.InputJsonValue;
  if (data.textContent !== undefined) patch.textContent = data.textContent;
  if (data.automationId !== undefined)
    patch.automation = data.automationId
      ? { connect: { id: data.automationId } }
      : { disconnect: true };
  if (data.sendRate !== undefined) patch.sendRate = resolveCampaignSendRate(data.sendRate);
  if (data.scheduledAt !== undefined) patch.scheduledAt = data.scheduledAt;

  return prisma.campaign.update({ where: { id }, data: patch });
}

export async function deleteCampaign(id: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id } });
  if (!campaign) throw new Error("Campanha não encontrada.");
  if (!["DRAFT", "COMPLETED", "CANCELLED", "FAILED"].includes(campaign.status)) {
    throw new Error("Campanhas ativas não podem ser excluídas.");
  }
  return prisma.campaign.delete({ where: { id } });
}

export async function updateCampaignStatus(id: string, status: CampaignStatus) {
  const extra: Prisma.CampaignUpdateInput = { status };
  if (status === "SENDING") extra.startedAt = new Date();
  if (status === "COMPLETED" || status === "CANCELLED" || status === "FAILED")
    extra.completedAt = new Date();
  return prisma.campaign.update({ where: { id }, data: extra });
}

export async function getCampaignStats(id: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: {
      totalRecipients: true,
      sentCount: true,
      deliveredCount: true,
      failedCount: true,
      readCount: true,
      repliedCount: true,
      status: true,
      startedAt: true,
      completedAt: true,
    },
  });
  if (!campaign) throw new Error("Campanha não encontrada.");

  const pendingCount =
    campaign.totalRecipients - campaign.sentCount - campaign.failedCount;

  // Top motivos de falha agrupados pelo código Meta (não pelo texto cru).
  const failureGroups = await prisma.campaignRecipient.groupBy({
    by: ["errorMessage"],
    where: { campaignId: id, status: "FAILED" },
    _count: { _all: true },
  });
  const aggregated = new Map<
    string,
    {
      reason: string;
      count: number;
      code: number | null;
      action: string | null;
      kind: "eligibility" | "operational";
    }
  >();
  let eligibilityFailedCount = 0;
  for (const g of failureGroups) {
    const raw = g.errorMessage ?? "Desconhecido";
    const code = extractMetaErrorCode(raw);
    const catalog = code != null ? describeMetaError(code)?.reason ?? "" : "";
    const reason =
      catalog ||
      raw.replace(/\s*\((?:code|c[oó]d\.)\s*\d+[^)]*\)\s*$/i, "").trim() ||
      raw;
    const key = code != null ? `code:${code}` : raw;
    const prev = aggregated.get(key);
    const action = code != null ? describeMetaError(code)?.action ?? null : null;
    const kind = isMetaNonConversationErrorCode(code)
      ? "eligibility"
      : "operational";
    if (prev) prev.count += g._count._all;
    else aggregated.set(key, { reason, count: g._count._all, code, action, kind });
    if (isMetaNonConversationErrorCode(code)) {
      eligibilityFailedCount += g._count._all;
    }
  }
  const failureReasons = [...aggregated.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const operationalFailedCount = Math.max(
    0,
    campaign.failedCount - eligibilityFailedCount,
  );

  const pct = (n: number) =>
    campaign.sentCount > 0 ? Math.round((n / campaign.sentCount) * 100) : 0;

  return {
    ...campaign,
    pendingCount: Math.max(0, pendingCount),
    deliveryRate: pct(campaign.deliveredCount),
    readRate: pct(campaign.readCount),
    replyRate: pct(campaign.repliedCount),
    failureReasons,
    eligibilityFailedCount,
    operationalFailedCount,
  };
}

/** Janela (dias) para atribuir uma resposta inbound a um disparo de campanha. */
const CAMPAIGN_REPLY_WINDOW_DAYS = 7;

/**
 * Correlaciona uma mensagem inbound de um contato ao disparo de campanha mais
 * recente (dentro da janela) e marca como respondido. Idempotente: só conta a
 * PRIMEIRA resposta por destinatário (filtro `repliedAt: null` + update
 * condicional). Multi-tenant: usa o `prisma` scoped do contexto atual.
 */
export async function markCampaignReplyByContact(
  contactId: string,
  repliedAt: Date = new Date(),
): Promise<void> {
  const windowStart = new Date(
    repliedAt.getTime() - CAMPAIGN_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  const recipient = await prisma.campaignRecipient.findFirst({
    where: {
      contactId,
      repliedAt: null,
      status: { in: ["SENT", "DELIVERED", "READ"] },
      sentAt: { not: null, gte: windowStart },
    },
    orderBy: { sentAt: "desc" },
    select: { id: true, campaignId: true },
  });
  if (!recipient) return;

  // Update condicional (repliedAt ainda null) evita double-count em respostas
  // concorrentes para o mesmo destinatário.
  const updated = await prisma.campaignRecipient.updateMany({
    where: { id: recipient.id, repliedAt: null },
    data: { repliedAt },
  });
  if (updated.count === 0) return;

  await prisma.campaign.update({
    where: { id: recipient.campaignId },
    data: { repliedCount: { increment: 1 } },
  });
}

export type GetRecipientsParams = {
  campaignId: string;
  status?: string;
  errorCode?: string | null;
  page?: number;
  perPage?: number;
};

export async function getCampaignRecipients(params: GetRecipientsParams) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 50));
  const skip = (page - 1) * perPage;
  const where = recipientListWhere({
    campaignId: params.campaignId,
    status: params.status,
    errorCode: parseErrorCodeFilter(params.errorCode),
  });

  const [items, total] = await Promise.all([
    prisma.campaignRecipient.findMany({
      where,
      skip,
      take: perPage,
      orderBy: { createdAt: "desc" },
      include: {
        contact: { select: { id: true, name: true, phone: true } },
      },
    }),
    prisma.campaignRecipient.count({ where }),
  ]);

  return { items, total, page, perPage, totalPages: Math.ceil(total / perPage) || 1 };
}

export type ExportRecipientsParams = {
  campaignId: string;
  status?: string;
  errorCode?: string | null;
};

export async function listCampaignRecipientsForExport(
  params: ExportRecipientsParams,
) {
  return prisma.campaignRecipient.findMany({
    where: recipientListWhere({
      campaignId: params.campaignId,
      status: params.status,
      errorCode: parseErrorCodeFilter(params.errorCode),
    }),
    take: EXPORT_MAX_ROWS,
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      errorMessage: true,
      sentAt: true,
      contact: { select: { id: true, name: true, phone: true } },
    },
  });
}

export function campaignRecipientsToCsv(
  rows: Awaited<ReturnType<typeof listCampaignRecipientsForExport>>,
): string {
  const headers = [
    "Nome",
    "Telefone",
    "ContatoId",
    "Status",
    "Codigo",
    "Motivo",
    "Erro",
    "EnviadoEm",
  ];
  return toCsv(
    headers,
    rows.map((row) => {
      const code = extractMetaErrorCode(row.errorMessage);
      const motivo =
        code != null ? describeMetaError(code)?.reason ?? "" : "";
      return {
        Nome: row.contact.name,
        Telefone: row.contact.phone ?? "",
        ContatoId: row.contact.id,
        Status: row.status,
        Codigo: code ?? "",
        Motivo: motivo,
        Erro: row.errorMessage ?? "",
        EnviadoEm: csvDate(row.sentAt),
      };
    }),
  );
}

export function campaignRecipientPhones(
  rows: Awaited<ReturnType<typeof listCampaignRecipientsForExport>>,
): string {
  return rows
    .map((row) => row.contact.phone?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

/**
 * Increment campaign counters atomically.
 */
export async function incrementCampaignCounter(
  campaignId: string,
  field: "sentCount" | "deliveredCount" | "failedCount" | "readCount",
  amount = 1,
) {
  return prisma.campaign.update({
    where: { id: campaignId },
    data: { [field]: { increment: amount } },
  });
}
