import type { DealStatus, LifecycleStage, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

export type SegmentFilters = {
  search?: string;
  lifecycleStage?: LifecycleStage;
  tagIds?: string[];
  /**
   * Exclui quem tem alguma destas etiquetas (no contato ou em qualquer
   * negócio dele), com a mesma regra de `tagIds`. Sozinho não restringe o
   * público: só tira gente de um filtro que já restringe.
   */
  excludeTagIds?: string[];
  companyId?: string;
  /** Dono do contato (Contact.assignedToId). */
  assignedToId?: string;

  /** Dono de algum deal do contato (Deal.ownerId). */
  dealOwnerId?: string;
  /** Contatos com pelo menos um deal no pipeline informado. */
  pipelineId?: string;
  /** Contatos com pelo menos um deal em algum dos estágios. */
  stageIds?: string[];
  /** Status do deal (OPEN/WON/LOST). Aplicado junto de pipeline/stage quando presente. */
  dealStatus?: DealStatus;
  /** ISO-8601: contatos criados em ou após essa data. */
  createdAfter?: string;
  /** Exige telefone preenchido (default quando resolvendo destinatários WhatsApp). */
  hasPhone?: boolean;
};

export async function getSegments() {
  return prisma.segment.findMany({ orderBy: { createdAt: "desc" } });
}

export async function getSegmentById(id: string) {
  return prisma.segment.findUnique({ where: { id } });
}

export async function createSegment(name: string, filters: SegmentFilters) {
  return prisma.segment.create({
    data: withOrgFromCtx({
      name,
      filters: filters as unknown as Prisma.InputJsonValue,
    }),
  });
}

export async function updateSegment(
  id: string,
  data: { name?: string; filters?: SegmentFilters },
) {
  const patch: Prisma.SegmentUpdateInput = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.filters !== undefined)
    patch.filters = data.filters as unknown as Prisma.InputJsonValue;
  return prisma.segment.update({ where: { id }, data: patch });
}

export async function deleteSegment(id: string) {
  return prisma.segment.delete({ where: { id } });
}

/**
 * Build a Prisma `where` clause from segment-style filters.
 * Shared between segment preview and campaign recipient resolution.
 */
export function buildContactWhere(
  filters: SegmentFilters,
): Prisma.ContactWhereInput {
  const conditions: Prisma.ContactWhereInput[] = [];
  const search = filters.search?.trim();

  if (search) {
    conditions.push({
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ],
    });
  }

  if (filters.lifecycleStage) conditions.push({ lifecycleStage: filters.lifecycleStage });
  if (filters.companyId) conditions.push({ companyId: filters.companyId });
  if (filters.assignedToId) conditions.push({ assignedToId: filters.assignedToId });
  if (filters.hasPhone) conditions.push({ phone: { not: null } });
  if (filters.createdAfter) {
    const dt = new Date(filters.createdAfter);
    if (!Number.isNaN(dt.getTime())) {
      conditions.push({ createdAt: { gte: dt } });
    }
  }

  // Tags: aceitar tanto tags no contato quanto em qualquer deal relacionado
  // (UX: o usuário não quer descobrir em qual entidade aplicou a etiqueta).
  if (filters.tagIds && filters.tagIds.length > 0) {
    conditions.push({
      OR: [
        { tags: { some: { tagId: { in: filters.tagIds } } } },
        { deals: { some: { tags: { some: { tagId: { in: filters.tagIds } } } } } },
      ],
    });
  }

  // Exclusão por etiqueta (ex.: quem pediu para não receber), mesma regra.
  if (filters.excludeTagIds && filters.excludeTagIds.length > 0) {
    conditions.push({
      NOT: {
        OR: [
          { tags: { some: { tagId: { in: filters.excludeTagIds } } } },
          { deals: { some: { tags: { some: { tagId: { in: filters.excludeTagIds } } } } } },
        ],
      },
    });
  }

  // Filtros que sempre batem em algum deal do contato
  const dealFilter: Prisma.DealWhereInput = {};
  let hasDealFilter = false;
  if (filters.pipelineId) {
    dealFilter.stage = { pipelineId: filters.pipelineId };
    hasDealFilter = true;
  }
  if (filters.stageIds && filters.stageIds.length > 0) {
    dealFilter.stageId = { in: filters.stageIds };
    hasDealFilter = true;
  }
  if (filters.dealStatus) {
    dealFilter.status = filters.dealStatus;
    hasDealFilter = true;
  }
  if (filters.dealOwnerId) {
    dealFilter.ownerId = filters.dealOwnerId;
    hasDealFilter = true;
  }
  if (hasDealFilter) {
    conditions.push({ deals: { some: dealFilter } });
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { AND: conditions };
}

export async function previewSegment(filters: SegmentFilters) {
  const where = buildContactWhere(filters);

  const [count, sample] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      take: 10,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, phone: true, email: true },
    }),
  ]);

  return { count, sample };
}

/**
 * Resolve all contact IDs matching the filters.
 * Only includes contacts with a phone number (required for WhatsApp).
 */
export async function resolveContactIds(
  filters: SegmentFilters,
): Promise<string[]> {
  const where = buildContactWhere(filters);
  where.phone = { not: null };

  const contacts = await prisma.contact.findMany({
    where,
    select: { id: true },
  });

  return contacts.map((c) => c.id);
}
