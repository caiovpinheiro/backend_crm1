import { Prisma } from "@prisma/client";

import { analyticsClient } from "@/lib/analytics";
import { getOrgIdOrThrow } from "@/lib/request-context";

export type TabulationAnalyticsFilters = {
  from: Date;
  to: Date;
  actorUserId?: string | null;
  actorUserIds?: string[] | null;
  departmentId?: string | null;
  departmentIds?: string[] | null;
  tabulationId?: string | null;
  page?: number;
  perPage?: number;
};

function uniqueIds(...groups: Array<string | string[] | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    const list = Array.isArray(group) ? group : group ? [group] : [];
    for (const raw of list) {
      const id = raw.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

export type TabulationAnalyticsRow = {
  id: string;
  occurredAt: string;
  conversationId: string | null;
  contactId: string | null;
  contactName: string | null;
  actorUserId: string | null;
  actorName: string | null;
  tabulationId: string | null;
  tabulationName: string | null;
  tabulationNumber: number | null;
  tabulationPath: string | null;
  departmentId: string | null;
  departmentName: string | null;
};

export type TabulationTopItem = {
  tabulationId: string;
  name: string;
  number: number | null;
  path: string;
  /**
   * O ranking agrupa por `tabulationId`, então a mesma folha criada em varios
   * departamentos (ex.: "Sem Resposta" em Acolhimento, SAC e Retencao) rende
   * uma linha por departamento — com `path` identico quando a folha esta na
   * raiz. Sem o departamento as linhas ficam indistinguiveis na tela.
   *
   * O `departmentId` acompanha o nome porque o painel usa a linha do ranking
   * como atalho pro filtro de departamento.
   */
  departmentId: string | null;
  departmentName: string | null;
  count: number;
};

export type TabulationByUserItem = {
  userId: string;
  name: string;
  count: number;
};

export type TabulationAnalyticsResult = {
  total: number;
  page: number;
  perPage: number;
  /**
   * Cardinalidade real no período. `byTabulation`/`byUser` são rankings
   * truncados no top 20 — usar `.length` deles como KPI trava o número em 20.
   */
  distinctTabulations: number;
  distinctUsers: number;
  byTabulation: TabulationTopItem[];
  byUser: TabulationByUserItem[];
  items: TabulationAnalyticsRow[];
};

const TOP_LIMIT = 20;

function metaString(
  meta: Prisma.JsonValue | null | undefined,
  key: string,
): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function metaNumber(
  meta: Prisma.JsonValue | null | undefined,
  key: string,
): number | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const v = (meta as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

async function buildPathMap(
  tabulationIds: string[],
): Promise<
  Map<string, { name: string; path: string; departmentId: string | null; number: number | null }>
> {
  const map = new Map<
    string,
    { name: string; path: string; departmentId: string | null; number: number | null }
  >();
  if (tabulationIds.length === 0) return map;

  const orgId = getOrgIdOrThrow();
  const rows = await analyticsClient().tabulation.findMany({
    where: { organizationId: orgId, id: { in: tabulationIds } },
    select: {
      id: true,
      name: true,
      number: true,
      parentId: true,
      departmentId: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Sobe a árvore para montar o path (pode precisar de pais fora do set).
  const missingParents = new Set<string>();
  for (const r of rows) {
    let p = r.parentId;
    while (p && !byId.has(p)) {
      missingParents.add(p);
      break;
    }
  }
  if (missingParents.size > 0) {
    const parents = await analyticsClient().tabulation.findMany({
      where: { organizationId: orgId, id: { in: [...missingParents] } },
      select: { id: true, name: true, number: true, parentId: true, departmentId: true },
    });
    for (const p of parents) byId.set(p.id, p);
    // Uma passagem a mais costuma bastar; completa cadeia se necessário.
    let guard = 0;
    while (guard++ < 8) {
      const more = new Set<string>();
      for (const r of byId.values()) {
        if (r.parentId && !byId.has(r.parentId)) more.add(r.parentId);
      }
      if (more.size === 0) break;
      const extra = await analyticsClient().tabulation.findMany({
        where: { organizationId: orgId, id: { in: [...more] } },
        select: { id: true, name: true, number: true, parentId: true, departmentId: true },
      });
      if (extra.length === 0) break;
      for (const e of extra) byId.set(e.id, e);
    }
  }

  for (const id of tabulationIds) {
    const names: string[] = [];
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = byId.get(cursor);
      if (!node) break;
      names.unshift(node.name);
      cursor = node.parentId;
    }
    const leaf = byId.get(id);
    map.set(id, {
      name: leaf?.name ?? id,
      path: names.join(" › ") || id,
      departmentId: leaf?.departmentId ?? null,
      number: leaf?.number ?? null,
    });
  }
  return map;
}

export async function getTabulationAnalytics(
  filters: TabulationAnalyticsFilters,
): Promise<TabulationAnalyticsResult> {
  const orgId = getOrgIdOrThrow();
  const page = Math.max(1, filters.page ?? 1);
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 25));
  const actorUserIds = uniqueIds(filters.actorUserIds, filters.actorUserId);
  const departmentIds = uniqueIds(filters.departmentIds, filters.departmentId);

  // Agregação no Postgres. A versão anterior puxava até 5000 eventos e
  // contava em memória: acima disso o "total" simplesmente parava de crescer,
  // sem aviso, e os filtros de meta rodavam DEPOIS do corte.
  const conds: Prisma.Sql[] = [
    Prisma.sql`"organizationId" = ${orgId}`,
    Prisma.sql`"type" = 'CONVERSATION_TABULATED'`,
    Prisma.sql`"occurredAt" >= ${filters.from}`,
    Prisma.sql`"occurredAt" <= ${filters.to}`,
  ];
  if (actorUserIds.length === 1) {
    conds.push(Prisma.sql`"actorUserId" = ${actorUserIds[0]}`);
  } else if (actorUserIds.length > 1) {
    conds.push(Prisma.sql`"actorUserId" IN (${Prisma.join(actorUserIds)})`);
  }
  if (departmentIds.length === 1) {
    conds.push(Prisma.sql`meta->>'departmentId' = ${departmentIds[0]}`);
  } else if (departmentIds.length > 1) {
    conds.push(Prisma.sql`meta->>'departmentId' IN (${Prisma.join(departmentIds)})`);
  }
  if (filters.tabulationId) {
    conds.push(Prisma.sql`meta->>'tabulationId' = ${filters.tabulationId}`);
  }
  const whereSql = Prisma.join(conds, " AND ");

  const metaAnd: Prisma.ActivityEventWhereInput[] = [];
  if (departmentIds.length === 1) {
    metaAnd.push({
      meta: { path: ["departmentId"], equals: departmentIds[0] },
    });
  } else if (departmentIds.length > 1) {
    metaAnd.push({
      OR: departmentIds.map((id) => ({
        meta: { path: ["departmentId"], equals: id },
      })),
    });
  }
  if (filters.tabulationId) {
    metaAnd.push({
      meta: { path: ["tabulationId"], equals: filters.tabulationId },
    });
  }

  const [totals, tabRows, userRows, pageItems] = await Promise.all([
    analyticsClient().$queryRaw<
      { total: bigint; distinct_tabulations: bigint; distinct_users: bigint }[]
    >(Prisma.sql`
      SELECT COUNT(*)::bigint AS total,
             COUNT(DISTINCT meta->>'tabulationId')::bigint AS distinct_tabulations,
             COUNT(DISTINCT "actorUserId")::bigint AS distinct_users
      FROM "activity_events"
      WHERE ${whereSql}
    `),
    analyticsClient().$queryRaw<{ id: string; count: bigint }[]>(Prisma.sql`
      SELECT meta->>'tabulationId' AS id, COUNT(*)::bigint AS count
      FROM "activity_events"
      WHERE ${whereSql} AND meta->>'tabulationId' IS NOT NULL
      GROUP BY 1
      ORDER BY count DESC
      LIMIT ${TOP_LIMIT}
    `),
    analyticsClient().$queryRaw<{ id: string; count: bigint }[]>(Prisma.sql`
      SELECT "actorUserId" AS id, COUNT(*)::bigint AS count
      FROM "activity_events"
      WHERE ${whereSql} AND "actorUserId" IS NOT NULL
      GROUP BY 1
      ORDER BY count DESC
      LIMIT ${TOP_LIMIT}
    `),
    analyticsClient().activityEvent.findMany({
      where: {
        organizationId: orgId,
        type: "CONVERSATION_TABULATED",
        occurredAt: { gte: filters.from, lte: filters.to },
        ...(actorUserIds.length === 1
          ? { actorUserId: actorUserIds[0] }
          : actorUserIds.length > 1
            ? { actorUserId: { in: actorUserIds } }
            : {}),
        ...(metaAnd.length > 0 ? { AND: metaAnd } : {}),
      },
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        occurredAt: true,
        conversationId: true,
        contactId: true,
        actorUserId: true,
        meta: true,
        actorUser: { select: { id: true, name: true } },
        contact: { select: { id: true, name: true } },
      },
    }),
  ]);

  const total = Number(totals[0]?.total ?? 0);
  const distinctTabulations = Number(totals[0]?.distinct_tabulations ?? 0);
  const distinctUsers = Number(totals[0]?.distinct_users ?? 0);

  const userNames = new Map<string, string>();
  if (userRows.length > 0) {
    const users = await analyticsClient().user.findMany({
      where: { id: { in: userRows.map((r) => r.id) } },
      select: { id: true, name: true },
    });
    for (const u of users) userNames.set(u.id, u.name ?? "Usuário");
  }

  // O ranking é top 20, mas a página do log pode citar tabulações fora dele —
  // o pathMap precisa cobrir os dois conjuntos.
  const allTabIds = [
    ...new Set([
      ...tabRows.map((r) => r.id),
      ...pageItems
        .map((e) => metaString(e.meta, "tabulationId"))
        .filter((id): id is string => Boolean(id)),
    ]),
  ];
  const pathMap = await buildPathMap(allTabIds);

  const deptIds = [
    ...new Set(
      [...pathMap.values()]
        .map((v) => v.departmentId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const depts =
    deptIds.length > 0
      ? await analyticsClient().department.findMany({
          where: { organizationId: orgId, id: { in: deptIds } },
          select: { id: true, name: true },
        })
      : [];
  const deptNameById = new Map(depts.map((d) => [d.id, d.name]));

  const byTabulation: TabulationTopItem[] = tabRows.map((r) => {
    const info = pathMap.get(r.id);
    // Departamento da propria tabulacao (e nao o do evento): o ranking agrupa
    // por folha, e a folha pertence a uma arvore so.
    const deptId = info?.departmentId ?? null;
    return {
      tabulationId: r.id,
      name: info?.name ?? r.id,
      number: info?.number ?? null,
      path: info?.path ?? r.id,
      departmentId: deptId,
      departmentName: deptId ? (deptNameById.get(deptId) ?? null) : null,
      count: Number(r.count),
    };
  });

  const byUser: TabulationByUserItem[] = userRows.map((r) => ({
    userId: r.id,
    name: userNames.get(r.id) ?? "Usuário",
    count: Number(r.count),
  }));

  const items: TabulationAnalyticsRow[] = pageItems.map((e) => {
    const tabulationId = metaString(e.meta, "tabulationId");
    const departmentId =
      metaString(e.meta, "departmentId") ??
      (tabulationId ? pathMap.get(tabulationId)?.departmentId ?? null : null);
    const info = tabulationId ? pathMap.get(tabulationId) : null;
    return {
      id: e.id,
      occurredAt: e.occurredAt.toISOString(),
      conversationId: e.conversationId,
      contactId: e.contactId,
      contactName: e.contact?.name ?? null,
      actorUserId: e.actorUserId,
      actorName: e.actorUser?.name ?? null,
      tabulationId,
      tabulationName:
        info?.name ?? metaString(e.meta, "tabulationName") ?? null,
      tabulationNumber:
        info?.number ?? metaNumber(e.meta, "tabulationNumber"),
      tabulationPath: info?.path ?? null,
      departmentId,
      departmentName: departmentId
        ? (deptNameById.get(departmentId) ?? null)
        : null,
    };
  });

  return {
    total,
    page,
    perPage,
    distinctTabulations,
    distinctUsers,
    byTabulation,
    byUser,
    items,
  };
}
