/**
 * Participantes do modo "leads" (Distribuição por Leads).
 *
 * Configuração INDEPENDENTE do smart (`DistributionResponsible`): status
 * administrativo próprio (ACTIVE/INACTIVE) + peso 0..5. Não herda presença,
 * pausa, expediente, queueLimit, departamento ou tipo do modo smart — editar
 * aqui nunca altera a elegibilidade do outro modo.
 *
 * Cada participante tem 5 slots persistentes (frequência, nunca capacidade):
 * entram no rodízio os slots com `slotIndex < weight`. Peso 0 = não recebe.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

export const LEADS_SLOT_COUNT = 5;

export interface LeadsParticipantView {
  userId: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  status: string;
  weight: number;
  slots: { slotIndex: number; active: boolean; lastAssignedAt: string | null }[];
  /** Total histórico recebido (assignments). */
  totalReceived: number;
  createdAt: string;
  updatedAt: string;
}

export async function getLeadsParticipants(): Promise<LeadsParticipantView[]> {
  const [participants, received] = await Promise.all([
    prisma.distributionLeadsParticipant.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        userId: true,
        status: true,
        weight: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: { name: true, email: true, avatarUrl: true, type: true },
        },
        slots: {
          orderBy: { slotIndex: "asc" },
          select: { slotIndex: true, lastAssignedAt: true },
        },
      },
    }),
    prisma.distributionLeadsAssignment.groupBy({
      by: ["userId"],
      _count: { _all: true },
    }),
  ]);
  const receivedByUser = new Map(received.map((r) => [r.userId, r._count._all]));

  return participants.map((p) => ({
    userId: p.userId,
    name: p.user.name,
    email: p.user.email,
    avatarUrl: p.user.avatarUrl,
    status: p.status,
    weight: p.weight,
    slots: p.slots.map((s) => ({
      slotIndex: s.slotIndex,
      active: p.status === "ACTIVE" && s.slotIndex < p.weight,
      lastAssignedAt: s.lastAssignedAt ? s.lastAssignedAt.toISOString() : null,
    })),
    totalReceived: receivedByUser.get(p.userId) ?? 0,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
}

/**
 * Upsert do participante + garantia dos 5 slots (criados na 1ª configuração).
 * Status/peso controlam SOMENTE recebimentos futuros — atribuições passadas
 * e `lastAssignedAt` dos slots são preservados.
 */
export async function upsertLeadsParticipant(args: {
  userId: string;
  status?: "ACTIVE" | "INACTIVE";
  weight?: number;
}): Promise<LeadsParticipantView | null> {
  const orgId = getOrgIdOrThrow();

  // Alvo precisa ser operador humano desta organização.
  const user = await prisma.user.findFirst({
    where: { id: args.userId, organizationId: orgId, type: "HUMAN" },
    select: { id: true },
  });
  if (!user) return null;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.distributionLeadsParticipant.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId: args.userId } },
      select: { id: true },
    });
    const row = await tx.distributionLeadsParticipant.upsert({
      where: { organizationId_userId: { organizationId: orgId, userId: args.userId } },
      create: {
        organizationId: orgId,
        userId: args.userId,
        status: args.status ?? "ACTIVE",
        weight: args.weight ?? 0,
      },
      update: {
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.weight !== undefined ? { weight: args.weight } : {}),
      },
      select: { id: true },
    });
    if (!existing) {
      await tx.distributionLeadsSlot.createMany({
        data: Array.from({ length: LEADS_SLOT_COUNT }, (_, slotIndex) => ({
          organizationId: orgId,
          participantId: row.id,
          slotIndex,
        })),
      });
    }
  });

  const all = await getLeadsParticipants();
  return all.find((p) => p.userId === args.userId) ?? null;
}

export interface LeadsStatsResult {
  total: number;
  byUser: { userId: string; name: string | null; count: number }[];
  /** byUser ordenado desc por count. */
  ranking: { userId: string; name: string | null; count: number }[];
}

export async function getLeadsStats(opts: {
  from?: Date;
  to?: Date;
  userId?: string;
}): Promise<LeadsStatsResult> {
  const where = {
    ...(opts.from || opts.to
      ? {
          createdAt: {
            ...(opts.from ? { gte: opts.from } : {}),
            ...(opts.to ? { lte: opts.to } : {}),
          },
        }
      : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
  };

  const [total, grouped] = await Promise.all([
    prisma.distributionLeadsAssignment.count({ where }),
    prisma.distributionLeadsAssignment.groupBy({
      by: ["userId"],
      where,
      _count: { _all: true },
    }),
  ]);

  const names = await prisma.user.findMany({
    where: { id: { in: grouped.map((g) => g.userId) } },
    select: { id: true, name: true },
  });
  const nameByUser = new Map(names.map((u) => [u.id, u.name]));

  const byUser = grouped
    .map((g) => ({
      userId: g.userId,
      name: nameByUser.get(g.userId) ?? null,
      count: g._count._all,
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
  const ranking = [...byUser].sort((a, b) => b.count - a.count);

  return { total, byUser, ranking };
}

export interface LeadsHistoryItem {
  id: string;
  createdAt: string;
  userId: string;
  userName: string | null;
  slotIndex: number;
  targetKey: string;
  contactId: string | null;
  dealId: string | null;
  conversationId: string | null;
  /** Nome/telefone do lead para exibição. */
  leadLabel: string | null;
  triggerSource: string;
}

export async function getLeadsHistory(opts: {
  from?: Date;
  to?: Date;
  userId?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<{ items: LeadsHistoryItem[]; nextCursor: string | null; total: number }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const cursor = (() => {
    if (!opts.cursor) return null;
    const [ts, id] = opts.cursor.split("_");
    const t = Number(ts);
    if (!Number.isFinite(t) || !id) return null;
    return { createdAt: new Date(t), id };
  })();

  const baseWhere = {
    ...(opts.from || opts.to
      ? {
          createdAt: {
            ...(opts.from ? { gte: opts.from } : {}),
            ...(opts.to ? { lte: opts.to } : {}),
          },
        }
      : {}),
    ...(opts.userId ? { userId: opts.userId } : {}),
  };
  const where = cursor
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          },
        ],
      }
    : baseWhere;

  const [rowsPlus, total] = await Promise.all([
    prisma.distributionLeadsAssignment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        userId: true,
        slotIndex: true,
        targetKey: true,
        contactId: true,
        dealId: true,
        conversationId: true,
        triggerSource: true,
      },
    }),
    prisma.distributionLeadsAssignment.count({ where: baseWhere }),
  ]);

  const hasMore = rowsPlus.length > limit;
  const rows = hasMore ? rowsPlus.slice(0, limit) : rowsPlus;

  const userIds = [...new Set(rows.map((r) => r.userId))];
  const contactIds = [
    ...new Set(rows.map((r) => r.contactId).filter((id): id is string => Boolean(id))),
  ];
  const [users, contacts] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    }),
    contactIds.length
      ? prisma.contact.findMany({
          where: { id: { in: contactIds } },
          select: { id: true, name: true, phone: true },
        })
      : Promise.resolve([]),
  ]);
  const nameByUser = new Map(users.map((u) => [u.id, u.name]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const items: LeadsHistoryItem[] = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    userId: r.userId,
    userName: nameByUser.get(r.userId) ?? null,
    slotIndex: r.slotIndex,
    targetKey: r.targetKey,
    contactId: r.contactId,
    dealId: r.dealId,
    conversationId: r.conversationId,
    leadLabel: r.contactId
      ? contactById.get(r.contactId)?.phone ||
        contactById.get(r.contactId)?.name ||
        null
      : null,
    triggerSource: r.triggerSource,
  }));

  const last = rows[rows.length - 1];
  const nextCursor =
    hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null;
  return { items, nextCursor, total };
}
