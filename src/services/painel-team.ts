/**
 * Painel › Atendimentos › Equipe.
 *
 * - Mapa de calor departamento × hora (conversas iniciadas).
 * - Ranking de atendimentos por atendente.
 * - Ranking de tempo médio de atendimento por atendente.
 *
 * Diferente de /api/painel/service, respeita os filtros da aba
 * (departamentos e atendentes) além do período.
 */

import { Prisma } from "@prisma/client";

import { analyticsClient, isReplicaConnectionError, tripReplica } from "@/lib/analytics";
import { localTs } from "@/lib/local-time-sql";
import { getLogger } from "@/lib/logger";
import { cachedReport } from "@/lib/report-cache";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { loadPainelHours } from "@/services/painel-hours";
import {
  PAINEL_MAX_RANGE_MS,
  clampRangeFromEnd,
  mean,
  median,
  waitMs,
  type BusinessHours,
  type ClockMode,
  type PainelRange,
} from "@/services/painel-period";

const log = getLogger("painel-team");

export type PainelBlock<T> = { ok: true; data: T } | { ok: false; error: string };

export type PainelTeamScope = {
  departmentIds: string[];
  userIds: string[];
};

export type PainelDeptHourRow = {
  key: string;
  label: string;
  total: number;
  /** 24 posições (0h–23h), contagem de conversas iniciadas. */
  hours: number[];
};

export type PainelDeptHour = {
  rows: PainelDeptHourRow[];
  /** Soma por hora de todos os departamentos (linha "Total"). */
  totals: number[];
  max: number;
  total: number;
  empty: boolean;
};

export type PainelTeamRankRow = {
  id: string;
  name: string;
  /** Conversas iniciadas no período que passaram pelo atendente. */
  attended: number;
  /** Conversas encerradas no período com o atendente responsável. */
  finished: number;
  /** Abertura → encerramento, média (relógio escolhido). */
  serviceMeanMs: number | null;
  serviceMedianMs: number | null;
  /** Quantas conversas entraram na média. */
  serviceSample: number;
};

export type PainelTransferNode = { id: string; name: string };

export type PainelTransferFlow = {
  from: PainelTransferNode;
  to: PainelTransferNode;
  /** Transferências (eventos deduplicados por minuto). */
  count: number;
  /** Conversas distintas nessa rota. */
  conversations: number;
};

export type PainelTransferSet = {
  flows: PainelTransferFlow[];
  total: number;
  /** Conversas distintas transferidas (todas as rotas). */
  conversations: number;
  empty: boolean;
};

export type PainelTransfers = {
  people: PainelTransferSet;
  departments: PainelTransferSet;
};

export type PainelTeamResult = {
  deptHour: PainelBlock<PainelDeptHour>;
  ranking: PainelBlock<{ rows: PainelTeamRankRow[]; capped: boolean }>;
  transfers: PainelBlock<PainelTransfers>;
  /** Aditivo: o período pedido passava de 90 dias e foi cortado pelo início. */
  rangeClamped: boolean;
  /** Aditivo: início efetivo (ISO) do período usado nas consultas. */
  effectiveFrom: string;
};

export const NONE_DEPT_KEY = "__none__";
const NONE_DEPT_LABEL = "Sem departamento";
/** Encerradas lidas para o tempo médio (mais recentes primeiro). */
const CLOSED_ROWS_CAP = 10_000;

const TEAM_SECTIONS = ["deptHour", "ranking", "transfers"] as const;
export type PainelTeamSection = (typeof TEAM_SECTIONS)[number];

export function parseTeamSections(raw: string | null): PainelTeamSection[] {
  if (!raw) return [...TEAM_SECTIONS];
  const asked = raw.split(",").map((s) => s.trim());
  const next = TEAM_SECTIONS.filter((s) => asked.includes(s));
  return next.length ? next : [...TEAM_SECTIONS];
}

function db() {
  return analyticsClient();
}

/** `AND conv."departmentId" IN (...)`, com "__none__" = sem departamento. */
function deptClause(alias: string, ids: string[]): Prisma.Sql {
  if (!ids.length) return Prisma.empty;
  const col = Prisma.raw(`${alias}."departmentId"`);
  const real = ids.filter((id) => id !== NONE_DEPT_KEY);
  const wantsNone = ids.includes(NONE_DEPT_KEY);
  if (real.length && wantsNone) {
    return Prisma.sql`AND (${col} IN (${Prisma.join(real)}) OR ${col} IS NULL)`;
  }
  if (wantsNone) return Prisma.sql`AND ${col} IS NULL`;
  return Prisma.sql`AND ${col} IN (${Prisma.join(real)})`;
}

function userClause(column: string, ids: string[]): Prisma.Sql {
  if (!ids.length) return Prisma.empty;
  return Prisma.sql`AND ${Prisma.raw(column)} IN (${Prisma.join(ids)})`;
}

// ---------------------------------------------------------------------------
// Departamento × hora
// ---------------------------------------------------------------------------

export type DeptHourRaw = {
  deptId: string | null;
  deptName: string | null;
  h: number;
  c: number | bigint;
};

export function buildDeptHour(raw: DeptHourRaw[]): PainelDeptHour {
  const byDept = new Map<string, PainelDeptHourRow>();
  const totals = Array.from({ length: 24 }, () => 0);
  let max = 0;
  let total = 0;
  for (const r of raw) {
    const h = Number(r.h);
    const c = Number(r.c);
    if (!Number.isInteger(h) || h < 0 || h > 23 || !(c > 0)) continue;
    const key = r.deptId || NONE_DEPT_KEY;
    const row = byDept.get(key) ?? {
      key,
      label: r.deptName || NONE_DEPT_LABEL,
      total: 0,
      hours: Array.from({ length: 24 }, () => 0),
    };
    row.hours[h] += c;
    row.total += c;
    byDept.set(key, row);
    totals[h] += c;
    total += c;
  }
  for (const row of byDept.values()) {
    for (const v of row.hours) if (v > max) max = v;
  }
  const rows = [...byDept.values()].sort((a, b) => {
    if (a.key === NONE_DEPT_KEY) return 1;
    if (b.key === NONE_DEPT_KEY) return -1;
    return b.total - a.total || a.label.localeCompare(b.label, "pt-BR");
  });
  return { rows, totals, max, total, empty: total === 0 };
}

export async function getPainelDeptHour(
  range: PainelRange,
  scope: PainelTeamScope,
): Promise<PainelDeptHour> {
  const orgId = getOrgIdOrThrow();
  const raw = await db().$queryRaw<DeptHourRaw[]>(Prisma.sql`
    SELECT conv."departmentId" AS "deptId",
           d.name AS "deptName",
           EXTRACT(HOUR FROM ${localTs('conv."createdAt"')})::int AS h,
           COUNT(*)::bigint AS c
    FROM conversations conv
    LEFT JOIN departments d ON d.id = conv."departmentId"
    WHERE conv."organizationId" = ${orgId}
      AND conv."createdAt" >= ${range.from} AND conv."createdAt" <= ${range.to}
      ${deptClause("conv", scope.departmentIds)}
      ${userClause('conv."assignedToId"', scope.userIds)}
    GROUP BY 1, 2, 3
  `);
  return buildDeptHour(raw);
}

// ---------------------------------------------------------------------------
// Rankings por atendente
// ---------------------------------------------------------------------------

export type ClosedRaw = {
  userId: string;
  createdAt: Date;
  endedAt: Date;
};

export function buildRanking(input: {
  /** Conversas distintas por atendente (já agregadas no banco). */
  load: { userId: string; attended: number | bigint }[];
  closed: ClosedRaw[];
  names: Map<string, string>;
  clock: ClockMode;
  hours: BusinessHours;
}): PainelTeamRankRow[] {
  const attended = new Map<string, number>();
  for (const r of input.load) {
    attended.set(r.userId, (attended.get(r.userId) ?? 0) + Number(r.attended));
  }
  const durations = new Map<string, number[]>();
  for (const c of input.closed) {
    const list = durations.get(c.userId) ?? [];
    list.push(waitMs(c.createdAt, c.endedAt, input.clock, input.hours));
    durations.set(c.userId, list);
  }
  const ids = new Set([...attended.keys(), ...durations.keys()]);
  const rows = [...ids].map((id) => {
    const vals = durations.get(id) ?? [];
    return {
      id,
      name: input.names.get(id) ?? "Sem nome",
      attended: attended.get(id) ?? 0,
      finished: vals.length,
      serviceMeanMs: mean(vals),
      serviceMedianMs: median(vals),
      serviceSample: vals.length,
    };
  });
  rows.sort(
    (a, b) =>
      b.attended - a.attended ||
      b.finished - a.finished ||
      a.name.localeCompare(b.name, "pt-BR"),
  );
  return rows;
}

export async function getPainelTeamRanking(
  range: PainelRange,
  clock: ClockMode,
  scope: PainelTeamScope,
): Promise<{ rows: PainelTeamRankRow[]; capped: boolean }> {
  const orgId = getOrgIdOrThrow();
  const [load, closed, hours] = await Promise.all([
    // Carga: atribuição atual + distribuição (mesma regra da tabela de atendentes).
    // Conta no banco: COUNT(DISTINCT conversa) por atendente, em vez de trazer
    // todos os pares (atendente, conversa) e deduplicar em JS. UNION ALL + DISTINCT
    // no COUNT dá o mesmo número do UNION anterior.
    db().$queryRaw<{ userId: string; attended: bigint }[]>(Prisma.sql`
      SELECT x."userId", COUNT(DISTINCT x."conversationId")::bigint AS attended FROM (
        SELECT conv."assignedToId" AS "userId", conv.id AS "conversationId"
        FROM conversations conv
        INNER JOIN users u ON u.id = conv."assignedToId"
        WHERE conv."organizationId" = ${orgId}
          AND conv."assignedToId" IS NOT NULL
          AND u.type = 'HUMAN'::"UserType"
          AND conv."createdAt" >= ${range.from} AND conv."createdAt" <= ${range.to}
          ${deptClause("conv", scope.departmentIds)}
          ${userClause('conv."assignedToId"', scope.userIds)}
        UNION ALL
        SELECT l."selectedUserId", l."conversationId"
        FROM distribution_logs l
        INNER JOIN users u ON u.id = l."selectedUserId"
        INNER JOIN conversations conv ON conv.id = l."conversationId"
        WHERE l."organizationId" = ${orgId}
          AND conv."organizationId" = ${orgId}
          AND l.success = true
          AND l."selectedUserId" IS NOT NULL
          AND u.type = 'HUMAN'::"UserType"
          AND l."createdAt" >= ${range.from} AND l."createdAt" <= ${range.to}
          ${deptClause("conv", scope.departmentIds)}
          ${userClause('l."selectedUserId"', scope.userIds)}
      ) x
      GROUP BY x."userId"
    `),
    // Tempo de atendimento: abertura → encerramento das conversas encerradas
    // no período, creditado a quem estava responsável ao encerrar. Filtra por
    // "closedAt" (índice (organizationId, closedAt)): o COALESCE com "updatedAt"
    // não usava índice e trazia de volta conversa antiga sem "closedAt" sempre
    // que o "updatedAt" mudava. Conversa encerrada sempre grava "closedAt".
    db().$queryRaw<ClosedRaw[]>(Prisma.sql`
      SELECT conv."assignedToId" AS "userId",
             conv."createdAt" AS "createdAt",
             conv."closedAt" AS "endedAt"
      FROM conversations conv
      INNER JOIN users u ON u.id = conv."assignedToId"
      WHERE conv."organizationId" = ${orgId}
        AND conv.status = 'RESOLVED'::"ConversationStatus"
        AND u.type = 'HUMAN'::"UserType"
        AND conv."closedAt" IS NOT NULL
        AND conv."closedAt" >= ${range.from}
        AND conv."closedAt" <= ${range.to}
        ${deptClause("conv", scope.departmentIds)}
        ${userClause('conv."assignedToId"', scope.userIds)}
      ORDER BY conv."closedAt" DESC
      LIMIT ${CLOSED_ROWS_CAP}
    `),
    loadPainelHours(),
  ]);

  const userIds = new Set([...load.map((r) => r.userId), ...closed.map((r) => r.userId)]);
  const users = userIds.size
    ? await db().$queryRaw<{ id: string; name: string | null }[]>(Prisma.sql`
        SELECT u.id, u.name FROM users u
        WHERE u."organizationId" = ${orgId} AND u.id IN (${Prisma.join([...userIds])})
      `)
    : [];
  const names = new Map(users.map((u) => [u.id, u.name ?? "Sem nome"]));

  const rows = buildRanking({
    load,
    closed,
    names,
    clock,
    hours,
  });
  return { rows, capped: closed.length >= CLOSED_ROWS_CAP };
}

// ---------------------------------------------------------------------------
// Transferências (pessoa → pessoa, departamento → departamento)

export type TransferRaw = {
  fromId: string | null;
  fromName: string | null;
  toId: string | null;
  toName: string | null;
  c: number | bigint;
  convs: number | bigint;
  totalConvs: number | bigint;
};

export function buildTransferSet(raw: TransferRaw[], noneLabel: string): PainelTransferSet {
  const flows: PainelTransferFlow[] = [];
  let total = 0;
  let conversations = 0;
  for (const r of raw) {
    const count = Number(r.c);
    if (!(count > 0)) continue;
    if ((r.fromId ?? null) === (r.toId ?? null)) continue;
    flows.push({
      from: { id: r.fromId ?? NONE_DEPT_KEY, name: r.fromName || noneLabel },
      to: { id: r.toId ?? NONE_DEPT_KEY, name: r.toName || noneLabel },
      count,
      conversations: Number(r.convs),
    });
    total += count;
    conversations = Math.max(conversations, Number(r.totalConvs));
  }
  flows.sort(
    (a, b) =>
      b.count - a.count ||
      a.from.name.localeCompare(b.from.name, "pt-BR") ||
      a.to.name.localeCompare(b.to.name, "pt-BR"),
  );
  return { flows, total, conversations, empty: total === 0 };
}

export async function getPainelTransfers(
  range: PainelRange,
  scope: PainelTeamScope,
): Promise<PainelTransfers> {
  const orgId = getOrgIdOrThrow();
  const needConv = scope.departmentIds.length > 0;
  const userScope = scope.userIds.length
    ? Prisma.sql`AND (uf.id IN (${Prisma.join(scope.userIds)}) OR ut.id IN (${Prisma.join(scope.userIds)}))`
    : Prisma.empty;

  // Pessoa → pessoa: só humano para humano. Entrada inicial (sem responsável
  // antes), passagem da IA e remoção de responsável não são transferência.
  // Dedupe por minuto: alguns fluxos registram o mesmo evento duas vezes.
  const people = db().$queryRaw<TransferRaw[]>(Prisma.sql`
    WITH ev AS (
      SELECT DISTINCT
        e."conversationId" AS cid,
        uf.id AS "fromId", uf.name AS "fromName",
        ut.id AS "toId", ut.name AS "toName",
        date_trunc('minute', e."occurredAt") AS m
      FROM activity_events e
      INNER JOIN users uf ON uf.id = e.meta->>'fromUserId' AND uf.type = 'HUMAN'::"UserType"
      INNER JOIN users ut ON ut.id = e.meta->>'toUserId' AND ut.type = 'HUMAN'::"UserType"
      ${needConv ? Prisma.sql`INNER JOIN conversations conv ON conv.id = e."conversationId"` : Prisma.empty}
      WHERE e."organizationId" = ${orgId}
        AND e.type = 'ASSIGNEE_CHANGED'
        AND e."entityType" = 'CONVERSATION'::"EventEntityType"
        AND e."occurredAt" >= ${range.from} AND e."occurredAt" <= ${range.to}
        AND uf.id <> ut.id
        ${needConv ? deptClause("conv", scope.departmentIds) : Prisma.empty}
        ${userScope}
    )
    SELECT "fromId", "fromName", "toId", "toName",
           COUNT(*)::bigint AS c,
           COUNT(DISTINCT cid)::bigint AS convs,
           (SELECT COUNT(DISTINCT cid) FROM ev)::bigint AS "totalConvs"
    FROM ev
    GROUP BY 1, 2, 3, 4
  `);

  // Departamento → departamento: filtro de depto vale para origem OU destino;
  // filtro de usuário = quem fez a transferência.
  const realDepts = scope.departmentIds.filter((id) => id !== NONE_DEPT_KEY);
  const wantsNone = scope.departmentIds.includes(NONE_DEPT_KEY);
  const deptParts: Prisma.Sql[] = [];
  if (realDepts.length) {
    deptParts.push(
      Prisma.sql`(e.meta->>'fromDepartmentId') IN (${Prisma.join(realDepts)})`,
      Prisma.sql`(e.meta->>'toDepartmentId') IN (${Prisma.join(realDepts)})`,
    );
  }
  if (wantsNone) {
    deptParts.push(
      Prisma.sql`(e.meta->>'fromDepartmentId') IS NULL`,
      Prisma.sql`(e.meta->>'toDepartmentId') IS NULL`,
    );
  }
  const deptScope = deptParts.length
    ? Prisma.sql`AND (${Prisma.join(deptParts, " OR ")})`
    : Prisma.empty;

  const departments = db().$queryRaw<TransferRaw[]>(Prisma.sql`
    WITH ev AS (
      SELECT DISTINCT
        e."conversationId" AS cid,
        NULLIF(e.meta->>'fromDepartmentId', '') AS "fromId",
        COALESCE(df.name, e.meta->>'fromDepartmentName') AS "fromName",
        NULLIF(e.meta->>'toDepartmentId', '') AS "toId",
        COALESCE(dt.name, e.meta->>'toDepartmentName') AS "toName",
        date_trunc('minute', e."occurredAt") AS m
      FROM activity_events e
      LEFT JOIN departments df ON df.id = e.meta->>'fromDepartmentId'
      LEFT JOIN departments dt ON dt.id = e.meta->>'toDepartmentId'
      WHERE e."organizationId" = ${orgId}
        AND e.type = 'CONVERSATION_DEPARTMENT_CHANGED'
        AND e."occurredAt" >= ${range.from} AND e."occurredAt" <= ${range.to}
        AND (e.meta->>'fromDepartmentId') IS DISTINCT FROM (e.meta->>'toDepartmentId')
        ${deptScope}
        ${userClause('e."actorUserId"', scope.userIds)}
    )
    SELECT "fromId", "fromName", "toId", "toName",
           COUNT(*)::bigint AS c,
           COUNT(DISTINCT cid)::bigint AS convs,
           (SELECT COUNT(DISTINCT cid) FROM ev)::bigint AS "totalConvs"
    FROM ev
    GROUP BY 1, 2, 3, 4
  `);

  const [p, d] = await Promise.all([people, departments]);
  return {
    people: buildTransferSet(p, "Sem responsável"),
    departments: buildTransferSet(d, NONE_DEPT_LABEL),
  };
}

// ---------------------------------------------------------------------------

const BLOCK_ERROR = "Falha ao carregar este bloco.";

/** Uma tentativa na réplica; se ela caiu, desarma a réplica e repete no primário. */
async function withReplicaRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isReplicaConnectionError(e)) throw e;
    tripReplica();
    return fn();
  }
}

/**
 * Bloco com cache (60 s fresco + 120 s vencido, ver `cachedReport`). O cache é
 * por bloco e o loader lança em caso de erro: bloco que falhou nunca vai para o
 * cache. Erro do banco não vai ao cliente: fica no log estruturado e o bloco
 * volta com mensagem genérica.
 */
async function wrap<T>(
  name: string,
  orgId: string,
  parts: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<PainelBlock<T>> {
  try {
    const data = await cachedReport(`painel_team:${name}`, orgId, parts, () =>
      withReplicaRetry(fn),
    );
    return { ok: true, data };
  } catch (e) {
    log.error({ err: e, block: name }, "[painel/team] bloco falhou");
    return { ok: false, error: BLOCK_ERROR };
  }
}

export async function getPainelTeam(
  requestedRange: PainelRange,
  clock: ClockMode,
  scope: PainelTeamScope,
  sections: PainelTeamSection[] = [...TEAM_SECTIONS],
): Promise<PainelTeamResult> {
  const orgId = getOrgIdOrThrow();
  // Teto de 90 dias, como o painel de atendimentos: mantém o fim e recua o início.
  const range = clampRangeFromEnd(requestedRange, PAINEL_MAX_RANGE_MS);
  const want = new Set(sections);
  const omit = <T,>(): PainelBlock<T> => ({ ok: false, error: "omitido" });
  // Chave por bloco: só entra o que o bloco usa (o relógio só muda o ranking).
  const base = {
    from: range.from,
    to: range.to,
    departmentIds: scope.departmentIds,
    userIds: scope.userIds,
  };
  const [deptHour, ranking, transfers] = await Promise.all([
    want.has("deptHour")
      ? wrap("deptHour", orgId, base, () => getPainelDeptHour(range, scope))
      : omit<PainelDeptHour>(),
    want.has("ranking")
      ? wrap("ranking", orgId, { ...base, clock }, () =>
          getPainelTeamRanking(range, clock, scope),
        )
      : omit<{ rows: PainelTeamRankRow[]; capped: boolean }>(),
    want.has("transfers")
      ? wrap("transfers", orgId, base, () => getPainelTransfers(range, scope))
      : omit<PainelTransfers>(),
  ]);
  return {
    deptHour,
    ranking,
    transfers,
    rangeClamped: range !== requestedRange,
    effectiveFrom: range.from.toISOString(),
  };
}
