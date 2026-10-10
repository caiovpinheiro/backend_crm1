/**
 * Rede de segurança da distribuição.
 *
 * O contato escreveu, a IA é a responsável e ninguém respondeu. Cobre falha
 * de LLM/chave, canal fora do ar e qualquer caminho em que o agente fica
 * em silêncio — sem isso o lead fica preso na IA e nunca chega a humano.
 *
 * Roda no `worker-distribution` (`stuck-inbound`). Cron POST e o tick
 * de inatividade só enfileiram o mesmo jobId. GET do cron continua
 * dry-run aqui. Override: `AI_AGENT_STUCK_INBOUND_MS` (0 desliga).
 *
 * Nunca envia mensagem ao contato: só reatribui / enfileira.
 *
 * Não repete trabalho (em produção as MESMAS 50 conversas voltavam a cada
 * minuto e eram regravadas — 421.750 UPDATEs em 5,9 dias):
 *
 *  1. Conversa sem responsável em org onde o motor não age (widget
 *     desinstalado ou `distribution.enabled=false`) sai da consulta: o
 *     handoff ali não atribui nem enfileira, só regravava. Conversa ainda
 *     com a IA continua entrando — soltá-la da IA é mudança real, uma vez.
 *  2. Quem passou pelo handoff e não ganhou responsável recebe uma marca
 *     de tentativa (cache, por conversa + `lastInboundAt`) com espera
 *     crescente. Inbound novo invalida a marca. Enquanto a marca vale, a
 *     conversa é pulada — sem handoff, sem gravação, sem evento.
 *  3. Linha pulada (marca, canal aposentado) não ocupa o lote: a varredura
 *     segue para as próximas páginas até tratar `limit` conversas ou
 *     esgotar o teto de páginas.
 *  4. Conversa presa na IA vem antes de conversa sem responsável: acúmulo
 *     na Entrada não atrasa quem está esperando a IA.
 */

import { cache } from "@/lib/cache";
import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import { resolveAgentVerticalForConversation } from "@/services/ai/agent-vertical";
import { executeDepartmentHandoff } from "@/services/ai/department-handoff";
import { isDistributionEnabled } from "@/services/distribution/enabled";
import { hasOrganizationWidget } from "@/services/organization-widgets";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai.stuck-inbound-distribution");

export const STUCK_INBOUND_MS = 15 * 60 * 1000;

const BATCH_SIZE = 50;
const MAX_LIMIT = 500;
/** Teto de páginas por rodada: linha pulada não pode virar varredura sem fim. */
const MAX_PAGES = 10;

/**
 * Espera entre tentativas da MESMA conversa (mesmo `lastInboundAt`) que
 * saiu do handoff sem responsável: 30 min, 1 h, 2 h… até 6 h. Quem entrou
 * na fila de espera (`distribution_pending`) nem volta à consulta — a
 * drenagem atribui quando houver consultor. A marca cobre o resto: motor
 * desligado, departamento fora do smart, pendência limpa pela drenagem.
 * Override da base: `AI_AGENT_STUCK_INBOUND_RETRY_MS`.
 */
export const STUCK_RETRY_BASE_MS = 30 * 60 * 1000;
export const STUCK_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** Exceção no handoff tenta de novo mais cedo: 5 min, 10 min… */
export const STUCK_RETRY_FAILED_BASE_MS = 5 * 60 * 1000;
/** A marca vive mais que a maior espera, para a contagem não zerar. */
const ATTEMPT_TTL_SEC = Math.ceil((STUCK_RETRY_MAX_MS * 2) / 1000);

type AttemptMark = {
  /** `lastInboundAt` (ms) da tentativa — inbound novo invalida a marca. */
  inboundAt: number;
  attempts: number;
  /** Não tentar de novo antes deste instante (ms). */
  retryAt: number;
};

export function stuckAttemptKey(conversationId: string): string {
  return `stuck-inbound:tentativa:${conversationId}`;
}

function retryBaseMs(): number {
  const raw = process.env.AI_AGENT_STUCK_INBOUND_RETRY_MS;
  if (raw === undefined || raw === "") return STUCK_RETRY_BASE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : STUCK_RETRY_BASE_MS;
}

function backoffMs(baseMs: number, attempts: number): number {
  const factor = 2 ** Math.min(Math.max(attempts - 1, 0), 16);
  return Math.min(baseMs * factor, Math.max(STUCK_RETRY_MAX_MS, baseMs));
}

async function readAttempt(
  conversationId: string,
  inboundAt: number,
): Promise<AttemptMark | null> {
  try {
    const mark = await cache.get<AttemptMark>(stuckAttemptKey(conversationId));
    return mark && mark.inboundAt === inboundAt ? mark : null;
  } catch {
    return null;
  }
}

async function writeAttempt(args: {
  conversationId: string;
  inboundAt: number;
  previous: AttemptMark | null;
  now: Date;
  baseMs: number;
}): Promise<void> {
  const attempts = (args.previous?.attempts ?? 0) + 1;
  const mark: AttemptMark = {
    inboundAt: args.inboundAt,
    attempts,
    retryAt: args.now.getTime() + backoffMs(args.baseMs, attempts),
  };
  try {
    await cache.set(stuckAttemptKey(args.conversationId), mark, ATTEMPT_TTL_SEC);
  } catch {
    /* cache fora: a próxima rodada repete o handoff, que não regrava */
  }
}

/**
 * Orgs que a última rodada viu com o motor parado. Só uma dica para a
 * consulta já sair sem elas — cada rodada confere de novo antes de usar.
 */
const blockedOrgHint = new Set<string>();

/** O motor age nesta org? Os mesmos dois portões de `executeDistribution`. */
async function canEngineAct(organizationId: string): Promise<boolean> {
  try {
    return await withSystemContext(
      organizationId,
      async () =>
        (await hasOrganizationWidget("smart_distribution")) &&
        (await isDistributionEnabled()),
    );
  } catch (err) {
    // Na dúvida deixa passar: o handoff decide e a marca segura a repetição.
    log.warn(
      { organizationId, err: err instanceof Error ? err.message : err },
      "[ai-stuck-inbound] não deu para ler o estado do motor",
    );
    return true;
  }
}

/** Só para testes: zera a dica de orgs com o motor parado. */
export function resetStuckInboundStateForTests(): void {
  blockedOrgHint.clear();
}

type StuckRow = {
  conversation_id: string;
  conversation_number: number;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  organization_id: string;
  assigned_to_id: string | null;
  last_inbound_at: Date;
  channel_name: string | null;
  channel_phone: string | null;
  channel_config: unknown;
};

export type StuckInboundOptions = {
  now?: Date;
  /** Tempo mínimo sem resposta para entrar na varredura. 0 desliga. */
  stuckMs?: number;
  /** Só olha inbound dos últimos N ms. 0 = sem limite (padrão). */
  sinceMs?: number;
  limit?: number;
  /** false = dry-run (só lista, não distribui). Padrão true. */
  apply?: boolean;
  organizationId?: string | null;
};

export type StuckInboundItem = {
  conversationNumber: number;
  contact: string;
  phone: string | null;
  lastInboundAt: string | null;
  idleMinutes: number;
  /**
   * `released`: passou pelo handoff, ficou sem responsável e NÃO entrou na
   * fila de espera (motor desligado, canal aposentado, departamento fora
   * do smart). Antes contava como `queued` sem estar em fila nenhuma.
   */
  status: "listed" | "distributed" | "queued" | "released" | "failed";
  department: string | null;
  assignedTo: string | null;
  reason?: string;
  error?: string;
};

export type StuckInboundResult = {
  apply: boolean;
  stuckMs: number;
  sinceMs: number;
  candidates: number;
  distributed: number;
  queued: number;
  released: number;
  failed: number;
  /** Puladas sem handoff: em espera de nova tentativa ou canal aposentado. */
  skipped: number;
  items: StuckInboundItem[];
};

/** O motor enfileirou em `distribution_pending` nestes dois motivos. */
const QUEUED_REASONS = new Set(["NO_ELIGIBLE_RESPONSIBLE", "NO_DEPARTMENT"]);

async function listStuckInbound(args: {
  now: Date;
  stuckMs: number;
  sinceMs: number;
  limit: number;
  organizationId: string;
  /** Já vistas nesta rodada (paginação sem repetir linha). */
  excludeIds: string[];
  /** Orgs onde o motor não age: conversa sem responsável fica de fora. */
  blockedOrgIds: string[];
}): Promise<StuckRow[]> {
  const cutoff = new Date(args.now.getTime() - args.stuckMs);
  // sinceMs = 0 → epoch, ou seja, sem limite inferior de janela.
  const since = new Date(
    args.sinceMs > 0 ? args.now.getTime() - args.sinceMs : 0,
  );
  const org = args.organizationId;

  return prismaBase.$queryRaw<StuckRow[]>`
    SELECT
      c.id AS conversation_id,
      c."number" AS conversation_number,
      c."contactId" AS contact_id,
      ct.name AS contact_name,
      ct.phone AS contact_phone,
      c."organizationId" AS organization_id,
      c."assignedToId" AS assigned_to_id,
      c."lastInboundAt" AS last_inbound_at,
      ch.name AS channel_name,
      ch."phoneNumber" AS channel_phone,
      ch.config AS channel_config
    FROM "conversations" c
    LEFT JOIN "users" u ON u.id = c."assignedToId"
    LEFT JOIN "ai_agent_configs" a ON a."userId" = u.id
    LEFT JOIN "contacts" ct ON ct.id = c."contactId"
    LEFT JOIN "channels" ch ON ch.id = c."channelId"
    WHERE (
        (u.type = 'AI' AND a.active = true)
        OR (
          c."assignedToId" IS NULL
          -- Motor parado na org: o handoff não atribui nem enfileira.
          AND NOT (c."organizationId" = ANY(${args.blockedOrgIds}::text[]))
        )
      )
      AND NOT (c.id = ANY(${args.excludeIds}::text[]))
      AND c.status = 'OPEN'
      AND c."hasHumanReply" = false
      AND c."contactId" IS NOT NULL
      AND c."lastInboundAt" IS NOT NULL
      AND c."lastInboundAt" < ${cutoff}::timestamptz
      AND c."lastInboundAt" >= ${since}::timestamptz
      AND (${org}::text = '' OR c."organizationId" = ${org}::text)
      -- Ninguém respondeu depois da última mensagem do contato.
      AND NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m."conversationId" = c.id
          AND m.direction = 'out'
          AND COALESCE(m."isPrivate", false) = false
          AND m."messageType" <> 'note'
          AND m."createdAt" > c."lastInboundAt"
      )
      -- Já está na fila de espera: a drenagem cuida.
      AND NOT EXISTS (
        SELECT 1 FROM distribution_pending dp
        WHERE dp.status = 'PENDING'
          AND (dp."conversationId" = c.id OR dp."contactId" = c."contactId")
      )
    -- Presa na IA primeiro; a Entrada sem responsável vem depois.
    ORDER BY (c."assignedToId" IS NULL) ASC, c."lastInboundAt" ASC, c.id ASC
    LIMIT ${args.limit};
  `;
}

/**
 * Aceita a forma legada `(now, stuckMs)` usada pelo worker e a forma
 * com opções usada pela rota de ops.
 */
export async function distributeStuckInbound(
  arg?: Date | StuckInboundOptions,
  legacyStuckMs?: number,
): Promise<StuckInboundResult> {
  const opts: StuckInboundOptions =
    arg === undefined || arg instanceof Date
      ? { now: arg, stuckMs: legacyStuckMs }
      : arg;

  const now = opts.now ?? new Date();
  const stuckMs = opts.stuckMs ?? STUCK_INBOUND_MS;
  const sinceMs = Math.max(0, opts.sinceMs ?? 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? BATCH_SIZE));
  const apply = opts.apply ?? true;

  const empty: StuckInboundResult = {
    apply,
    stuckMs,
    sinceMs,
    candidates: 0,
    distributed: 0,
    queued: 0,
    released: 0,
    failed: 0,
    skipped: 0,
    items: [],
  };
  if (stuckMs <= 0) return empty;

  const organizationId = opts.organizationId?.trim() || "";
  const baseMs = retryBaseMs();

  // Estado do motor por org, lido uma vez por rodada. A dica da rodada
  // anterior é conferida antes de valer — ligar o motor reabre na hora.
  const engineActs = new Map<string, boolean>();
  const blockedOrgIds: string[] = [];
  const checkOrg = async (orgId: string): Promise<boolean> => {
    const known = engineActs.get(orgId);
    if (known !== undefined) return known;
    const acts = await canEngineAct(orgId);
    engineActs.set(orgId, acts);
    if (acts) {
      blockedOrgHint.delete(orgId);
    } else {
      blockedOrgHint.add(orgId);
      blockedOrgIds.push(orgId);
    }
    return acts;
  };
  for (const orgId of [...blockedOrgHint]) {
    if (organizationId && orgId !== organizationId) continue;
    await checkOrg(orgId);
  }

  const items: StuckInboundItem[] = [];
  const seenIds: string[] = [];
  let distributed = 0;
  let queued = 0;
  let released = 0;
  let failed = 0;
  let skipped = 0;

  for (let page = 0; page < MAX_PAGES && items.length < limit; page++) {
    const rows = await listStuckInbound({
      now,
      stuckMs,
      sinceMs,
      limit,
      organizationId,
      excludeIds: seenIds,
      blockedOrgIds,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      seenIds.push(row.conversation_id);
      if (items.length >= limit) continue;

      // Org com o motor parado descoberta nesta página: as próximas
      // consultas já saem sem ela; aqui só não chama o handoff.
      if (row.assigned_to_id === null && !(await checkOrg(row.organization_id))) {
        continue;
      }

      // Número aposentado: não desatribui nem enfileira — ninguém atende ali.
      if (
        isRetiredWhatsAppChannel({
          name: row.channel_name,
          phoneNumber: row.channel_phone,
          config: row.channel_config,
        })
      ) {
        skipped++;
        continue;
      }

      const inboundAt = new Date(row.last_inbound_at).getTime();
      const idleMinutes = Math.round((now.getTime() - inboundAt) / 60_000);
      const base: StuckInboundItem = {
        conversationNumber: row.conversation_number,
        contact: row.contact_name ?? "?",
        phone: row.contact_phone,
        lastInboundAt: new Date(row.last_inbound_at).toISOString(),
        idleMinutes,
        status: "listed",
        department: null,
        assignedTo: null,
      };

      const attempt = await readAttempt(row.conversation_id, inboundAt);
      const waiting = attempt !== null && attempt.retryAt > now.getTime();

      if (!apply) {
        items.push(
          waiting
            ? {
                ...base,
                reason: `em espera — nova tentativa em ${new Date(attempt.retryAt).toISOString()}`,
              }
            : base,
        );
        continue;
      }

      // Já tratada para este inbound e ainda dentro da espera: nada mudou
      // que a varredura possa resolver. Não chama o handoff.
      if (waiting) {
        skipped++;
        continue;
      }

      try {
        // Pack do agente da conversa (pode não ter): a rede de segurança
        // é genérica — enfileirar/distribuir não é regra de vertical.
        const agent = await resolveAgentVerticalForConversation(
          row.conversation_id,
          row.organization_id,
        );
        const result = await withSystemContext(row.organization_id, () =>
          executeDepartmentHandoff({
            ops: agent.ops,
            policy: agent.inboxPolicy,
            conversationId: row.conversation_id,
            contactId: row.contact_id,
            reason: `IA sem responder há ${idleMinutes} min — distribuição de segurança`,
          }),
        );
        const assigned =
          result.distribution?.success && result.distribution.selectedUserId
            ? (result.distribution.selectedUserName ?? "atribuído")
            : null;
        const inQueue =
          !assigned && QUEUED_REASONS.has(result.distribution?.reason ?? "");
        if (assigned) {
          distributed++;
        } else {
          if (inQueue) queued++;
          else released++;
          await writeAttempt({
            conversationId: row.conversation_id,
            inboundAt,
            previous: attempt,
            now,
            baseMs,
          });
        }
        items.push({
          ...base,
          status: assigned ? "distributed" : inQueue ? "queued" : "released",
          department: result.departmentName,
          assignedTo: assigned,
          reason: result.distribution?.reason,
        });
      } catch (err) {
        failed++;
        await writeAttempt({
          conversationId: row.conversation_id,
          inboundAt,
          previous: attempt,
          now,
          baseMs: Math.min(baseMs, STUCK_RETRY_FAILED_BASE_MS),
        });
        items.push({
          ...base,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
        log.error(
          { conv: row.conversation_id, err: err instanceof Error ? err.message : err },
          "[ai-stuck-inbound] falha",
        );
      }
    }

    // Página incompleta: não há mais candidatas.
    if (rows.length < limit) break;
  }

  if (distributed > 0 || queued > 0 || released > 0) {
    log.info(
      {
        distribuidas: distributed,
        enfileiradas: queued,
        soltas: released,
        puladas: skipped,
        candidatas: items.length,
      },
      "[ai-stuck-inbound] resumo",
    );
  }

  return {
    apply,
    stuckMs,
    sinceMs,
    candidates: items.length,
    distributed,
    queued,
    released,
    failed,
    skipped,
    items,
  };
}
