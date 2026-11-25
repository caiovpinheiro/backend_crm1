/**
 * "Informação rastreada" do lead no MCP (escopo `tracking:read`).
 *
 * Só admin e gestor: operador (`env.ownOnly`) nunca recebe o bloco nem pode
 * filtrar por campanha/anúncio, mesmo com o escopo ligado e mesmo sendo o
 * responsável do negócio.
 *
 * Sai: UTMs, referrer, anúncio Meta/CTWA (título, ids e nomes resolvidos de
 * campanha/conjunto/anúncio) e TikTok. NÃO sai: identificadores de clique
 * por pessoa (`adCtwaClid`, `gclid`, `fbclid`, `googleClientId`).
 *
 * Os campos ficam no Contato (`contact-tracking-fields.ts`); o negócio herda
 * o rastreio do contato, como no painel do CRM.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { DashboardFilters } from "@/services/dashboard";

import type { ToolEnv } from "./tools";

/** Pode ver rastreio: escopo concedido e não é operador. */
export function canSeeTracking(env: Pick<ToolEnv, "ownOnly" | "scopes">): boolean {
  return !env.ownOnly && env.scopes.includes("tracking:read");
}

export const TRACKING_SELECT = {
  id: true,
  adUtmSource: true,
  adUtmMedium: true,
  adUtmCampaign: true,
  adUtmContent: true,
  adUtmTerm: true,
  utmId: true,
  utmReferrer: true,
  referrer: true,
  adHeadline: true,
  adSourceId: true,
  adSourceType: true,
  adResolvedId: true,
  adResolvedName: true,
  adResolvedAdsetId: true,
  adResolvedAdsetName: true,
  adResolvedCampaignId: true,
  adResolvedCampaignName: true,
  ttadId: true,
  ttadName: true,
} as const;

type TrackingRow = Prisma.ContactGetPayload<{ select: typeof TRACKING_SELECT }>;

function compact<T extends Record<string, unknown>>(o: T): Partial<T> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? (out as Partial<T>) : null;
}

export function trackingOut(c: TrackingRow) {
  const utm = compact({
    source: c.adUtmSource,
    medium: c.adUtmMedium,
    campaign: c.adUtmCampaign,
    content: c.adUtmContent,
    term: c.adUtmTerm,
    id: c.utmId,
    referrer: c.utmReferrer,
  });
  const meta = compact({
    headline: c.adHeadline,
    adId: c.adResolvedId ?? c.adSourceId,
    sourceId: c.adSourceId,
    sourceType: c.adSourceType,
    adName: c.adResolvedName,
    adsetId: c.adResolvedAdsetId,
    adsetName: c.adResolvedAdsetName,
    campaignId: c.adResolvedCampaignId,
    campaignName: c.adResolvedCampaignName,
  });
  const tiktok = compact({ adId: c.ttadId, adName: c.ttadName });
  const referrer = c.referrer?.trim() ? c.referrer : null;
  return { utm, referrer, meta, tiktok };
}

/** Rastreio por contato. `null` = recurso indisponível para este usuário. */
export async function loadTracking(
  env: Pick<ToolEnv, "ownOnly" | "scopes">,
  contactIds: (string | null | undefined)[],
): Promise<Map<string, ReturnType<typeof trackingOut>> | null> {
  if (!canSeeTracking(env)) return null;
  const ids = [...new Set(contactIds.filter((v): v is string => Boolean(v)))];
  const out = new Map<string, ReturnType<typeof trackingOut>>();
  if (ids.length === 0) return out;
  const rows = await prisma.contact.findMany({ where: { id: { in: ids } }, select: TRACKING_SELECT });
  for (const r of rows) out.set(r.id, trackingOut(r));
  return out;
}

export type TrackingFilterArgs = {
  utmSource?: string;
  utmCampaign?: string;
  utmMedium?: string;
  adId?: string;
  adCampaign?: string;
};

export function hasTrackingFilter(a: TrackingFilterArgs): boolean {
  return Boolean(a.utmSource || a.utmCampaign || a.utmMedium || a.adId || a.adCampaign);
}

/** Filtro de negócios pelo rastreio do contato (igualdade, sem maiúsc./minúsc.). */
export function trackingDealWhere(a: TrackingFilterArgs): Prisma.DealWhereInput | null {
  const eq = (v: string) => ({ equals: v.trim(), mode: "insensitive" as const });
  const c: Prisma.ContactWhereInput[] = [];
  if (a.utmSource) c.push({ adUtmSource: eq(a.utmSource) });
  if (a.utmMedium) c.push({ adUtmMedium: eq(a.utmMedium) });
  if (a.utmCampaign) c.push({ adUtmCampaign: eq(a.utmCampaign) });
  if (a.adId) c.push({ OR: [{ adResolvedId: a.adId.trim() }, { adSourceId: a.adId.trim() }] });
  if (a.adCampaign) {
    c.push({
      OR: [
        { adResolvedCampaignName: eq(a.adCampaign) },
        { adResolvedCampaignId: a.adCampaign.trim() },
      ],
    });
  }
  return c.length ? { contact: { is: { AND: c } } } : null;
}

type GroupRow = {
  key: string;
  source: string | null;
  deals: bigint;
  open: bigint;
  won: bigint;
  lost: bigint;
  won_value: Prisma.Decimal | number | null;
};

/**
 * Negócios criados no período agrupados por campanha e por anúncio, com as
 * MESMAS travas do dashboard (funil/etapa por papel, funis do usuário, dono
 * quando o gestor só vê os próprios). Campanha = nome resolvido da Meta;
 * sem ele, `utm_campaign`. Anúncio = nome resolvido; sem ele, o título.
 */
export async function salesByCampaign(
  organizationId: string,
  range: { from: Date; to: Date },
  pipelineId: string,
  scoped: Omit<DashboardFilters, "from" | "to" | "pipelineId">,
) {
  const where: Prisma.Sql[] = [
    Prisma.sql`d."organizationId" = ${organizationId}`,
    Prisma.sql`d."createdAt" >= ${range.from}`,
    Prisma.sql`d."createdAt" <= ${range.to}`,
    Prisma.sql`p."archivedAt" IS NULL`,
  ];
  if (pipelineId) where.push(Prisma.sql`s."pipelineId" = ${pipelineId}`);
  if (scoped.excludePipelineIds?.length) where.push(Prisma.sql`s."pipelineId" NOT IN (${Prisma.join(scoped.excludePipelineIds)})`);
  if (scoped.excludeStageIds?.length) where.push(Prisma.sql`d."stageId" NOT IN (${Prisma.join(scoped.excludeStageIds)})`);
  if (scoped.allowStageIds?.length) where.push(Prisma.sql`d."stageId" IN (${Prisma.join(scoped.allowStageIds)})`);
  if (scoped.ownerIds?.length) where.push(Prisma.sql`d."ownerId" IN (${Prisma.join(scoped.ownerIds)})`);
  const cond = Prisma.join(where, " AND ");

  const grouped = (keyExpr: Prisma.Sql) => prisma.$queryRaw<GroupRow[]>`
    SELECT ${keyExpr} AS "key",
           MIN(NULLIF(c."ad_utm_source", '')) AS "source",
           COUNT(*)::bigint AS "deals",
           COUNT(*) FILTER (WHERE d."status" = 'OPEN')::bigint AS "open",
           COUNT(*) FILTER (WHERE d."status" = 'WON')::bigint AS "won",
           COUNT(*) FILTER (WHERE d."status" = 'LOST')::bigint AS "lost",
           COALESCE(SUM(d."value") FILTER (WHERE d."status" = 'WON'), 0) AS "won_value"
      FROM "deals" d
      JOIN "stages" s ON s."id" = d."stageId"
      JOIN "pipelines" p ON p."id" = s."pipelineId"
      LEFT JOIN "contacts" c ON c."id" = d."contactId"
     WHERE ${cond}
     GROUP BY 1
     ORDER BY "deals" DESC
     LIMIT 30`;

  const campaignKey = Prisma.sql`COALESCE(NULLIF(c."ad_resolved_campaign_name", ''), NULLIF(c."ad_utm_campaign", ''), '(sem campanha)')`;
  const adKey = Prisma.sql`COALESCE(NULLIF(c."ad_resolved_name", ''), NULLIF(c."ad_headline", ''), NULLIF(c."ad_utm_content", ''), '(sem anúncio)')`;
  const [byCampaign, byAd] = await Promise.all([grouped(campaignKey), grouped(adKey)]);
  const shape = (rows: GroupRow[]) =>
    rows.map((r) => {
      const deals = Number(r.deals);
      const won = Number(r.won);
      const lost = Number(r.lost);
      return {
        name: r.key,
        utmSource: r.source,
        deals,
        open: Number(r.open),
        won,
        lost,
        wonValue: Number(r.won_value ?? 0),
        conversion: won + lost > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null,
      };
    });
  return { byCampaign: shape(byCampaign), byAd: shape(byAd) };
}
