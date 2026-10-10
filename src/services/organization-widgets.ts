/**
 * Service da Central de Widgets.
 *
 * Modelo:
 *   - `Widget` (global): catalogo de definicoes — internos (seed) + parceiros.
 *     Lido via `prismaBase` (NAO tenant-scoped — todas as orgs veem o mesmo
 *     catalogo de widgets `ONLINE`).
 *   - `OrganizationWidget` (tenant-scoped): estado de instalacao por org.
 *     Lido via `prisma` (org-scope injetado pela Prisma Extension).
 *
 * Regras:
 *   - Apenas widgets `status=ONLINE` aparecem na listagem do CRM.
 *   - Slug eh fonte de "join logico" entre Widget e OrganizationWidget
 *     (sem FK Prisma — ver coment do schema). O service valida a existencia.
 *   - Widgets internos sao identificados por `ownerType=INTERNAL`; no
 *     frontend, abrem rotas proprias. Externos abrem iframe.
 */

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { getOrgIdOrNull, getOrgIdOrThrow } from "@/lib/request-context";
import {
  invalidateLocalVersioned,
  localVersioned,
} from "@/lib/cache/local-versioned";
import type {
  WidgetAvailability,
  WidgetDefinition,
  WidgetOwnerType,
  WidgetStatus,
} from "@/lib/widget-catalog";

/** Erro de slug invalido — o route handler mapeia para HTTP 400. */
export class InvalidWidgetSlugError extends Error {
  constructor(slug: string) {
    super(`Widget slug invalido: ${slug}`);
    this.name = "InvalidWidgetSlugError";
  }
}

export type WidgetInstallStatus = "ACTIVE" | "INACTIVE";

export interface WidgetWithState extends WidgetDefinition {
  /** True quando o widget esta instalado E ativo para a org atual. */
  installed: boolean;
  /** Estado persistido ("ACTIVE" | "INACTIVE") ou null se nunca instalado. */
  status: WidgetInstallStatus | null;
  /** ISO da ultima instalacao/reativacao, ou null. */
  installedAt: string | null;
  /** Status do widget no marketplace — para o card mostrar selo "DRAFT"
   *  caso a UI queira distinguir (no padrao listamos so ONLINE, mas o tipo
   *  fica disponivel pra UIs futuras). */
  marketplaceStatus: WidgetStatus;
  /** Widget esta instalado mas indisponivel (OFFLINE no marketplace ou
   *  parceiro SUSPENDED). UI usa pra mostrar badge "Indisponivel" e
   *  liberar apenas o botao Desinstalar. */
  disabled: boolean;
  /** Motivo curto pra UI exibir junto do badge "Indisponivel". */
  disabledReason: string | null;
}

/**
 * Slugs ATIVOS da org em memória do processo (C1 da auditoria de banco,
 * 05/10): `organization_widgets` teve 633 mil leituras em 6 dias numa
 * tabela vazia — `hasOrganizationWidget("smart_distribution")` roda a cada
 * passagem do motor de distribuição e `getActiveWidgetSlugs` a cada
 * bootstrap / sidebar. Uma consulta por org a cada 30 s por processo;
 * instalar/desinstalar invalida pela versão (vale nas outras réplicas em
 * ~500 ms). É gate de funcionalidade, não permissão de usuário.
 */
const ACTIVE_WIDGETS_FAMILY = "org_widgets";
const ACTIVE_WIDGETS_TTL_MS = 30_000;

async function loadActiveWidgetSlugs(): Promise<Set<string>> {
  const rows = await prisma.organizationWidget.findMany({
    where: { status: "ACTIVE" },
    select: { widgetSlug: true },
  });
  return new Set(rows.map((r) => r.widgetSlug));
}

async function activeWidgetSlugs(): Promise<ReadonlySet<string>> {
  // Sem org no contexto (super-admin cross-org): consulta direta, como antes.
  const organizationId = getOrgIdOrNull();
  if (!organizationId) return loadActiveWidgetSlugs();
  return localVersioned(
    {
      family: ACTIVE_WIDGETS_FAMILY,
      scope: [organizationId],
      ttlMs: ACTIVE_WIDGETS_TTL_MS,
    },
    loadActiveWidgetSlugs,
  );
}

/**
 * Le um Widget pelo slug (sem filtro de status). Usado para validacoes
 * internas (instalar/desinstalar). Para listagem publica, use
 * `listWidgetsWithState`.
 */
async function findWidgetBySlug(slug: string) {
  return prismaBase.widget.findUnique({
    where: { slug },
    include: { partnerAccount: { select: { name: true, status: true } } },
  });
}

/**
 * Lista o catalogo de widgets ONLINE mesclado com o estado da organizacao
 * atual. Inclui tambem widgets ja instalados que ficaram indisponiveis
 * (OFFLINE no marketplace ou parceiro SUSPENDED) — marcados com
 * `disabled: true` — pra org poder desinstalar pelo UI sem ficar com
 * estado fantasma.
 *
 * Filtra parceiros com `status != ACTIVE` (SUSPENDED nao deve descobrir
 * novos clientes), mas mantem orgs que ja instalaram esses widgets
 * vendo-os (com `disabled: true`).
 */
export async function listWidgetsWithState(): Promise<WidgetWithState[]> {
  const [marketplace, installations] = await Promise.all([
    prismaBase.widget.findMany({
      where: {
        status: "ONLINE",
        // Parceiros SUSPENDED somem do marketplace publico. Widgets
        // INTERNAL (sem partnerAccount) sempre aparecem.
        OR: [
          { ownerType: "INTERNAL" },
          { partnerAccount: { status: "ACTIVE" } },
        ],
      },
      orderBy: [{ ownerType: "asc" }, { name: "asc" }],
      include: { partnerAccount: { select: { name: true, status: true } } },
    }),
    prisma.organizationWidget.findMany({
      select: { widgetSlug: true, status: true, installedAt: true },
    }),
  ]);
  const bySlug = new Map(installations.map((r) => [r.widgetSlug, r]));

  // Marketplace primeiro. Construimos um Set de slugs marketplace pra
  // descobrir installations "orfas" (widget ficou OFFLINE ou parceiro
  // suspenso DEPOIS da instalacao).
  const marketplaceSlugs = new Set(marketplace.map((w) => w.slug));

  const fromMarketplace: WidgetWithState[] = marketplace.map((w) => {
    const row = bySlug.get(w.slug);
    const installStatus = (row?.status as WidgetInstallStatus | undefined) ?? null;
    return {
      slug: w.slug,
      name: w.name,
      description: w.description,
      icon: w.icon,
      category: w.category,
      features: w.features,
      availability: w.availability as WidgetAvailability,
      ownerType: w.ownerType as WidgetOwnerType,
      partnerAccountId: w.partnerAccountId,
      iframeUrl: w.iframeUrl,
      partnerName: w.partnerAccount?.name ?? null,
      installed: installStatus === "ACTIVE",
      status: installStatus,
      installedAt: row?.installedAt ? row.installedAt.toISOString() : null,
      marketplaceStatus: w.status as WidgetStatus,
      disabled: false,
      disabledReason: null,
    };
  });

  // Instalacoes ATIVAS de widgets que NAO estao mais no marketplace —
  // precisamos buscar o registro do `Widget` mesmo OFFLINE pra ter
  // metadata (nome/icone). Sem isso, a org perderia o botao "Desinstalar".
  const orphanSlugs = installations
    .filter((i) => i.status === "ACTIVE" && !marketplaceSlugs.has(i.widgetSlug))
    .map((i) => i.widgetSlug);

  let orphans: WidgetWithState[] = [];
  if (orphanSlugs.length > 0) {
    const orphanWidgets = await prismaBase.widget.findMany({
      where: { slug: { in: orphanSlugs } },
      include: { partnerAccount: { select: { name: true, status: true } } },
    });
    orphans = orphanWidgets.map((w) => {
      const row = bySlug.get(w.slug)!;
      const reason =
        w.status === "OFFLINE"
          ? "Widget tirado do ar pelo parceiro."
          : w.partnerAccount?.status && w.partnerAccount.status !== "ACTIVE"
            ? "Parceiro indisponível."
            : w.status === "DRAFT"
              ? "Widget despublicado."
              : "Widget indisponível.";
      return {
        slug: w.slug,
        name: w.name,
        description: w.description,
        icon: w.icon,
        category: w.category,
        features: w.features,
        availability: w.availability as WidgetAvailability,
        ownerType: w.ownerType as WidgetOwnerType,
        partnerAccountId: w.partnerAccountId,
        iframeUrl: w.iframeUrl,
        partnerName: w.partnerAccount?.name ?? null,
        installed: true,
        status: "ACTIVE" as WidgetInstallStatus,
        installedAt: row.installedAt.toISOString(),
        marketplaceStatus: w.status as WidgetStatus,
        disabled: true,
        disabledReason: reason,
      };
    });
  }

  return [...fromMarketplace, ...orphans];
}

/**
 * Instala (ou reativa) um widget para a organizacao atual.
 * - Valida que o slug existe E esta `ONLINE` (catalogo publico).
 * - Idempotente quando ja ACTIVE.
 * - Reativa registros INACTIVE atualizando installedAt/installedById.
 */
export async function installWidget(slug: string, userId: string): Promise<void> {
  const widget = await findWidgetBySlug(slug);
  if (!widget || widget.status !== "ONLINE" || widget.availability !== "available") {
    throw new InvalidWidgetSlugError(slug);
  }
  // Parceiro suspenso nao deve ganhar novos clientes — orgs que ja
  // tinham instalado continuam vendo o widget como "disabled" (vide
  // listWidgetsWithState) mas novas instalacoes sao bloqueadas.
  if (widget.ownerType === "PARTNER" && widget.partnerAccount?.status !== "ACTIVE") {
    throw new InvalidWidgetSlugError(slug);
  }
  const organizationId = getOrgIdOrThrow();

  const existing = await prisma.organizationWidget.findUnique({
    where: { organizationId_widgetSlug: { organizationId, widgetSlug: slug } },
    select: { status: true },
  });

  if (existing?.status === "ACTIVE") return;

  await prisma.organizationWidget.upsert({
    where: { organizationId_widgetSlug: { organizationId, widgetSlug: slug } },
    update: { status: "ACTIVE", installedAt: new Date(), installedById: userId },
    create: {
      organizationId,
      widgetSlug: slug,
      status: "ACTIVE",
      installedById: userId,
    },
  });
  await invalidateLocalVersioned(ACTIVE_WIDGETS_FAMILY, organizationId);
}

/**
 * Desativa um widget para a organizacao atual (status INACTIVE).
 * Nunca deleta fisicamente. Idempotente: se nao existir registro, no-op.
 * Valida que o slug existe no catalogo (em qualquer status — pra
 * permitir desinstalar widgets ja OFFLINE).
 */
export async function uninstallWidget(slug: string): Promise<void> {
  const widget = await findWidgetBySlug(slug);
  if (!widget) throw new InvalidWidgetSlugError(slug);
  const organizationId = getOrgIdOrThrow();

  await prisma.organizationWidget.updateMany({
    where: { organizationId, widgetSlug: slug },
    data: { status: "INACTIVE" },
  });
  await invalidateLocalVersioned(ACTIVE_WIDGETS_FAMILY, organizationId);
}

/**
 * Helper para gating futuro de features: true se a org atual tem o widget
 * ativo. O `organizationId` vem do contexto (org-scope), entao basta o slug.
 *
 * NAO valida `Widget.status` — um widget que ficou OFFLINE depois de
 * instalado continua "habilitado" para a org (ate ela desinstalar
 * explicitamente). Isso evita que o parceiro derrube o servico de orgs
 * em producao mudando o toggle.
 */
export async function hasOrganizationWidget(slug: string): Promise<boolean> {
  return (await activeWidgetSlugs()).has(slug);
}

/**
 * Conjunto de slugs de widgets ATIVOS na org atual. Use para gatear varios
 * itens de uma vez (ex.: `computeAvailableKeys` da sidebar) com UMA query.
 */
export async function getActiveWidgetSlugs(): Promise<Set<string>> {
  // Cópia: o conjunto em memória é compartilhado entre requisições.
  return new Set(await activeWidgetSlugs());
}

/** Lancado quando uma feature gateada por widget e usada sem o widget ativo.
 *  O route handler mapeia para HTTP 403. */
export class WidgetNotEnabledError extends Error {
  constructor(public readonly slug: string) {
    super(`Widget não habilitado para esta organização: ${slug}`);
    this.name = "WidgetNotEnabledError";
  }
}

/**
 * Gate generico: garante que o widget `slug` esta ativo na org atual.
 * Lanca `WidgetNotEnabledError` caso contrario. Deve rodar dentro de
 * `withOrgContext` (precisa do org-scope para a query).
 */
export async function assertWidgetEnabled(slug: string): Promise<void> {
  if (!(await hasOrganizationWidget(slug))) {
    throw new WidgetNotEnabledError(slug);
  }
}

/** Gate dedicado da Distribuição Inteligente (`smart_distribution`). */
export async function assertSmartDistributionEnabled(): Promise<void> {
  await assertWidgetEnabled("smart_distribution");
}

/** Gate dedicado da Telefonia (`calls_history`). Use em rotas /api/calls/*
 *  e /api/sip-extensions/* pra reforçar o gate no backend (o frontend
 *  já gateia via useCallsWidget, mas defesa em profundidade evita que
 *  uma org desinstalada continue gerando registros de chamada). */
export async function assertCallsHistoryEnabled(): Promise<void> {
  await assertWidgetEnabled("calls_history");
}
