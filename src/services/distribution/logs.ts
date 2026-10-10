/**
 * Histórico de distribuições (DistributionLog) para a aba "Logs" da tela de
 * Distribuição: quem recebeu, quando, resultado, origem e departamento.
 *
 * `DistributionLog` é org-scoped (a Prisma Extension injeta o filtro de org).
 * `User` NÃO é org-scoped → filtro manual. `Contact` é org-scoped.
 *
 * Paginação por cursor composto (`${createdAtMs}_${id}`), estável para
 * eventos no mesmo instante (createdAt desc, id desc).
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { getWaitingQueueWhere } from "./pending";

export interface DistributionLogView {
  id: string;
  createdAt: string;
  success: boolean;
  reason: string;
  triggerSource: string;
  selectedUserId: string | null;
  selectedUserName: string | null;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  conversationId: string | null;
  conversationNumber: number | null;
  departmentId: string | null;
  departmentName: string | null;
}

export interface DepartmentDistributionStat {
  departmentId: string | null;
  departmentName: string;
  /** Logs com success=true (qualquer origem) ligados a esse dept. */
  distributed: number;
  /** Destes, quantos vieram do agente IA (trigger contém AI_AGENT). */
  distributedByAi: number;
  /** Conversas OPEN sem responsável nesse dept (fila de espera). */
  pending: number;
}

const NOTE_DEPT_PREFIX = "Conversa distribuída para ";

function parseCursor(raw: string | null): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const [tsStr, id] = raw.split("_");
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !id) return null;
  return { createdAt: new Date(ts), id };
}

function normalizeDeptName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

/**
 * Resolve departamento do log com prioridade:
 * 1) snapshot no próprio DistributionLog
 * 2) Conversation.departmentId atual
 * 3) log de handoff "Conversa distribuída para {Dept}" (nota legada ou event)
 * 4) (sucesso) único departamento acadêmico do consultor selecionado
 */
async function resolveDepartmentsForLogs(
  items: Array<{
    id: string;
    conversationId: string | null;
    selectedUserId: string | null;
    success: boolean;
    departmentId: string | null;
  }>,
  orgId: string,
): Promise<Map<string, { departmentId: string | null; departmentName: string | null }>> {
  const out = new Map<
    string,
    { departmentId: string | null; departmentName: string | null }
  >();

  const departments = await prisma.department.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true },
  });
  const deptById = new Map(departments.map((d) => [d.id, d.name]));
  const deptByNormName = new Map(
    departments.map((d) => [normalizeDeptName(d.name), d]),
  );

  const needFallback: typeof items = [];
  for (const row of items) {
    if (row.departmentId && deptById.has(row.departmentId)) {
      out.set(row.id, {
        departmentId: row.departmentId,
        departmentName: deptById.get(row.departmentId) ?? null,
      });
    } else {
      needFallback.push(row);
    }
  }

  if (needFallback.length === 0) return out;

  const conversationIds = [
    ...new Set(
      needFallback
        .map((r) => r.conversationId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const conversations =
    conversationIds.length > 0
      ? await prisma.conversation.findMany({
          where: { id: { in: conversationIds } },
          select: {
            id: true,
            departmentId: true,
            department: { select: { id: true, name: true } },
          },
        })
      : [];
  const convById = new Map(conversations.map((c) => [c.id, c]));

  const stillNeed: typeof items = [];
  for (const row of needFallback) {
    const conv = row.conversationId ? convById.get(row.conversationId) : null;
    if (conv?.departmentId) {
      out.set(row.id, {
        departmentId: conv.departmentId,
        departmentName: conv.department?.name ?? deptById.get(conv.departmentId) ?? null,
      });
    } else {
      stillNeed.push(row);
    }
  }

  if (stillNeed.length === 0) return out;

  // Notas de handoff do agente (snapshot textual do departamento).
  const noteConvIds = [
    ...new Set(
      stillNeed
        .map((r) => r.conversationId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const notes =
    noteConvIds.length > 0
      ? await prisma.message.findMany({
          where: {
            conversationId: { in: noteConvIds },
            isPrivate: true,
            content: { startsWith: NOTE_DEPT_PREFIX },
            OR: [
              { messageType: "note" },
              { messageType: "event" },
              { messageType: { startsWith: "event:" } },
            ],
          },
          orderBy: { createdAt: "desc" },
          select: { conversationId: true, content: true },
        })
      : [];
  const noteDeptByConv = new Map<string, { id: string; name: string }>();
  for (const note of notes) {
    if (!note.conversationId || noteDeptByConv.has(note.conversationId)) continue;
    const raw = note.content?.slice(NOTE_DEPT_PREFIX.length).trim() ?? "";
    if (!raw || raw.toLocaleLowerCase("pt-BR").startsWith("a fila")) continue;
    const dept = deptByNormName.get(normalizeDeptName(raw));
    if (dept) noteDeptByConv.set(note.conversationId, dept);
  }

  const afterNotes: typeof items = [];
  for (const row of stillNeed) {
    const fromNote = row.conversationId
      ? noteDeptByConv.get(row.conversationId)
      : undefined;
    if (fromNote) {
      out.set(row.id, {
        departmentId: fromNote.id,
        departmentName: fromNote.name,
      });
    } else {
      afterNotes.push(row);
    }
  }

  if (afterNotes.length === 0) return out;

  // Último recurso: consultor elegível em exatamente 1 departamento.
  const deptIds = new Set(departments.map((d) => d.id));
  const userIds = [
    ...new Set(
      afterNotes
        .filter((r) => r.success && r.selectedUserId)
        .map((r) => r.selectedUserId!),
    ),
  ];
  const memberships =
    userIds.length > 0 && deptIds.size > 0
      ? await prisma.departmentMember.findMany({
          where: {
            organizationId: orgId,
            userId: { in: userIds },
            departmentId: { in: [...deptIds] },
          },
          select: { userId: true, departmentId: true },
        })
      : [];
  const deptsByUser = new Map<string, string[]>();
  for (const m of memberships) {
    const list = deptsByUser.get(m.userId) ?? [];
    list.push(m.departmentId);
    deptsByUser.set(m.userId, list);
  }

  for (const row of afterNotes) {
    const userDepts = row.selectedUserId
      ? deptsByUser.get(row.selectedUserId) ?? []
      : [];
    if (userDepts.length === 1) {
      const id = userDepts[0]!;
      out.set(row.id, {
        departmentId: id,
        departmentName: deptById.get(id) ?? null,
      });
    } else {
      out.set(row.id, { departmentId: null, departmentName: null });
    }
  }

  return out;
}

export async function getDistributionLogs(opts: {
  limit?: number;
  cursor?: string | null;
} = {}): Promise<{ items: DistributionLogView[]; nextCursor: string | null }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
  const cursor = parseCursor(opts.cursor ?? null);

  const rows = await prisma.distributionLog.findMany({
    where: cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      createdAt: true,
      success: true,
      reason: true,
      triggerSource: true,
      selectedUserId: true,
      contactId: true,
      conversationId: true,
      departmentId: true,
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  const orgId = getOrgIdOrThrow();
  const userIds = [
    ...new Set(items.map((r) => r.selectedUserId).filter(Boolean) as string[]),
  ];
  const contactIds = [
    ...new Set(items.map((r) => r.contactId).filter(Boolean) as string[]),
  ];
  const conversationIds = [
    ...new Set(items.map((r) => r.conversationId).filter(Boolean) as string[]),
  ];

  const [users, contacts, deptResolved, conversations] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds }, organizationId: orgId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    contactIds.length
      ? prisma.contact.findMany({
          where: { id: { in: contactIds } },
          select: { id: true, name: true, phone: true },
        })
      : Promise.resolve([]),
    resolveDepartmentsForLogs(items, orgId),
    conversationIds.length
      ? prisma.conversation.findMany({
          where: { id: { in: conversationIds } },
          select: { id: true, number: true },
        })
      : Promise.resolve([]),
  ]);

  const userName = new Map(users.map((u) => [u.id, u.name]));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const convNumberById = new Map(conversations.map((c) => [c.id, c.number]));

  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null;

  return {
    items: items.map((r) => {
      const contact = r.contactId ? contactById.get(r.contactId) : null;
      const dept = deptResolved.get(r.id);
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        success: r.success,
        reason: r.reason,
        triggerSource: r.triggerSource,
        selectedUserId: r.selectedUserId,
        selectedUserName: r.selectedUserId
          ? userName.get(r.selectedUserId) ?? null
          : null,
        contactId: r.contactId,
        contactName: contact?.name ?? null,
        contactPhone: contact?.phone ?? null,
        conversationId: r.conversationId,
        conversationNumber: r.conversationId
          ? convNumberById.get(r.conversationId) ?? null
          : null,
        departmentId: dept?.departmentId ?? null,
        departmentName: dept?.departmentName ?? null,
      };
    }),
    nextCursor,
  };
}

/**
 * Contadores por departamento: quantos já foram distribuídos (logs sucesso)
 * e quantos ainda aguardam na fila (OPEN sem responsável).
 */
export async function getDistributionDepartmentStats(): Promise<{
  departments: DepartmentDistributionStat[];
}> {
  const orgId = getOrgIdOrThrow();

  const [pendingGroups, successLogs, departments] = await Promise.all([
    prisma.conversation.groupBy({
      by: ["departmentId"],
      where: await getWaitingQueueWhere(),
      _count: { _all: true },
    }),
    prisma.distributionLog.findMany({
      where: { success: true },
      select: {
        id: true,
        triggerSource: true,
        conversationId: true,
        selectedUserId: true,
        success: true,
        departmentId: true,
      },
    }),
    prisma.department.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const resolved = await resolveDepartmentsForLogs(successLogs, orgId);

  /** Só conta IDs que existem nesta org — evita card fantasma "Departamento". */
  const inOrg = (departmentId: string | null): string | null =>
    departmentId && deptName.has(departmentId) ? departmentId : null;

  type Acc = {
    departmentId: string | null;
    distributed: number;
    distributedByAi: number;
    pending: number;
  };
  const byKey = new Map<string, Acc>();

  const ensure = (departmentId: string | null): Acc => {
    const key = departmentId ?? "__none__";
    let row = byKey.get(key);
    if (!row) {
      row = {
        departmentId,
        distributed: 0,
        distributedByAi: 0,
        pending: 0,
      };
      byKey.set(key, row);
    }
    return row;
  };

  for (const g of pendingGroups) {
    ensure(inOrg(g.departmentId)).pending += g._count._all;
  }

  for (const log of successLogs) {
    const deptId = inOrg(resolved.get(log.id)?.departmentId ?? null);
    const row = ensure(deptId);
    row.distributed += 1;
    if (log.triggerSource.includes("AI_AGENT")) {
      row.distributedByAi += 1;
    }
  }

  for (const d of departments) {
    ensure(d.id);
  }

  const departmentsOut: DepartmentDistributionStat[] = [...byKey.values()]
    .map((row) => ({
      departmentId: row.departmentId,
      departmentName: row.departmentId
        ? deptName.get(row.departmentId) ?? "Sem departamento"
        : "Sem departamento",
      distributed: row.distributed,
      distributedByAi: row.distributedByAi,
      pending: row.pending,
    }))
    .sort((a, b) => {
      const score = (x: DepartmentDistributionStat) =>
        x.pending + x.distributed;
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return a.departmentName.localeCompare(b.departmentName, "pt-BR");
    });

  return { departments: departmentsOut };
}
