/**
 * Aba Negócios do Painel. Tudo respeita o período, exceto Valor em aberto
 * (estado presente, rotulado "hoje").
 *
 * Funil: estoque atual por etapa (igual ao kanban). O período só entra
 * no +N de entradas, nos novos e na passagem/perda da coorte.
 */

import { Prisma, type DealStatus } from "@prisma/client";

import { analyticsClient, isReplicaConnectionError, tripReplica } from "@/lib/analytics";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { SOURCE_NONE } from "@/services/dashboard";
import { funnelMessageSql, funnelMessageWhere } from "@/services/idle-leads";
import {
  buildDealWhereFromFilters,
  type AdvancedDealFilters,
} from "@/services/kanban-filters";
import { ensureTodayDealStageSnapshot } from "@/services/painel-snapshots";
import {
  dayKeyFromDate,
  dayKeyFromSqlDate,
  eachDayKey,
  painelDelta,
  parseDay,
  periodIncludesToday,
  previousPeriod,
  round2,
  SNAPSHOT_RETENTION_DAYS,
  toNumber,
  type PainelDelta,
  type PainelRange,
} from "@/services/painel-period";
import { getLogger } from "@/lib/logger";
import type { ServerTiming } from "@/lib/server-timing";

const log = getLogger("painel-deals");

/** Replica when healthy; primary if unset or tripped after a connect timeout. */
function db() {
  return analyticsClient();
}

export type PainelDealFilters = {
  range: PainelRange;
  /** Um funil. Vazio só se a org não tiver pipeline ativo. */
  pipelineIds: string[];
  stageIds?: string[];
  tagIds?: string[];
  ownerIds?: string[];
  sources?: string[];
  /** Minutos sem mensagem de chat. Não é `stalledDays`. */
  idleMinutes?: number;
  /** "in" = cliente, "out" = consultor ou automação. Ausente = qualquer um. */
  lastMessageDirection?: "in" | "out";
  stalledDays: number;
  section?: string;
  /** Campos personalizados de negócio para cards do painel. */
  fieldIds?: string[];
};

/** Funil ativo do painel (hrefs / legado). */
export function primaryPipelineId(f: Pick<PainelDealFilters, "pipelineIds">): string {
  return f.pipelineIds[0] ?? "";
}

export type PainelBlock<T> = { ok: true; data: T } | { ok: false; error: string };

export type PainelKpi = {
  key: string;
  value: number | null;
  prevRecords: number;
  delta: PainelDelta;
  /** Present-state label, e.g. "hoje". */
  asOf?: "hoje";
};

export type PainelDealsKpis = {
  receitaGanha: PainelKpi;
  negociosGanhos: PainelKpi;
  ticketMedio: PainelKpi;
  taxaConversao: PainelKpi;
  valorEmAberto: PainelKpi;
  hasClosedInPeriod: boolean;
};

export type PainelFunnelUserRow = {
  id: string;
  name: string;
  count: number;
  value: number;
  todayDelta: number;
};

/**
 * Origem das entradas da etapa. `fromStageId: null` = criado direto na etapa;
 * `"other"` = soma do que passou do teto de itens. `fromPipelineId` só vem quando
 * a origem é de outro funil.
 */
export type PainelFunnelInflow = {
  fromStageId: string | null;
  fromStageName?: string;
  fromPipelineId?: string;
  count: number;
};

/**
 * Destino das saídas da etapa (inclui Ganho/Perdido e etapas de outro funil).
 * `"other"` = soma do que passou do teto. `toPipelineId` só vem quando o destino
 * é de outro funil.
 */
export type PainelFunnelOutflow = {
  toStageId: string;
  toStageName?: string;
  toPipelineId?: string;
  count: number;
};

export type PainelFunnelStage = {
  id: string;
  name: string;
  color: string;
  /** Negócios abertos hoje nesta etapa (estoque do kanban). */
  count: number;
  value: number;
  passThrough: number | null;
  /** Entradas na etapa no período. */
  entered: number;
  /**
   * Negócios distintos que saíram da etapa no período (STAGE_CHANGED com
   * `meta.from.id` = etapa). Conta a 1ª saída de cada negócio.
   */
  exited: number;
  /** De onde vieram as entradas; soma de `count` = `entered`. */
  inflow: PainelFunnelInflow[];
  /** Para onde foram as saídas; soma de `count` = `exited`. */
  outflow: PainelFunnelOutflow[];
  /**
   * Negócios distintos que saíram DESTA etapa para uma etapa Perdido no período
   * (STAGE_CHANGED from = etapa, to = etapa com `isLost`). Sempre ≤ `exited`.
   */
  lost: number;
  /** Entradas desde o início do dia (fuso do Painel). */
  todayDelta: number;
  byUser: PainelFunnelUserRow[];
};

export type PainelFunnel = {
  definition: "cohort";
  tooltip: string;
  stages: PainelFunnelStage[];
  empty: boolean;
  /**
   * Negócios criados no período no funil selecionado, pela etapa de criação e com
   * os mesmos filtros de `entered` (funil, responsável, etapa, etiquetas, origem).
   * Etapa de criação: `meta.stageId` do evento CREATED; sem esse evento (inbound,
   * importação, automação, IA, fulfillment), a origem do 1º STAGE_CHANGED do
   * negócio e, sem movimento, a etapa atual.
   * `count` = Σ `inflow[fromStageId=null]` das etapas abertas + `novosForaDoFunil.count`.
   */
  novos: { count: number; value: number };
  /**
   * Parte de `novos` criada direto numa etapa Ganho/Perdido (fora de `stages[]`).
   */
  novosForaDoFunil: { count: number; won: number; lost: number };
  /**
   * Etapas "Perdido" (isLost) do(s) funil(is) selecionado(s).
   * count/value: negócios que estão HOJE nessas etapas, qualquer status (igual à coluna do Kanban,
   * incluindo os já encerrados que o Kanban esconde por padrão), com os mesmos filtros estruturais do estoque
   * (responsável, etiquetas, origem, etc. — reaproveite `structuralWhere(f)` sem o filtro de status).
   * sentInPeriod: negócios distintos movidos para uma etapa isLost dentro do período
   * (deal_events.type='STAGE_CHANGED' com meta->'to'->>'id' numa etapa isLost e createdAt no período),
   * com os mesmos filtros do cálculo de entradas (`entered`).
   */
  lostStage: { count: number; value: number; sentInPeriod: number };
};

export type PainelCustomFieldCard = {
  fieldId: string;
  label: string;
  type: string;
  count: number;
  sum: number | null;
  byUser: { id: string; name: string; count: number; sum: number | null }[];
};

export type PainelEvolution = {
  available: boolean;
  reason?: "building" | "beyond_retention";
  retentionDays: number;
  retainedFrom: string | null;
  incompleteLast: boolean;
  useBars: boolean;
  stages: { id: string; name: string; color: string }[];
  points: { date: string; incomplete: boolean; byStage: Record<string, number> }[];
};

/**
 * Linha de "Ganhos por agente". Entram os usuários da org com `type = HUMAN` e
 * `isSuperAdmin = false` — o mesmo recorte de "Atendentes" no Agora. Agentes de
 * IA (`type = AI`) e a equipe EduIT ficam de fora. O schema não tem marca de
 * "usuário de sistema/integração": uma conta humana usada por integração ou
 * importação (ex.: dona de negócios importados) aparece como qualquer agente.
 */
export type PainelAgentRow = {
  id: string;
  name: string;
  /** Soma de `value` dos negócios GANHOS no período (`closedAt` no período), donos = este usuário. */
  wonValue: number;
  /** Negócios GANHOS no período. */
  wonCount: number;
  /** ganhos / (ganhos + perdidos) do período, em %; null sem fechamento. */
  conversion: number | null;
  ticket: number | null;
  /**
   * Carteira aberta AGORA: negócios com `status = OPEN` cujo dono é este usuário,
   * nos filtros estruturais do painel (funil, etapa, tag, origem). NÃO depende do
   * período nem de atividade no dia — é estoque, não "ativos hoje". O nome do
   * campo fica por compatibilidade; o rótulo certo na tela é "Em aberto".
   */
  openToday: number;
  /** Sem ganho, sem perda no período e sem negócio aberto. */
  zeroActivity: boolean;
};

export type PainelSourceRow = {
  key: string;
  label: string;
  wonCount: number;
  wonValue: number;
};

export type PainelDealException = {
  key: "no_task" | "stalled" | "overdue" | "empty_value";
  count: number;
  href: string;
  stalledDays?: number;
};

function pipelineInSql(columnSql: Prisma.Sql, ids: string[]): Prisma.Sql {
  if (!ids.length) return Prisma.empty;
  return Prisma.sql`AND ${columnSql} IN (${Prisma.join(ids)})`;
}

async function structuralWhere(
  f: PainelDealFilters,
): Promise<Prisma.DealWhereInput[]> {
  const adv: AdvancedDealFilters = {};
  if (f.pipelineIds.length === 1) adv.pipelineId = f.pipelineIds[0];
  if (f.stageIds?.length) adv.stageIds = f.stageIds;
  if (f.tagIds?.length) {
    adv.tagIds = f.tagIds;
    adv.tagMode = "any";
  }
  const owners = (f.ownerIds ?? []).filter(Boolean);
  if (owners.length) adv.ownerIds = owners;
  const conditions = await buildDealWhereFromFilters(adv);
  if (f.pipelineIds.length > 1) {
    conditions.push({ stage: { pipelineId: { in: f.pipelineIds } } });
  }
  if (f.sources?.length) {
    const real = f.sources.filter((s) => s && s !== SOURCE_NONE);
    const wantNone = f.sources.includes(SOURCE_NONE);
    const or: Prisma.DealWhereInput[] = [];
    if (real.length) or.push({ contact: { is: { source: { in: real } } } });
    if (wantNone) {
      or.push({
        OR: [
          { contactId: null },
          { contact: { is: { source: null } } },
          { contact: { is: { source: "" } } },
        ],
      });
    }
    if (or.length === 1) conditions.push(or[0]!);
    else if (or.length > 1) conditions.push({ OR: or });
  }
  return conditions;
}

function and(
  structural: Prisma.DealWhereInput[],
  extra: Prisma.DealWhereInput,
): Prisma.DealWhereInput {
  return { AND: [...structural, extra] };
}

function conversion(won: number, lost: number): number | null {
  const closed = won + lost;
  if (closed === 0) return null;
  return round2((won / closed) * 100);
}

function exceptionHref(
  key: PainelDealException["key"],
  pipelineIds: string[],
  stalledDays: number,
  pipelineNumber?: number | null,
): string {
  const sp = new URLSearchParams();
  sp.set("status", "OPEN");
  sp.set("exception", key);
  if (pipelineNumber != null) sp.set("pipeline", String(pipelineNumber));
  else if (pipelineIds.length === 1) sp.set("pipeline", pipelineIds[0]!);
  if (key === "stalled") sp.set("stalledDays", String(stalledDays));
  return `/pipeline/list?${sp.toString()}`;
}

async function loadStages(pipelineIds: string[]) {
  return db().stage.findMany({
    where: pipelineIds.length
      ? { pipelineId: { in: pipelineIds } }
      : { pipeline: { archivedAt: null } },
    orderBy: pipelineIds.length === 1
      ? { position: "asc" }
      : [{ pipeline: { createdAt: "asc" } }, { position: "asc" }],
    select: {
      id: true,
      name: true,
      color: true,
      isWon: true,
      isLost: true,
      pipelineId: true,
      position: true,
    },
  });
}

export async function getPainelDealsKpis(
  f: PainelDealFilters,
): Promise<PainelDealsKpis> {
  const structural = await structuralWhere(f);
  const prev = previousPeriod(f.range.from, f.range.to);
  const wonCond: Prisma.DealWhereInput = {
    status: "WON" as DealStatus,
    closedAt: { gte: f.range.from, lte: f.range.to },
  };
  const lostCond: Prisma.DealWhereInput = {
    status: "LOST" as DealStatus,
    closedAt: { gte: f.range.from, lte: f.range.to },
  };
  const [wonAgg, lostAgg, prevWonAgg, prevLostAgg, openAgg] = await Promise.all([
    db().deal.aggregate({
      where: and(structural, wonCond),
      _sum: { value: true },
      _count: true,
    }),
    db().deal.aggregate({
      where: and(structural, lostCond),
      _count: true,
    }),
    db().deal.aggregate({
      where: and(structural, {
        status: "WON" as DealStatus,
        closedAt: { gte: prev.from, lte: prev.to },
      }),
      _sum: { value: true },
      _count: true,
    }),
    db().deal.aggregate({
      where: and(structural, {
        status: "LOST" as DealStatus,
        closedAt: { gte: prev.from, lte: prev.to },
      }),
      _count: true,
    }),
    db().deal.aggregate({
      where: and(structural, { status: "OPEN" as DealStatus }),
      _sum: { value: true },
      _count: true,
    }),
  ]);

  const wonCount = wonAgg._count;
  const lostCount = lostAgg._count;
  const wonValue = round2(toNumber(wonAgg._sum.value));
  const prevWonCount = prevWonAgg._count;
  const prevLostCount = prevLostAgg._count;
  const prevWonValue = toNumber(prevWonAgg._sum.value);
  const ticket = wonCount > 0 ? round2(wonValue / wonCount) : null;
  const prevTicket = prevWonCount > 0 ? prevWonValue / prevWonCount : 0;
  const rate = conversion(wonCount, lostCount);
  const prevRate = conversion(prevWonCount, prevLostCount);
  const openValue = round2(toNumber(openAgg._sum.value));

  return {
    hasClosedInPeriod: wonCount + lostCount > 0,
    receitaGanha: {
      key: "receitaGanha",
      value: wonValue,
      prevRecords: prevWonCount,
      delta: painelDelta(wonValue, prevWonValue, prevWonCount),
    },
    negociosGanhos: {
      key: "negociosGanhos",
      value: wonCount,
      prevRecords: prevWonCount,
      delta: painelDelta(wonCount, prevWonCount, prevWonCount),
    },
    ticketMedio: {
      key: "ticketMedio",
      value: ticket,
      prevRecords: prevWonCount,
      delta:
        ticket == null
          ? { value: 0, hidden: true }
          : painelDelta(ticket, prevTicket, prevWonCount),
    },
    taxaConversao: {
      key: "taxaConversao",
      value: rate,
      prevRecords: prevWonCount + prevLostCount,
      delta:
        rate == null || prevRate == null
          ? { value: 0, hidden: true }
          : painelDelta(rate, prevRate, prevWonCount + prevLostCount),
    },
    valorEmAberto: {
      key: "valorEmAberto",
      value: openValue,
      prevRecords: 0,
      delta: { value: 0, hidden: true },
      asOf: "hoje",
    },
  };
}

/** Itens de origem/destino por etapa; o resto vira um item `"other"`. */
export const FUNNEL_FLOW_TOP = 8;
const FUNNEL_FLOW_OTHER = "other";

function sortFlows<T extends { count: number }>(rows: T[], key: (r: T) => string | null): T[] {
  return rows.sort((a, b) => b.count - a.count || (key(a) ?? "").localeCompare(key(b) ?? ""));
}

/** Soma por etapa de origem/destino (usado ao juntar etapas de mesmo nome). */
function mergeFlows<T extends { count: number }>(
  a: T[],
  b: T[],
  key: (r: T) => string | null,
): T[] {
  const map = new Map<string | null, T>();
  for (const r of [...a, ...b]) {
    const k = key(r);
    const prev = map.get(k);
    if (prev) map.set(k, { ...prev, count: prev.count + r.count });
    else map.set(k, { ...r });
  }
  return sortFlows([...map.values()], key);
}

/** Ordena por `count` desc e agrega o que passar de `FUNNEL_FLOW_TOP` em `"other"`. */
function capFlows<T extends { count: number }>(
  rows: T[],
  key: (r: T) => string | null,
  other: (count: number) => T,
): T[] {
  const known = sortFlows(
    rows.filter((r) => key(r) !== FUNNEL_FLOW_OTHER),
    key,
  );
  let rest = rows
    .filter((r) => key(r) === FUNNEL_FLOW_OTHER)
    .reduce((n, r) => n + r.count, 0);
  rest += known.slice(FUNNEL_FLOW_TOP).reduce((n, r) => n + r.count, 0);
  const top = known.slice(0, FUNNEL_FLOW_TOP);
  return rest > 0 ? [...top, other(rest)] : top;
}

function mergeFunnelStagesByName(stages: PainelFunnelStage[]): PainelFunnelStage[] {
  const map = new Map<string, PainelFunnelStage>();
  for (const s of stages) {
    const key = s.name.trim().toLowerCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...s,
        byUser: s.byUser.map((u) => ({ ...u })),
      });
      continue;
    }
    const prevCount = prev.count;
    const addCount = s.count;
    if (prev.passThrough != null && s.passThrough != null && prevCount + addCount > 0) {
      prev.passThrough = round2(
        (prev.passThrough * prevCount + s.passThrough * addCount) / (prevCount + addCount),
      );
    } else if (prev.passThrough == null) {
      prev.passThrough = s.passThrough;
    }
    prev.count += s.count;
    prev.value = round2(prev.value + s.value);
    prev.entered += s.entered;
    prev.exited += s.exited;
    prev.inflow = mergeFlows(prev.inflow, s.inflow, (r) => r.fromStageId);
    prev.outflow = mergeFlows(prev.outflow, s.outflow, (r) => r.toStageId);
    prev.lost += s.lost;
    prev.todayDelta += s.todayDelta;
    const users = new Map(prev.byUser.map((u) => [u.id, { ...u }]));
    for (const u of s.byUser) {
      const p = users.get(u.id);
      if (!p) users.set(u.id, { ...u });
      else {
        p.count += u.count;
        p.value = round2(p.value + u.value);
        p.todayDelta += u.todayDelta;
      }
    }
    prev.byUser = [...users.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt-BR"));
  }
  return [...map.values()];
}

export async function getPainelFunnel(f: PainelDealFilters): Promise<PainelFunnel> {
  const orgId = getOrgIdOrThrow();
  const stages = await loadStages(f.pipelineIds);
  const tooltip =
    "Estoque atual do funil, igual às colunas do kanban. O + é quem entrou na etapa no período.";
  const emptyNovos = { count: 0, value: 0 };

  if (stages.length === 0) {
    return {
      definition: "cohort",
      tooltip,
      stages: [],
      empty: true,
      novos: emptyNovos,
      novosForaDoFunil: { count: 0, won: 0, lost: 0 },
      lostStage: { count: 0, value: 0, sentInPeriod: 0 },
    };
  }

  const pipelineFilter = pipelineInSql(Prisma.sql`s."pipelineId"`, f.pipelineIds);
  const ownerFilter =
    f.ownerIds && f.ownerIds.length
      ? Prisma.sql`AND d."ownerId" IN (${Prisma.join(f.ownerIds)})`
      : Prisma.empty;
  const stageFilter =
    f.stageIds && f.stageIds.length
      ? Prisma.sql`AND x."stageId" IN (${Prisma.join(f.stageIds)})`
      : Prisma.empty;
  const tagFilter =
    f.tagIds && f.tagIds.length
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM tags_on_deals td
          WHERE td."dealId" = d.id AND td."tagId" IN (${Prisma.join(f.tagIds)})
        )`
      : Prisma.empty;
  let sourceFilter = Prisma.empty;
  if (f.sources?.length) {
    const real = f.sources.filter((s) => s && s !== SOURCE_NONE);
    const wantNone = f.sources.includes(SOURCE_NONE);
    const parts: Prisma.Sql[] = [];
    if (real.length) {
      parts.push(Prisma.sql`c.source IN (${Prisma.join(real)})`);
    }
    if (wantNone) {
      parts.push(
        Prisma.sql`d."contactId" IS NULL OR c.source IS NULL OR c.source = ''`,
      );
    }
    if (parts.length === 1) {
      sourceFilter = Prisma.sql`AND (${parts[0]})`;
    } else if (parts.length > 1) {
      sourceFilter = Prisma.sql`AND (${Prisma.join(parts, " OR ")})`;
    }
  }

  const todayStart = parseDay(dayKeyFromDate(new Date()), false)!;
  const structural = await structuralWhere(f);
  const messageWhere = funnelMessageWhere(f.idleMinutes, f.lastMessageDirection);
  const messageFilter = funnelMessageSql(f.idleMinutes, f.lastMessageDirection);
  const lostStageIds = new Set(stages.filter((s) => s.isLost).map((s) => s.id));
  // Estoque da etapa Perdido: como a coluna do kanban, qualquer status (provisório
  // até o backfill de status/closedAt dos importados).
  const [stockRows, lostAgg] = await Promise.all([
    db().deal.groupBy({
      by: ["stageId", "ownerId"],
      where: messageWhere
        ? and(structural, { AND: [{ status: "OPEN" as DealStatus }, messageWhere] })
        : and(structural, { status: "OPEN" as DealStatus }),
      _count: { _all: true },
      _sum: { value: true },
    }),
    lostStageIds.size
      ? db().deal.aggregate({
          where: messageWhere
            ? and(structural, {
                AND: [{ stageId: { in: [...lostStageIds] } }, messageWhere],
              })
            : and(structural, { stageId: { in: [...lostStageIds] } }),
          _count: { _all: true },
          _sum: { value: true },
        })
      : Promise.resolve(null),
  ]);

  const exitStageFilter =
    f.stageIds && f.stageIds.length
      ? Prisma.sql`AND x."fromStageId" IN (${Prisma.join(f.stageIds)})`
      : Prisma.empty;

  // Entradas: 1ª entrada por (negócio, etapa) no período, com a etapa de origem
  // dessa entrada (NULL quando o negócio foi criado direto na etapa). Nome e funil
  // da origem vêm da etapa atual; se ela sumiu, do que o evento gravou.
  // Saídas: 1ª saída por (negócio, etapa) no período, com o destino. Mesmos
  // filtros, aplicados à etapa de onde o negócio saiu.
  const [entered, exits] = await Promise.all([
    db().$queryRaw<
      {
        dealId: string;
        stageId: string;
        enteredAt: Date;
        value: unknown;
        ownerId: string | null;
        eventType: string;
        fromStageId: string | null;
        fromStageName: string | null;
        fromPipelineId: string | null;
      }[]
    >(Prisma.sql`
      SELECT DISTINCT ON (x."dealId", x."stageId")
        x."dealId", x."stageId", x."enteredAt", CAST(d.value AS DECIMAL) AS value,
        d."ownerId" AS "ownerId", x."eventType" AS "eventType",
        x."fromStageId" AS "fromStageId",
        COALESCE(fs.name, x."fromStageName") AS "fromStageName",
        COALESCE(fs."pipelineId", x."fromPipelineId") AS "fromPipelineId"
      FROM (
        SELECT e."dealId" AS "dealId",
               (e.meta->'to'->>'id') AS "stageId",
               e."createdAt" AS "enteredAt",
               e.type AS "eventType",
               (e.meta->'from'->>'id') AS "fromStageId",
               (e.meta->'from'->>'name') AS "fromStageName",
               (e.meta->'from'->>'pipelineId') AS "fromPipelineId"
        FROM deal_events e
        WHERE e."organizationId" = ${orgId}
          AND e.type = 'STAGE_CHANGED'
          AND e."createdAt" >= ${f.range.from}
          AND e."createdAt" <= ${f.range.to}
          AND (e.meta->'to'->>'id') IS NOT NULL
        UNION ALL
        SELECT e."dealId",
               (e.meta->>'stageId') AS "stageId",
               e."createdAt" AS "enteredAt",
               e.type AS "eventType",
               NULL, NULL, NULL
        FROM deal_events e
        WHERE e."organizationId" = ${orgId}
          AND e.type = 'CREATED'
          AND e."createdAt" >= ${f.range.from}
          AND e."createdAt" <= ${f.range.to}
          AND (e.meta->>'stageId') IS NOT NULL
        UNION ALL
        -- Criado no período sem CREATED utilizável (inbound, importação,
        -- automação, IA e fulfillment não gravam o evento): a etapa de criação
        -- é a origem do 1º STAGE_CHANGED dele; sem movimento, a etapa atual.
        SELECT d0.id,
               COALESCE(
                 (SELECT (e2.meta->'from'->>'id')
                    FROM deal_events e2
                   WHERE e2."dealId" = d0.id
                     AND e2."organizationId" = ${orgId}
                     AND e2.type = 'STAGE_CHANGED'
                     AND e2."createdAt" >= d0."createdAt"
                     AND (e2.meta->'from'->>'id') IS NOT NULL
                   ORDER BY e2."createdAt" ASC
                   LIMIT 1),
                 d0."stageId"
               ) AS "stageId",
               d0."createdAt" AS "enteredAt",
               'CREATED' AS "eventType",
               NULL, NULL, NULL
        FROM deals d0
        WHERE d0."organizationId" = ${orgId}
          AND d0."createdAt" >= ${f.range.from}
          AND d0."createdAt" <= ${f.range.to}
          AND NOT EXISTS (
            SELECT 1 FROM deal_events e3
             WHERE e3."dealId" = d0.id
               AND e3."organizationId" = ${orgId}
               AND e3.type = 'CREATED'
               AND e3."createdAt" >= ${f.range.from}
               AND e3."createdAt" <= ${f.range.to}
               AND (e3.meta->>'stageId') IS NOT NULL
          )
      ) x
      INNER JOIN deals d ON d.id = x."dealId" AND d."organizationId" = ${orgId}
      INNER JOIN stages s ON s.id = x."stageId"
      LEFT JOIN stages fs ON fs.id = x."fromStageId"
      LEFT JOIN contacts c ON c.id = d."contactId"
      WHERE 1=1
        ${pipelineFilter}
        ${ownerFilter}
        ${stageFilter}
        ${tagFilter}
        ${sourceFilter}
        ${messageFilter}
      ORDER BY x."dealId", x."stageId", x."enteredAt" ASC,
        (x."eventType" = 'CREATED') DESC
    `),
    db().$queryRaw<
      {
        dealId: string;
        fromStageId: string;
        toStageId: string;
        toStageName: string | null;
        toPipelineId: string | null;
        wentLost: boolean;
      }[]
    >(Prisma.sql`
      SELECT DISTINCT ON (x."dealId", x."fromStageId")
        x."dealId", x."fromStageId", x."toStageId",
        COALESCE(ts.name, x."toStageName") AS "toStageName",
        COALESCE(ts."pipelineId", x."toPipelineId") AS "toPipelineId",
        bool_or(COALESCE(ts."isLost", false)) OVER (PARTITION BY x."dealId", x."fromStageId") AS "wentLost"
      FROM (
        SELECT e."dealId" AS "dealId",
               (e.meta->'from'->>'id') AS "fromStageId",
               (e.meta->'to'->>'id') AS "toStageId",
               (e.meta->'to'->>'name') AS "toStageName",
               (e.meta->'to'->>'pipelineId') AS "toPipelineId",
               e."createdAt" AS "exitedAt"
        FROM deal_events e
        WHERE e."organizationId" = ${orgId}
          AND e.type = 'STAGE_CHANGED'
          AND e."createdAt" >= ${f.range.from}
          AND e."createdAt" <= ${f.range.to}
          AND (e.meta->'from'->>'id') IS NOT NULL
          AND (e.meta->'to'->>'id') IS NOT NULL
      ) x
      INNER JOIN deals d ON d.id = x."dealId" AND d."organizationId" = ${orgId}
      INNER JOIN stages s ON s.id = x."fromStageId"
      LEFT JOIN stages ts ON ts.id = x."toStageId"
      LEFT JOIN contacts c ON c.id = d."contactId"
      WHERE 1=1
        ${pipelineFilter}
        ${ownerFilter}
        ${exitStageFilter}
        ${tagFilter}
        ${sourceFilter}
        ${messageFilter}
      ORDER BY x."dealId", x."fromStageId", x."exitedAt" ASC
    `),
  ]);

  type StageBucket = {
    count: number;
    value: number;
    lost: number;
    todayDelta: number;
    dealIds: Set<string>;
    firstAt: Map<string, Date>;
    byUser: Map<string, { count: number; value: number; todayDelta: number }>;
    inflow: Map<string | null, PainelFunnelInflow>;
    exited: number;
    outflow: Map<string, PainelFunnelOutflow>;
  };
  const byStage = new Map<string, StageBucket>();
  const pipelineOfStage = new Map(stages.map((s) => [s.id, s.pipelineId]));
  type StockUser = { count: number; value: number };
  const stockByStage = new Map<string, { count: number; value: number; byUser: Map<string, StockUser> }>();
  for (const s of stages) {
    byStage.set(s.id, {
      count: 0,
      value: 0,
      lost: 0,
      todayDelta: 0,
      dealIds: new Set(),
      firstAt: new Map(),
      byUser: new Map(),
      inflow: new Map(),
      exited: 0,
      outflow: new Map(),
    });
    stockByStage.set(s.id, { count: 0, value: 0, byUser: new Map() });
  }
  for (const row of stockRows) {
    const stock = stockByStage.get(row.stageId);
    if (!stock) continue;
    const n = row._count._all;
    const v = toNumber(row._sum.value);
    stock.count += n;
    stock.value += v;
    const ownerKey = row.ownerId ?? "__none__";
    const user = stock.byUser.get(ownerKey) ?? { count: 0, value: 0 };
    user.count += n;
    user.value += v;
    stock.byUser.set(ownerKey, user);
  }

  // Novos = entradas por criação (as mesmas que viram `inflow[null]`), então
  // Σ inflow[null] das etapas abertas + novosForaDoFunil.count = novos.count.
  const stageFlags = new Map(stages.map((s) => [s.id, s]));
  const novos = { count: 0, value: 0 };
  const novosForaDoFunil = { count: 0, won: 0, lost: 0 };

  for (const row of entered) {
    const bucket = byStage.get(row.stageId);
    if (!bucket) continue;
    if (bucket.dealIds.has(row.dealId)) continue;
    bucket.dealIds.add(row.dealId);
    bucket.firstAt.set(row.dealId, row.enteredAt);
    bucket.count += 1;
    const value = toNumber(row.value);
    bucket.value += value;
    if (row.eventType === "CREATED") {
      novos.count += 1;
      novos.value += value;
      const flags = stageFlags.get(row.stageId);
      if (flags?.isWon || flags?.isLost) {
        novosForaDoFunil.count += 1;
        if (flags.isWon) novosForaDoFunil.won += 1;
        else novosForaDoFunil.lost += 1;
      }
    }
    const isToday = row.enteredAt >= todayStart;
    if (isToday) bucket.todayDelta += 1;
    const ownerKey = row.ownerId ?? "__none__";
    const user = bucket.byUser.get(ownerKey) ?? { count: 0, value: 0, todayDelta: 0 };
    user.count += 1;
    user.value += value;
    if (isToday) user.todayDelta += 1;
    bucket.byUser.set(ownerKey, user);

    // Origem desta 1ª entrada: soma de `inflow` = `entered`. Movimento sem
    // `meta.from.id` (evento antigo) cai em "other".
    const fromKey =
      row.eventType === "CREATED" ? null : (row.fromStageId ?? FUNNEL_FLOW_OTHER);
    const inflow = bucket.inflow.get(fromKey);
    if (inflow) inflow.count += 1;
    else {
      const item: PainelFunnelInflow = { fromStageId: fromKey, count: 1 };
      if (fromKey && fromKey !== FUNNEL_FLOW_OTHER) {
        if (row.fromStageName) item.fromStageName = row.fromStageName;
        if (row.fromPipelineId && row.fromPipelineId !== pipelineOfStage.get(row.stageId)) {
          item.fromPipelineId = row.fromPipelineId;
        }
      }
      bucket.inflow.set(fromKey, item);
    }
  }

  // Saídas: 1ª saída por (negócio, etapa) — soma de `outflow` = `exited`.
  // Perdas da etapa: negócios que saíram DESTA etapa para uma etapa Perdido no
  // período (qualquer saída do negócio daqui, não só a 1ª).
  for (const row of exits) {
    const bucket = byStage.get(row.fromStageId);
    if (!bucket) continue;
    bucket.exited += 1;
    if (row.wentLost) bucket.lost += 1;
    const out = bucket.outflow.get(row.toStageId);
    if (out) out.count += 1;
    else {
      const item: PainelFunnelOutflow = { toStageId: row.toStageId, count: 1 };
      if (row.toStageName) item.toStageName = row.toStageName;
      if (row.toPipelineId && row.toPipelineId !== pipelineOfStage.get(row.fromStageId)) {
        item.toPipelineId = row.toPipelineId;
      }
      bucket.outflow.set(row.toStageId, item);
    }
  }

  // Envios para Perdido no período: sai do `entered` (mesmos filtros), sem consulta
  // extra. Só STAGE_CHANGED: negócio criado direto na etapa não conta como envio
  // (o `entered` guarda a 1ª entrada por negócio+etapa; se ela for o CREATED, uma
  // volta posterior a Perdido no mesmo período também não conta).
  const sentToLost = new Set<string>();
  for (const row of entered) {
    if (row.eventType === "STAGE_CHANGED" && lostStageIds.has(row.stageId)) {
      sentToLost.add(row.dealId);
    }
  }
  const lostStage = {
    count: lostAgg?._count._all ?? 0,
    value: round2(toNumber(lostAgg?._sum.value)),
    sentInPeriod: sentToLost.size,
  };

  const laterEntries = await db().$queryRaw<
    { dealId: string; stageId: string; enteredAt: Date }[]
  >(Prisma.sql`
    SELECT e."dealId" AS "dealId",
           (e.meta->'to'->>'id') AS "stageId",
           e."createdAt" AS "enteredAt"
    FROM deal_events e
    WHERE e."organizationId" = ${orgId}
      AND e.type = 'STAGE_CHANGED'
      AND e."createdAt" >= ${f.range.from}
      AND (e.meta->'to'->>'id') IS NOT NULL
    UNION ALL
    SELECT e."dealId",
           (e.meta->>'stageId'),
           e."createdAt"
    FROM deal_events e
    WHERE e."organizationId" = ${orgId}
      AND e.type = 'CREATED'
      AND e."createdAt" >= ${f.range.from}
      AND (e.meta->>'stageId') IS NOT NULL
  `);

  const laterByDeal = new Map<string, { stageId: string; enteredAt: Date }[]>();
  for (const row of laterEntries) {
    const list = laterByDeal.get(row.dealId) ?? [];
    list.push(row);
    laterByDeal.set(row.dealId, list);
  }

  const ownerIds = new Set<string>();
  for (const bucket of byStage.values()) {
    for (const id of bucket.byUser.keys()) {
      if (id !== "__none__") ownerIds.add(id);
    }
  }
  for (const stock of stockByStage.values()) {
    for (const id of stock.byUser.keys()) {
      if (id !== "__none__") ownerIds.add(id);
    }
  }
  const users = ownerIds.size
    ? await db().user.findMany({
        where: { id: { in: [...ownerIds] } },
        select: { id: true, name: true },
      })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));

  const openStages = stages.filter((s) => !s.isWon && !s.isLost);
  const result: PainelFunnelStage[] = openStages.map((s, i) => {
    const bucket = byStage.get(s.id)!;
    const stock = stockByStage.get(s.id)!;
    const next = openStages[i + 1];
    let passThrough: number | null = null;
    if (next && bucket.count > 0) {
      let reached = 0;
      for (const dealId of bucket.dealIds) {
        const enteredA = bucket.firstAt.get(dealId);
        if (!enteredA) continue;
        const events = laterByDeal.get(dealId) ?? [];
        if (events.some((e) => e.stageId === next.id && e.enteredAt >= enteredA)) {
          reached += 1;
        }
      }
      passThrough = round2((reached / bucket.count) * 100);
    }
    const byUser: PainelFunnelUserRow[] = [...stock.byUser.entries()]
      .map(([id, u]) => ({
        id,
        name: id === "__none__" ? "Sem responsável" : (userName.get(id) ?? "Sem responsável"),
        count: u.count,
        value: round2(u.value),
        todayDelta: bucket.byUser.get(id)?.todayDelta ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt-BR"));
    return {
      id: s.id,
      name: s.name,
      color: s.color,
      count: stock.count,
      value: round2(stock.value),
      passThrough,
      entered: bucket.count,
      exited: bucket.exited,
      inflow: [...bucket.inflow.values()],
      outflow: [...bucket.outflow.values()],
      lost: bucket.lost,
      todayDelta: bucket.todayDelta,
      byUser,
    };
  });

  // O teto de itens só depois de juntar as etapas de mesmo nome (senão o "other"
  // de um funil esconderia uma origem que, somada, entraria no top).
  const merged = (f.pipelineIds.length === 1 ? result : mergeFunnelStagesByName(result)).map(
    (s) => ({
      ...s,
      inflow: capFlows(s.inflow, (r) => r.fromStageId, (count) => ({
        fromStageId: FUNNEL_FLOW_OTHER,
        count,
      })),
      outflow: capFlows(s.outflow, (r) => r.toStageId, (count) => ({
        toStageId: FUNNEL_FLOW_OTHER,
        count,
      })),
    }),
  );
  return {
    definition: "cohort",
    tooltip,
    stages: merged,
    empty: openStages.length === 0,
    novos: { count: novos.count, value: round2(novos.value) },
    novosForaDoFunil,
    lostStage,
  };
}

function isMissingSnapshotTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /42P01|deal_stage_daily_snapshots/i.test(msg);
}

export async function getPainelEvolution(
  f: PainelDealFilters,
): Promise<PainelEvolution> {
  const orgId = getOrgIdOrThrow();
  await ensureTodayDealStageSnapshot().catch((e) => {
    log.error({ err: e }, "[painel/evolution] snapshot");
  });
  const stages = (await loadStages(f.pipelineIds)).filter((s) => !s.isWon && !s.isLost);
  const days = eachDayKey(f.range.from, f.range.to);
  const useBars = days.length <= 7;
  const incompleteLast = periodIncludesToday(f.range.to);

  try {
    const oldestRows = await db().$queryRaw<{ date: Date }[]>`
      SELECT date FROM deal_stage_daily_snapshots
      WHERE "organizationId" = ${orgId}
        ${pipelineInSql(Prisma.sql`"pipelineId"`, f.pipelineIds)}
      ORDER BY date ASC
      LIMIT 1
    `;
    const oldest = oldestRows[0] ?? null;

    // `date` é coluna SQL `date`: o Prisma devolve meia-noite UTC do dia certo.
    const retainedFrom = oldest ? dayKeyFromSqlDate(oldest.date) : null;
    const askedFrom = dayKeyFromDate(f.range.from);
    const beyond =
      retainedFrom != null && askedFrom < retainedFrom
        ? true
        : !retainedFrom && days.length > 1;

    if (!oldest) {
      return {
        available: false,
        reason: "building",
        retentionDays: SNAPSHOT_RETENTION_DAYS,
        retainedFrom: null,
        incompleteLast,
        useBars,
        stages: stages.map((s) => ({ id: s.id, name: s.name, color: s.color })),
        points: [],
      };
    }

    const stageFilter =
      stages.length > 0
        ? Prisma.sql`AND "stageId" IN (${Prisma.join(stages.map((s) => s.id))})`
        : Prisma.empty;
    const rows = await db().$queryRaw<
      { date: Date; stageId: string; openCount: number }[]
    >`
      SELECT date, "stageId", "openCount"
      FROM deal_stage_daily_snapshots
      WHERE "organizationId" = ${orgId}
        AND date >= ${dayKeyFromDate(f.range.from)}::date
        AND date <= ${dayKeyFromDate(f.range.to)}::date
        ${pipelineInSql(Prisma.sql`"pipelineId"`, f.pipelineIds)}
        ${stageFilter}
    `;

  if (rows.length === 0) {
    return {
      available: false,
      reason: beyond ? "beyond_retention" : "building",
      retentionDays: SNAPSHOT_RETENTION_DAYS,
      retainedFrom,
      incompleteLast,
      useBars,
      stages: stages.map((s) => ({ id: s.id, name: s.name, color: s.color })),
      points: [],
    };
  }

  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const key = dayKeyFromSqlDate(row.date);
    const rec = byDay.get(key) ?? {};
    rec[row.stageId] = (rec[row.stageId] ?? 0) + row.openCount;
    byDay.set(key, rec);
  }

  const points = days
    .filter((d) => byDay.has(d))
    .map((date, i, arr) => ({
      date,
      incomplete: incompleteLast && i === arr.length - 1 && date === dayKeyFromDate(new Date()),
      byStage: Object.fromEntries(stages.map((s) => [s.id, byDay.get(date)?.[s.id] ?? 0])),
    }));

  return {
    available: points.length > 0,
    reason: beyond ? "beyond_retention" : undefined,
    retentionDays: SNAPSHOT_RETENTION_DAYS,
    retainedFrom,
    incompleteLast,
    useBars,
    stages: stages.map((s) => ({ id: s.id, name: s.name, color: s.color })),
    points,
  };
  } catch (e) {
    if (isMissingSnapshotTable(e)) {
      return {
        available: false,
        reason: "building",
        retentionDays: SNAPSHOT_RETENTION_DAYS,
        retainedFrom: null,
        incompleteLast,
        useBars,
        stages: stages.map((s) => ({ id: s.id, name: s.name, color: s.color })),
        points: [],
      };
    }
    throw e;
  }
}

export async function getPainelAgents(f: PainelDealFilters): Promise<PainelAgentRow[]> {
  const orgId = getOrgIdOrThrow();
  const structural = await structuralWhere({ ...f, ownerIds: undefined });
  const wonCond: Prisma.DealWhereInput = {
    status: "WON" as DealStatus,
    closedAt: { gte: f.range.from, lte: f.range.to },
  };
  const lostCond: Prisma.DealWhereInput = {
    status: "LOST" as DealStatus,
    closedAt: { gte: f.range.from, lte: f.range.to },
  };

  const [users, won, lost, open] = await Promise.all([
    // Mesmo recorte de atendentes do Agora (`painel-agora.ts`): só humanos, sem super-admin.
    db().user.findMany({
      where: { organizationId: orgId, type: "HUMAN", isSuperAdmin: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db().deal.groupBy({
      by: ["ownerId"],
      where: and(structural, wonCond),
      _count: { _all: true },
      _sum: { value: true },
    }),
    db().deal.groupBy({
      by: ["ownerId"],
      where: and(structural, lostCond),
      _count: { _all: true },
    }),
    // Carteira aberta atual (`openToday`): sem recorte de data, de propósito.
    db().deal.groupBy({
      by: ["ownerId"],
      where: and(structural, { status: "OPEN" as DealStatus }),
      _count: { _all: true },
    }),
  ]);

  const wonMap = new Map(won.map((r) => [r.ownerId, r]));
  const lostMap = new Map(lost.map((r) => [r.ownerId, r._count._all]));
  const openMap = new Map(open.map((r) => [r.ownerId, r._count._all]));

  const rows: PainelAgentRow[] = users.map((u) => {
    const w = wonMap.get(u.id);
    const wonCount = w?._count._all ?? 0;
    const wonValue = round2(toNumber(w?._sum.value));
    const lostCount = lostMap.get(u.id) ?? 0;
    const openToday = openMap.get(u.id) ?? 0;
    const conv = conversion(wonCount, lostCount);
    return {
      id: u.id,
      name: u.name,
      wonValue,
      wonCount,
      conversion: conv,
      ticket: wonCount > 0 ? round2(wonValue / wonCount) : null,
      openToday,
      zeroActivity: wonCount === 0 && lostCount === 0 && openToday === 0,
    };
  });

  rows.sort((a, b) => {
    if (a.zeroActivity !== b.zeroActivity) return a.zeroActivity ? 1 : -1;
    return b.wonValue - a.wonValue || b.wonCount - a.wonCount || a.name.localeCompare(b.name, "pt-BR");
  });
  return rows;
}

export async function getPainelSources(f: PainelDealFilters): Promise<PainelSourceRow[]> {
  const structural = await structuralWhere(f);
  const won = await db().deal.findMany({
    where: and(structural, {
      status: "WON" as DealStatus,
      closedAt: { gte: f.range.from, lte: f.range.to },
    }),
    select: { value: true, contact: { select: { source: true } } },
  });

  const buckets = new Map<string, PainelSourceRow>();
  for (const row of won) {
    const raw = row.contact?.source?.trim();
    const key = raw ? raw : SOURCE_NONE;
    const label = raw ? raw : "Sem origem";
    const b = buckets.get(key) ?? { key, label, wonCount: 0, wonValue: 0 };
    b.wonCount += 1;
    b.wonValue += toNumber(row.value);
    buckets.set(key, b);
  }

  const sorted = [...buckets.values()].sort((a, b) => b.wonValue - a.wonValue);
  if (sorted.length <= 8) {
    return sorted.map((r) => ({ ...r, wonValue: round2(r.wonValue) }));
  }
  const head = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  head.push({
    key: "__outras__",
    label: "Outras",
    wonCount: rest.reduce((s, r) => s + r.wonCount, 0),
    wonValue: round2(rest.reduce((s, r) => s + r.wonValue, 0)),
  });
  return head.map((r) => ({ ...r, wonValue: round2(r.wonValue) }));
}

export async function getPainelDealExceptions(
  f: PainelDealFilters,
): Promise<PainelDealException[]> {
  const structural = await structuralWhere(f);
  const now = new Date();
  const todayStart = parseDay(dayKeyFromDate(now), false)!;
  const stalledBefore = new Date(now.getTime() - f.stalledDays * 86_400_000);
  const open = { status: "OPEN" as DealStatus };

  const [noTask, stalled, overdue, emptyValue] = await Promise.all([
    db().deal
      .count({
        where: and(structural, {
          ...open,
          activities: { none: { completed: false, scheduledAt: { gte: now } } },
        }),
      })
      .catch((e) => {
        log.error({ err: e }, "[painel/deals] no_task");
        return 0;
      }),
    db().deal.count({
      where: and(structural, { ...open, updatedAt: { lt: stalledBefore } }),
    }),
    db().deal.count({
      where: and(structural, { ...open, expectedClose: { lt: todayStart } }),
    }),
    db().deal.count({
      where: and(structural, { ...open, value: { lte: 0 } }),
    }),
  ]);

  let pipelineNumber: number | null = null;
  const onlyId = primaryPipelineId(f);
  if (f.pipelineIds.length === 1 && onlyId) {
    try {
      const pipe = await db().pipeline.findUnique({
        where: { id: onlyId },
        select: { id: true, number: true },
      });
      pipelineNumber = pipe?.number ?? null;
    } catch {
      pipelineNumber = null;
    }
  }
  const href = (key: PainelDealException["key"]) =>
    exceptionHref(key, f.pipelineIds, f.stalledDays, pipelineNumber);

  return [
    { key: "no_task", count: noTask, href: href("no_task") },
    { key: "stalled", count: stalled, href: href("stalled"), stalledDays: f.stalledDays },
    { key: "overdue", count: overdue, href: href("overdue") },
    { key: "empty_value", count: emptyValue, href: href("empty_value") },
  ];
}

export type PainelDealsResult = {
  kpis: PainelBlock<PainelDealsKpis>;
  funnel: PainelBlock<PainelFunnel>;
  evolution: PainelBlock<PainelEvolution>;
  agents: PainelBlock<PainelAgentRow[]>;
  sources: PainelBlock<PainelSourceRow[]>;
  exceptions: PainelBlock<PainelDealException[]>;
  customFields?: PainelBlock<PainelCustomFieldCard[]>;
};

function parseNumericField(raw: string): number | null {
  const n = Number(String(raw).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export async function getPainelCustomFieldCards(
  f: PainelDealFilters,
  fieldIds: string[],
): Promise<PainelCustomFieldCard[]> {
  if (!fieldIds.length) return [];
  const orgId = getOrgIdOrThrow();
  const fields = await db().customField.findMany({
    where: { id: { in: fieldIds }, organizationId: orgId, entity: "deal" },
    select: { id: true, label: true, type: true },
  });
  if (!fields.length) return [];
  const structural = await structuralWhere(f);
  const periodDeal: Prisma.DealWhereInput = {
    OR: [
      { createdAt: { gte: f.range.from, lte: f.range.to } },
      { closedAt: { gte: f.range.from, lte: f.range.to } },
    ],
  };
  const values = await db().dealCustomFieldValue.findMany({
    where: {
      organizationId: orgId,
      customFieldId: { in: fields.map((x) => x.id) },
      value: { not: "" },
      deal: and(structural, periodDeal),
    },
    select: {
      customFieldId: true,
      value: true,
      deal: { select: { ownerId: true, owner: { select: { id: true, name: true } } } },
    },
  });

  return fields.map((field) => {
    const rows = values.filter((v) => v.customFieldId === field.id);
    const numeric = field.type === "NUMBER";
    const byUser = new Map<string, { name: string; count: number; sum: number }>();
    let sum = 0;
    let summable = 0;
    for (const row of rows) {
      const ownerId = row.deal.ownerId ?? "__none__";
      const name = row.deal.owner?.name ?? "Sem responsável";
      const u = byUser.get(ownerId) ?? { name, count: 0, sum: 0 };
      u.count += 1;
      if (numeric) {
        const n = parseNumericField(row.value);
        if (n != null) {
          u.sum += n;
          sum += n;
          summable += 1;
        }
      }
      byUser.set(ownerId, u);
    }
    return {
      fieldId: field.id,
      label: field.label,
      type: field.type,
      count: rows.length,
      sum: numeric && summable > 0 ? round2(sum) : null,
      byUser: [...byUser.entries()]
        .map(([id, u]) => ({
          id,
          name: u.name,
          count: u.count,
          sum: numeric ? round2(u.sum) : null,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt-BR")),
    };
  });
}

async function wrap<T>(fn: () => Promise<T>): Promise<PainelBlock<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (isReplicaConnectionError(e)) {
      tripReplica();
      try {
        return { ok: true, data: await fn() };
      } catch (retryErr) {
        log.error({ err: retryErr }, "[painel/deals] falhou");
        return {
          ok: false,
          error: retryErr instanceof Error ? retryErr.message : "Falha ao carregar este bloco.",
        };
      }
    }
    log.error({ err: e }, "[painel/deals] falhou");
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Falha ao carregar este bloco.",
    };
  }
}

const DEAL_SECTIONS = [
  "kpis",
  "funnel",
  "evolution",
  "agents",
  "sources",
  "exceptions",
  "customFields",
] as const;
export type PainelDealSection = (typeof DEAL_SECTIONS)[number];

export function parseDealSections(raw: string | null): PainelDealSection[] {
  if (!raw) return [...DEAL_SECTIONS];
  const asked = raw.split(",").map((s) => s.trim()) as PainelDealSection[];
  const next = asked.filter((s): s is PainelDealSection =>
    (DEAL_SECTIONS as readonly string[]).includes(s),
  );
  return next.length ? next : [...DEAL_SECTIONS];
}

export async function getPainelDeals(
  f: PainelDealFilters,
  sections: PainelDealSection[] = [...DEAL_SECTIONS],
  timing?: ServerTiming,
): Promise<PainelDealsResult> {
  const want = new Set(sections);
  // `Server-Timing`: uma fase `q-<bloco>` por bloco que rodou. Os blocos rodam em
  // paralelo: as fases se sobrepõem e a soma passa do `total`. Sem cache.
  const run = <T,>(block: PainelDealSection, fn: () => Promise<T>) =>
    wrap(() => (timing ? timing.time(`q-${block}`, fn) : fn()));
  const [kpis, funnel, evolution, agents, sources, exceptions, customFields] =
    await Promise.all([
      want.has("kpis")
        ? run("kpis", () => getPainelDealsKpis(f))
        : Promise.resolve({ ok: false, error: "omitido" } as PainelBlock<PainelDealsKpis>),
      want.has("funnel")
        ? run("funnel", () => getPainelFunnel(f))
        : Promise.resolve({ ok: false, error: "omitido" } as PainelBlock<PainelFunnel>),
      want.has("evolution")
        ? run("evolution", () => getPainelEvolution(f))
        : Promise.resolve({ ok: false, error: "omitido" } as PainelBlock<PainelEvolution>),
      want.has("agents")
        ? run("agents", () => getPainelAgents(f))
        : Promise.resolve({ ok: false, error: "omitido" } as PainelBlock<PainelAgentRow[]>),
      want.has("sources")
        ? run("sources", () => getPainelSources(f))
        : Promise.resolve({ ok: false, error: "omitido" } as PainelBlock<PainelSourceRow[]>),
      want.has("exceptions")
        ? run("exceptions", () => getPainelDealExceptions(f))
        : Promise.resolve({ ok: false, error: "omitido" } as PainelBlock<PainelDealException[]>),
      want.has("customFields") && (f.fieldIds?.length ?? 0) > 0
        ? run("customFields", () => getPainelCustomFieldCards(f, f.fieldIds ?? []))
        : Promise.resolve(
            (f.fieldIds?.length
              ? { ok: false, error: "omitido" }
              : { ok: true, data: [] }) as PainelBlock<PainelCustomFieldCard[]>,
          ),
    ]);
  return { kpis, funnel, evolution, agents, sources, exceptions, customFields };
}
