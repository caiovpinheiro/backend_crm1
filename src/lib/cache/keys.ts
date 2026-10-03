/**
 * Builders de cache key + helpers de invalidacao (PR 5.1).
 *
 * Centralizar aqui evita typo entre callers e permite refactor em
 * massa sem caca-fantasmas. NAO concatenar strings ad-hoc nas rotas
 * — sempre via builder.
 *
 * ## Famílias com versão
 *
 * Quando a invalidação cobre "todas as chaves de X" (todas as variantes
 * do board de um pipeline, todos os contadores de uma org), a chave embute
 * o número de versão da família (`v<n>`) e invalidar é um INCR em
 * `cache:v:<família>:<org>[:<pipeline>]` — ver `versions.ts`. Por isso os
 * builders dessas chaves são `async`: eles leem a versão (memória do
 * processo, no máximo uma ida ao Redis a cada 500 ms). Nada aqui chama
 * `cache.delPattern` (SCAN).
 */
import { createHash } from "node:crypto";

import { scheduleCoalescedPurge } from "./coalesce";
import { cache } from "./index";
import { nowRelativeLabel } from "./now-relative";
import {
  bumpCacheVersion,
  cacheVersionName,
  getCacheVersion,
  getCacheVersions,
} from "./versions";

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

// ── Lookups de canal dos webhooks (`wh_ctx:*`, `meta_wh:*`) ─────
//
// Respondem "de que org/canal é este identificador?" (phone_number_id,
// entry.id, sessionId…) e guardam os appSecrets para validar a assinatura.
// Antes, qualquer create/update/delete de canal de QUALQUER org apagava
// tudo com `delPattern("meta_wh:*")` + `delPattern("wh_ctx:*")` (SCAN do
// Redis inteiro, e as outras orgs perdiam o cache junto).
//
// Agora a invalidação é por org, com versão (`cache:v:channel:<org>`):
//
// - appSecrets de uma org: a versão da org vai na chave.
// - identificador → org: a org é a RESPOSTA do lookup, então não dá pra
//   pôr a versão dela na chave. O valor guardado leva um carimbo
//   `{ o: org, v: versão }` e só vale se a versão da org `o` ainda for a
//   mesma (`wrapChannelLookup`).
// - "não mapeado" (`o: null`) e a lista global de appSecrets (webhook sem
//   slug) não pertencem a org nenhuma: usam a versão `cache:v:channel:_all`,
//   que sobe a cada escrita de canal — é o que cobre o POST que cacheou
//   "não mapeado" pouco antes do onboarding do canal novo.
//
// Limite conhecido: se a org B cadastra um identificador que está em cache
// apontando para a org A (mesmo número em duas orgs), a entrada da org A
// não é invalidada e vale até o TTL (60 s `meta_wh`, 300 s `wh_ctx`).

/** Escopo "qualquer org" da família `channel`. */
const CHANNEL_ANY_ORG = "_all";

function channelVersion(orgId: string | null): string {
  return cacheVersionName("channel", orgId ?? CHANNEL_ANY_ORG);
}

export type WebhookContextLookupBy =
  | "channelId"
  | "phoneNumber"
  | "metaPhoneNumberId"
  | "baileysSessionId";

// O `s` marca o formato carimbado: um processo ainda na versão anterior
// (deploy em andamento) lê as chaves antigas e não tropeça no valor novo.
export function webhookContextKey(by: WebhookContextLookupBy, value: string): string {
  return `wh_ctx:s:${by}:${value}`;
}

export function metaWebhookPhoneKey(phoneNumberId: string): string {
  return `meta_wh:s:phone:${phoneNumberId}`;
}

export function metaWebhookMessagingKey(platform: string, entryId: string): string {
  return `meta_wh:s:msg:${platform}:${entryId}`;
}

/** `orgId` nulo = webhook sem slug (appSecrets de todas as orgs). */
export async function metaWebhookSecretsKey(orgId: string | null): Promise<string> {
  const version = await getCacheVersion(channelVersion(orgId));
  return `meta_wh:secrets:${orgId ?? "global"}:v${version}`;
}

type StampedChannelLookup<T> = {
  /** Org do resultado; `null` = identificador não mapeado. */
  o: string | null;
  /** Versão de `channel:<o>` (ou `channel:_all`) quando foi gravado. */
  v: string;
  d: T | null;
};

function isStampedChannelLookup(value: unknown): value is StampedChannelLookup<unknown> {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.o === null || typeof rec.o === "string") &&
    typeof rec.v === "string" &&
    "d" in rec
  );
}

/**
 * Cache-aside de um lookup identificador → org/canal. A entrada só vale
 * enquanto a versão de canais da org do resultado não mudar.
 */
export async function wrapChannelLookup<T extends { organizationId: string }>(
  key: string,
  ttlSec: number,
  loader: () => Promise<T | null>,
): Promise<T | null> {
  const entry = await cache.wrap<StampedChannelLookup<T>>(
    key,
    ttlSec,
    async () => {
      // Lida ANTES da consulta: canal criado durante ela já deixa o "não
      // mapeado" vencido. Para o resultado positivo a org só é conhecida
      // depois — fica a mesma janela de corrida do delete-depois-do-load.
      const anyOrgVersion = await getCacheVersion(channelVersion(null));
      const d = await loader();
      const o = d?.organizationId ?? null;
      const v = o ? await getCacheVersion(channelVersion(o)) : anyOrgVersion;
      return { o, v, d };
    },
    {
      accept: async (cached) =>
        isStampedChannelLookup(cached) &&
        cached.v === (await getCacheVersion(channelVersion(cached.o))),
    },
  );
  return entry.d;
}

/**
 * Chame em todo create/update/delete de canal. Invalida os lookups e os
 * appSecrets da org do canal, mais os "não mapeado" e a lista global de
 * appSecrets. Dois INCR — não toca nas entradas das outras orgs.
 */
export async function invalidateChannelLookups(
  orgId: string | null | undefined,
): Promise<void> {
  try {
    await bumpCacheVersion(
      ...(orgId ? [channelVersion(orgId)] : []),
      channelVersion(null),
    );
  } catch {
    /* best-effort — o TTL cobre a falha */
  }
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

//
// Versão por org (`cache:v:wa_tpl_catalog:<org>`): limpar "todas as WABAs
// da org" é um INCR; com `wabaId` apaga a chave exata.

function whatsappTemplateCatalogVersion(orgId: string): string {
  return cacheVersionName("wa_tpl_catalog", orgId);
}

export async function whatsappTemplateCatalogKey(
  orgId: string,
  wabaId: string,
): Promise<string> {
  const version = await getCacheVersion(whatsappTemplateCatalogVersion(orgId));
  return `wa_tpl_catalog:${orgId}:v${version}:${wabaId}`;
}

/** Sem `wabaId`, limpa o catálogo de todas as WABAs da org. */
export async function invalidateWhatsappTemplateCatalog(
  orgId: string | null | undefined,
  wabaId?: string | null,
): Promise<void> {
  if (!orgId) return;
  try {
    if (wabaId && wabaId.trim().length > 0) {
      await cache.del(await whatsappTemplateCatalogKey(orgId, wabaId.trim()));
    } else {
      await bumpCacheVersion(whatsappTemplateCatalogVersion(orgId));
    }
  } catch {
    /* best-effort */
  }
}

// ── Inbox tab counts ────────────────────────────────────────────
//
// GET /api/conversations?counts=1 — 2 queries (count(*) do escopo +
// COUNT FILTER das abas OPEN no índice parcial). TTL 90s cobre
// stampede; badges aceitam stale. NÃO purgar em cada `new_message`
// (preview) — isso era o storm de CPU. Purgar só quando o ticket
// muda de aba.
//
// A query histórica (todos/resolvidos/finalizados) varre todas as
// conversas da org (~620 ms) e tem cache próprio (`hist`, TTL maior).
// A invalidação troca a versão só das chaves ativas
// (`cache:v:inbox_tab_counts:<org>`); a histórica não embute versão e
// expira pelo TTL.

/** Tamanho do hash de escopo (`inboxTabCountsScopeFp`). */
export const INBOX_TAB_COUNTS_FP_LENGTH = 20;

/**
 * Janela em que um `Date` ABSOLUTO do escopo conta como o mesmo valor no
 * hash — rede de segurança para um corte relativo ao agora que ainda não foi
 * marcado (ver abaixo).
 */
export const INBOX_TAB_COUNTS_FP_DATE_BUCKET_MS = 15_000;

/**
 * Hash do escopo das badges.
 *
 * Cortes relativos ao agora (`markNowRelative`: fila Automação = agora − 15 s,
 * janela de 24 h da Meta) entram pelo RÓTULO, não pelo instante: a chave fica
 * estável enquanto o escopo não muda. Antes eles entravam arredondados para
 * 15 s e a chave (ativa e histórica) girava a cada 15 s para quem vê a fila
 * Automação — a consulta histórica (~620 ms) rodava de novo a cada virada e
 * o SWR nunca acertava (C2 / 1.3 da auditoria). O instante exato continua na
 * consulta; o que depende do tempo fica no VALOR calculado, cuja validade é
 * o TTL/SWR (badges aceitam stale; mudança de aba purga pela versão).
 *
 * Demais `Date` (absolutos) entram arredondados para baixo na janela.
 */
export function inboxTabCountsFingerprint(scope: unknown): string {
  const json = JSON.stringify(
    scope,
    function (this: Record<string, unknown>, key: string, value: unknown) {
      // `value` já passou por `Date#toJSON`; o original está em `this[key]`.
      const raw = this[key];
      if (raw instanceof Date) {
        const rel = nowRelativeLabel(raw);
        if (rel) return { $rel: rel };
        const t = raw.getTime();
        return Number.isFinite(t)
          ? {
              $date:
                Math.floor(t / INBOX_TAB_COUNTS_FP_DATE_BUCKET_MS) *
                INBOX_TAB_COUNTS_FP_DATE_BUCKET_MS,
            }
          : { $date: null };
      }
      return value;
    },
  );
  return createHash("sha1")
    .update(json)
    .digest("hex")
    .slice(0, INBOX_TAB_COUNTS_FP_LENGTH);
}

function inboxTabCountsVersion(orgId: string): string {
  return cacheVersionName("inbox_tab_counts", orgId);
}

export async function inboxTabCountsKey(
  orgId: string,
  scopeFp: string,
): Promise<string> {
  const version = await getCacheVersion(inboxTabCountsVersion(orgId));
  return `inbox_tab_counts:${orgId}:v${version}:${scopeFp}`;
}

export function inboxTabCountsHistKey(orgId: string, scopeFp: string): string {
  return `inbox_tab_counts:${orgId}:hist:${scopeFp}`;
}

export async function invalidateInboxTabCounts(orgId: string): Promise<void> {
  try {
    await bumpCacheVersion(inboxTabCountsVersion(orgId));
  } catch {
    /* best-effort */
  }
}

/**
 * Campos de `conversation_updated` que movem o ticket entre abas
 * (`tabToWhere` / guard / Ligar / visibilidade por departamento).
 * Preview, contactId e conversationId sozinhos NÃO entram.
 */
const TAB_MEMBERSHIP_UPDATE_KEYS = [
  "assignedToId",
  "assignedTo",
  "status",
  "closedAt",
  "followUpAt",
  "departmentId",
  "hasError",
  "whatsappCallConsentStatus",
  "whatsappCallConsentExpiresAt",
] as const;

/** Timeline types that move a ticket across inbox tabs (not tabulation). */
const TAB_MEMBERSHIP_TIMELINE_TYPES = new Set([
  "ASSIGNEE_CHANGED",
  "CONVERSATION_CLOSED",
  "CONVERSATION_REOPENED",
  "CONVERSATION_CREATED",
  "CONVERSATION_DEPARTMENT_CHANGED",
  "CONVERSATION_STATUS_CHANGED",
]);

export function conversationUpdatedAffectsInboxTabs(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const rec = data as Record<string, unknown>;
  return TAB_MEMBERSHIP_UPDATE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(rec, k));
}

export function conversationTimelineAffectsInboxTabs(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === "string" && TAB_MEMBERSHIP_TIMELINE_TYPES.has(type);
}

/**
 * SSE → badges. `new_message` (preview / last message) NÃO invalida:
 * direção Entrada↔Aguardando pode ficar stale até o TTL — aceite do
 * operador. Assign / resolve / reopen / transfer / departamento sim.
 */
export function shouldInvalidateInboxTabCounts(
  event: string,
  data: unknown,
): boolean {
  if (event === "new_message") return false;
  if (event === "conversation_updated") {
    return conversationUpdatedAffectsInboxTabs(data);
  }
  if (event === "conversation_timeline_updated") {
    return conversationTimelineAffectsInboxTabs(data);
  }
  return false;
}

/**
 * Coalescência leading + trailing (~15s) para assign/resolve/transfer.
 * Não usar no path de `new_message`. A janela vale entre réplicas (claim no
 * Redis — ver `coalesce.ts`); sem Redis, por processo.
 */
const TAB_COUNTS_INVALIDATION_WINDOW_MS = 15_000;

export function scheduleTabCountsInvalidation(orgId: string | null | undefined): void {
  if (!orgId) return;
  scheduleCoalescedPurge(
    `inbox_tab_counts:${orgId}`,
    TAB_COUNTS_INVALIDATION_WINDOW_MS,
    () => invalidateInboxTabCounts(orgId),
  );
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
// computeStageMetrics agrega os deals abertos do pipeline a cada carga do
// board. Cache-aside (TTL STAGE_METRICS_TTL_SEC em analytics.ts) reduz
// para 1 computacao por TTL sob rajada. Chave por org + pipeline.

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
// Hash da variant: a JSON crua estourava a chave Redis (GET lento).
//
// Duas versões na chave: a da org (`cache:v:board:<org>`, invalida todos
// os pipelines) e a do pipeline (`cache:v:board:<org>:<pipeline>`). As
// variantes da versão anterior ficam no Redis até o TTL do board (45 s).

function boardOrgVersion(orgId: string): string {
  return cacheVersionName("board", orgId);
}

function boardPipelineVersion(orgId: string, pipelineId: string): string {
  return cacheVersionName("board", orgId, pipelineId);
}

export async function boardDataKey(
  orgId: string,
  pipelineId: string,
  variant: string,
): Promise<string> {
  const fp = createHash("sha1").update(variant).digest("hex").slice(0, 20);
  const [orgVersion, pipelineVersion] = await getCacheVersions(
    boardOrgVersion(orgId),
    boardPipelineVersion(orgId, pipelineId),
  );
  return `board:${orgId}:${pipelineId}:v${orgVersion}.${pipelineVersion}:${fp}`;
}

/** Invalida TODAS as variantes do board de um pipeline (todos os filtros). */
export async function invalidateBoardData(
  orgId: string,
  pipelineId: string,
): Promise<void> {
  await bumpCacheVersion(boardPipelineVersion(orgId, pipelineId));
}

/**
 * Invalida o board de TODOS os pipelines da org.
 *
 * Uma mensagem nova muda `lastMessage`/`unreadCount` dos cards, mas quem a
 * cria (webhook, envio manual, automação, IA) conhece a conversa — não o
 * pipeline do negócio. Trocar a versão da org evita um lookup extra no
 * hot path.
 */
export async function invalidateOrgBoards(orgId: string): Promise<void> {
  try {
    await bumpCacheVersion(boardOrgVersion(orgId));
  } catch {
    /* cache é best-effort — o TTL cobre a falha */
  }
}

/**
 * Janela de coalescência das invalidações por mensagem.
 *
 * A invalidação em si ficou barata (INCR), mas cada uma obriga o próximo
 * leitor a recalcular: o board é a query mais cara do app (~2,4s) e o
 * cache-aside existe pra segurar rajada de webhook. Purgar a cada mensagem
 * devolveria o pico de CPU de jul/26, então a primeira mensagem purga na
 * hora (o operador vê o
 * card atualizar no refetch que o SSE dispara ~800ms depois) e as demais
 * da janela viram uma única purga no fim dela. Com 3s o board das orgs
 * grandes era recalculado quase sem parar; 15s é o atraso máximo aceito
 * para a prévia do card.
 *
 * A janela vale entre réplicas (claim `SET NX PX` no Redis + marca de sujo
 * para o trailing — ver `coalesce.ts`); sem Redis, por processo.
 */
export const BOARD_INVALIDATION_WINDOW_MS = 15_000;

/**
 * Agenda a invalidação do board com coalescência (leading + trailing).
 * Com `pipelineId`, troca só a versão daquele pipeline; sem ele, a da org
 * (todos os pipelines). Fire-and-forget: nunca bloqueia o path de criação
 * da mensagem.
 */
export function scheduleBoardInvalidation(
  orgId: string | null | undefined,
  pipelineId?: string | null,
): void {
  if (!orgId) return;
  // Janela `org` (todos os pipelines) ou `org:pipeline`.
  const windowKey = pipelineId ? `${orgId}:${pipelineId}` : orgId;
  scheduleCoalescedPurge(
    `board:${windowKey}`,
    BOARD_INVALIDATION_WINDOW_MS,
    () =>
      pipelineId
        ? invalidateBoardData(orgId, pipelineId)
        : invalidateOrgBoards(orgId),
  );
}

// ── Origem de tenant confiável no CORS ──────────────────────────
//
// "`https://{slug}.{base}` pode receber CORS com credenciais?" — org
// existe, está ACTIVE e tem usuário com e-mail verificado (ver
// `lib/cors-tenant-origin.ts`). Guarda também a resposta negativa, por
// isso a versão por slug (`cache:v:cors_tenant_origin:<slug>`): verificar
// o e-mail, aceitar convite ou mudar o status da org troca a versão e a
// resposta antiga deixa de ser lida.

function corsTenantOriginVersion(slug: string): string {
  return cacheVersionName("cors_tenant_origin", slug);
}

export async function corsTenantOriginKey(slug: string): Promise<string> {
  const version = await getCacheVersion(corsTenantOriginVersion(slug));
  return `cors_tenant_origin:${slug}:v${version}`;
}

export async function invalidateCorsTenantOrigin(
  slug: string | null | undefined,
): Promise<void> {
  if (!slug) return;
  try {
    await bumpCacheVersion(corsTenantOriginVersion(slug));
  } catch {
    /* best-effort */
  }
}
