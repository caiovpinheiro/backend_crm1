/**
 * Builders de cache key + helpers de invalidacao (PR 5.1).
 *
 * Centralizar aqui evita typo entre callers e permite refactor em
 * massa sem caca-fantasmas. NAO concatenar strings ad-hoc nas rotas
 * — sempre via builder.
 */
import { createHash } from "node:crypto";

import { cache } from "./index";

// ── Channel ─────────────────────────────────────────────────────
//
// Usado em hot paths:
//   - meta-webhook handler (lookup por id)
//   - send-whatsapp (lookup por id)
//   - automation-executor (lookup por id)

export function channelKey(id: string): string {
  return `channel:${id}`;
}

export async function invalidateChannel(id: string): Promise<void> {
  await cache.del(channelKey(id));
}

// ── AIAgentConfig ───────────────────────────────────────────────
//
// 1:1 com User. Carregado em cada turn de bot.

export function aiAgentConfigKey(userId: string): string {
  return `ai_agent:${userId}`;
}

export async function invalidateAiAgentConfig(userId: string): Promise<void> {
  await cache.del(aiAgentConfigKey(userId));
}

// ── Organization ────────────────────────────────────────────────
//
// Lookup por slug em SSR de /onboarding e branding publico.

export function organizationBySlugKey(slug: string): string {
  return `org_slug:${slug.toLowerCase()}`;
}

export function organizationByIdKey(id: string): string {
  return `org:${id}`;
}

export async function invalidateOrganization(opts: {
  id?: string;
  slug?: string;
}): Promise<void> {
  const keys: string[] = [];
  if (opts.id) keys.push(organizationByIdKey(opts.id));
  if (opts.slug) keys.push(organizationBySlugKey(opts.slug));
  if (keys.length > 0) await cache.del(...keys);
}

// ── Settings (Organization-level config livre) ──────────────────
//
// Pra futuros toggles e branding — chave unica por org.

export function organizationSettingsKey(orgId: string): string {
  return `org_settings:${orgId}`;
}

export async function invalidateOrganizationSettings(orgId: string): Promise<void> {
  await cache.del(organizationSettingsKey(orgId));
}

// ── User (apenas campos hot) ────────────────────────────────────
//
// USE COM CUIDADO. User muda raramente mas alteracoes precisam ser
// vistas rapido (role, isErased, status org). TTL curto = 30s.

export function userKey(id: string): string {
  return `user:${id}`;
}

export async function invalidateUser(id: string): Promise<void> {
  await cache.del(userKey(id));
}

// ── Catálogo de templates da Graph (WABA) ───────────────────────
//
// GET /api/whatsapp-template-configs/agent-enabled pagina
// `message_templates` da Graph pra enriquecer os templates com botões,
// variáveis e Flow. Era um Map no processo com TTL de 60s: frio a cada
// deploy, não compartilhado entre réplicas e expirando a cada minuto —
// ~2,2s por abertura de conversa medidos em produção.
//
// A chave é por org + WABA. O `organizationId` entra por isolamento
// (o catálogo é dado de um tenant e não pode vazar entre orgs — ver o
// alerta em `resolve-templates-client.ts`), e o `wabaId` porque o
// catálogo é propriedade da WABA: uma org com dois canais na mesma WABA
// compartilha o cache, e dois canais em WABAs distintas não se misturam.

export function whatsappTemplateCatalogKey(orgId: string, wabaId: string): string {
  return `wa_tpl_catalog:${orgId}:${wabaId}`;
}

/** Sem `wabaId`, limpa o catálogo de todas as WABAs da org. */
export async function invalidateWhatsappTemplateCatalog(
  orgId: string | null | undefined,
  wabaId?: string | null,
): Promise<void> {
  if (!orgId) return;
  try {
    if (wabaId && wabaId.trim().length > 0) {
      await cache.del(whatsappTemplateCatalogKey(orgId, wabaId.trim()));
    } else {
      await cache.delPattern(`wa_tpl_catalog:${orgId}:*`);
    }
  } catch {
    /* best-effort */
  }
}

// ── Inbox tab counts ────────────────────────────────────────────
//
// GET /api/conversations?counts=1 — COUNT por aba é caro em orgs
// grandes (finalizados/todos). TTL curto cobre cold-load stampede;
// abas quentes (esperando/entrada) aceitam stale ≤60s nos badges.

export function inboxTabCountsKey(orgId: string, scopeFp: string): string {
  return `inbox_tab_counts:${orgId}:${scopeFp}`;
}

export async function invalidateInboxTabCounts(orgId: string): Promise<void> {
  try {
    await cache.delPattern(`inbox_tab_counts:${orgId}:*`);
  } catch {
    /* best-effort */
  }
}

/**
 * Mesma coalescência do board (leading + trailing), aplicada aos badges.
 *
 * Sem isto, mensagem nova não invalidava os counts e a frescura dependia só
 * do TTL — que precisava ser curto (5s) e perdia a corrida contra o refetch
 * que o SSE dispara ~1s depois, fazendo ~metade das chamadas recomputar a
 * agregação (1,2-2,3s medidos em produção). Com invalidação no path da
 * mensagem, o TTL pode ser longo sem defasar o badge.
 */
const TAB_COUNTS_INVALIDATION_WINDOW_MS = 3_000;

const tabCountsInvalidationWindows = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; again: boolean }
>();

export function scheduleTabCountsInvalidation(orgId: string | null | undefined): void {
  if (!orgId) return;

  const open = tabCountsInvalidationWindows.get(orgId);
  if (open) {
    open.again = true;
    return;
  }

  void invalidateInboxTabCounts(orgId);

  const slot = {
    again: false,
    timer: setTimeout(() => {
      tabCountsInvalidationWindows.delete(orgId);
      if (slot.again) scheduleTabCountsInvalidation(orgId);
    }, TAB_COUNTS_INVALIDATION_WINDOW_MS),
  };
  if (typeof slot.timer === "object" && slot.timer && "unref" in slot.timer) {
    slot.timer.unref();
  }
  tabCountsInvalidationWindows.set(orgId, slot);
}

// ── Pipelines / Stages (config raramente muda) ──────────────────
//
// Listagem completa por org. Invalidar em mudanca de pipeline/stage.

export function pipelinesKey(orgId: string): string {
  return `pipelines:${orgId}`;
}

export async function invalidatePipelines(orgId: string): Promise<void> {
  await cache.del(pipelinesKey(orgId));
}

// ── Stage Metrics (headers do Kanban) ───────────────────────────
//
// computeStageMetrics varre o pipeline inteiro a cada carga do board.
// Cache-aside com TTL curto (60s) em getStageMetrics reduz para 1
// computacao/60s sob rajada. Chave por org + pipeline.

export function stageMetricsKey(orgId: string, pipelineId: string): string {
  return `stage_metrics:${orgId}:${pipelineId}`;
}

export async function invalidateStageMetrics(
  orgId: string,
  pipelineId: string,
): Promise<void> {
  await cache.del(stageMetricsKey(orgId, pipelineId));
}

// ── Board (getBoardData) ────────────────────────────────────────
//
// getBoardData é a query MAIS cara do app: varre deals do pipeline com
// includes + last-message por contato + products + metrics. Sob rajada
// (o mesmo usuário/funil recarregando o board via invalidações do
// react-query enquanto webhooks criam deals a cada segundo), dezenas de
// execuções IDÊNTICAS de ~13s empilhavam e estouravam a CPU do container.
//
// Cache-aside com TTL curto + stampede-lock colapsa a rajada numa única
// query por `variant` (visibilidade + status + filtros + paginação/sort).
// Hash da variant: a JSON crua estourava a chave Redis (SCAN/GET lentos).
export function boardDataKey(
  orgId: string,
  pipelineId: string,
  variant: string,
): string {
  const fp = createHash("sha1").update(variant).digest("hex").slice(0, 20);
  return `board:${orgId}:${pipelineId}:${fp}`;
}

/** Invalida TODAS as variantes do board de um pipeline (todos os filtros). */
export async function invalidateBoardData(
  orgId: string,
  pipelineId: string,
): Promise<void> {
  await cache.delPattern(`board:${orgId}:${pipelineId}:*`);
}

/**
 * Invalida o board de TODOS os pipelines da org.
 *
 * Uma mensagem nova muda `lastMessage`/`unreadCount` dos cards, mas quem a
 * cria (webhook, envio manual, automação, IA) conhece a conversa — não o
 * pipeline do negócio. Varrer por org evita um lookup extra no hot path.
 */
export async function invalidateOrgBoards(orgId: string): Promise<void> {
  await purgeOrgBoards(orgId);
}

async function purgeOrgBoards(orgId: string): Promise<void> {
  try {
    await cache.delPattern(`board:${orgId}:*`);
  } catch {
    /* cache é best-effort — o TTL cobre a falha */
  }
}

/**
 * Janela de coalescência das invalidações por mensagem.
 *
 * O board é a query mais cara do app (~2,4s) e o cache-aside existe pra
 * segurar rajada de webhook. Purgar a cada mensagem devolveria o pico de
 * CPU de jul/26, então a primeira mensagem purga na hora (o operador vê o
 * card atualizar no refetch que o SSE dispara ~800ms depois) e as demais
 * da janela viram uma única purga no fim dela.
 */
const BOARD_INVALIDATION_WINDOW_MS = 3_000;

type BoardInvalidationWindow = {
  timer: ReturnType<typeof setTimeout>;
  /** Houve mensagem durante a janela → purga de novo ao fechá-la. */
  again: boolean;
};

const boardInvalidationWindows = new Map<string, BoardInvalidationWindow>();

/**
 * Agenda a invalidação do board da org com coalescência (leading + trailing).
 * Fire-and-forget: nunca bloqueia o path de criação da mensagem.
 */
export function scheduleBoardInvalidation(orgId: string | null | undefined): void {
  if (!orgId) return;

  const open = boardInvalidationWindows.get(orgId);
  if (open) {
    open.again = true;
    return;
  }

  void purgeOrgBoards(orgId);

  const slot: BoardInvalidationWindow = {
    again: false,
    timer: setTimeout(() => {
      boardInvalidationWindows.delete(orgId);
      if (slot.again) scheduleBoardInvalidation(orgId);
    }, BOARD_INVALIDATION_WINDOW_MS),
  };
  // Não segura o event loop no shutdown.
  if (typeof slot.timer === "object" && slot.timer && "unref" in slot.timer) {
    slot.timer.unref();
  }
  boardInvalidationWindows.set(orgId, slot);
}
