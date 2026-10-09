import IORedis from "ioredis";

import {
  scheduleBoardInvalidationForMessage,
  withMessageBoardScope,
  type MessageBoardScope,
} from "@/lib/board-invalidation";
import {
  parseSseRedisMessage,
  serializeSseRedisBody,
  shouldDeliverSseEvent,
  SSE_ACCESS_REVOKED,
  isPrivateTeamChatEvent,
  type SseListenerCtx,
} from "@/lib/sse-audience";
import {
  scheduleTabCountsInvalidation,
  shouldInvalidateInboxTabCounts,
} from "@/lib/cache/keys";
import {
  shouldAttachInboxSseCard,
  withInboxSseCard,
} from "@/lib/inbox-sse-card";
import { redactNewMessageForUnlisted } from "@/lib/sse-redact";
import { metrics, safeLabel } from "@/lib/metrics";
import {
  isReplaySandboxActive,
  recordBlockedEffect,
} from "@/services/ai/replay-sandbox";
import { resolveApiSweepers, resolveAutomationExecution } from "@/lib/background-mode";
import { getLogger } from "@/lib/logger";

const log = getLogger("sse-bus");

/**
 * Multi-tenancy do SSE Bus
 * ───────────────────────
 * Cada evento precisa carregar `organizationId` no envelope. Antes (24/abr/26)
 * o bus broadcasted pra todos os listeners sem filtro — operador da org A
 * recebia metadados (conversationId, contactId, content preview) de eventos
 * da org B no stream SSE. Tecnicamente nao havia leak de DADOS porque os
 * GETs subsequentes ja sao tenant-scoped, mas era um leak de METADADOS e
 * um side-channel de timing (da pra detectar atividade em outras orgs).
 *
 * Agora cada listener registra com `{ organizationId, userId, isSuperAdmin }`.
 * Atendimento: filtro por org (super-admin vê eventos de inbox da plataforma).
 * Team-chat privado: só `audienceUserIds` resolvido no publisher pela
 * membership da sala — `isSuperAdmin` não bypassa.
 *
 * Eventos sem organizationId no envelope (caminho legado) sao DROPADOS
 * com warning — fail-closed.
 *
 * Contrato dos eventos (`src/lib/realtime-events.ts`)
 * ──────────────────────────────────────────────────
 * Este arquivo é só o transporte. Os nomes de evento, o formato de cada
 * payload e os publishers tipados ficam em `realtime-events.ts` — o único
 * módulo da aplicação que chama `sseBus.publish`
 * (`realtime-contract.test.ts` garante). O barramento acrescenta ao
 * payload: `card`/`cardOmitted` (snapshot do card do inbox) e, em
 * `new_message`, `pipelineIds`/`dealIds` (escopo do board, vindo do cache
 * contato → pipelines de `board-invalidation.ts`).
 *
 * `typing`: throttle no servidor de 1 evento a cada 3 s por (conversa,
 * origem, agente). Agente: `POST /api/conversations/:id/typing`. Contato
 * (`source: "contact"`): worker Baileys, `workers/baileys/contact-typing.ts`.
 * `scheduled_message_updated`: publicado ao criar, cancelar (manual ou
 * automático por resposta/encerramento), enviar e falhar; o cliente
 * invalida `["scheduled-messages", conversationId]`.
 *
 * Presença "quem está vendo" (`entity_viewers`, `src/lib/entity-presence.ts`):
 * TTL do viewer 90s; heartbeat de 25s enviado só pela aba líder do
 * navegador, que agrega as entidades abertas em todas as abas. As salas
 * moram no Redis (hash `presence:viewers:*`), então valem entre réplicas;
 * sem Redis, `Map` do processo.
 */

export type SseEventEnvelope = {
  organizationId: string | null;
  data: unknown;
  audienceUserIds?: string[];
  /**
   * Frame SSE (`event: …\ndata: …\n\n`) já codificado, calculado UMA vez
   * por `dispatch` e compartilhado por todos os listeners. A rota usa
   * este buffer quando entrega `data` sem alteração para o usuário; só
   * re-serializa quando o gate de visibilidade mudou o payload.
   */
  wire?: Uint8Array;
};

const sseFrameEncoder = new TextEncoder();

/** Codifica um evento no formato de linha do SSE. */
export function encodeSseFrame(event: string, data: unknown): Uint8Array {
  return sseFrameEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export type SsePublishOptions = {
  audienceUserIds?: string[];
};

type Listener = (event: string, envelope: SseEventEnvelope) => void;

type ListenerEntry = SseListenerCtx & {
  fn: Listener;
};

const REDIS_CHANNEL = "crm:sse:events";

/**
 * O `card` é enfeite (evita um GET na lista); o evento é obrigatório. Um
 * `findFirst` preso (pool esgotado) não pode segurar o fan-out — sem teto o
 * evento nunca chega ao browser e não sobra rastro de onde parou.
 *
 * O race libera o evento mas NÃO cancela a query: a conexão do pool segue
 * ocupada até ela terminar. Timeout aqui em volume é sintoma de pool
 * esgotado, não a doença.
 */
const INBOX_CARD_BUDGET_MS = 2_000;

async function inboxSseCardWithinBudget(
  event: string,
  data: unknown,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      withInboxSseCard(event, data),
      new Promise<unknown>((resolve) => {
        timer = setTimeout(() => {
          log.error(
            { event, budgetMs: INBOX_CARD_BUDGET_MS },
            "[sse-bus] card snapshot passou do orçamento — publicando sem card",
          );
          resolve(data);
        }, INBOX_CARD_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Escopo do board (`pipelineIds`/`dealIds`) de um `new_message`: enfeite
 * como o `card`. Vem do cache contato → pipelines (60 s) ou da consulta
 * única que já existia para a purga do board; se ela travar, o evento sai
 * sem escopo e o cliente usa o caminho antigo (casa o card pelo contato).
 */
async function boardScopeWithinBudget(
  scope: Promise<MessageBoardScope | null>,
): Promise<MessageBoardScope | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      scope,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), INBOX_CARD_BUDGET_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `cardOmitted: "budget"` quando o evento devia levar `card` e saiu sem ele
 * (timeout, erro ou linha não achada). O cliente distingue isto de
 * `"hidden"` (gate de visibilidade, na rota SSE): aqui ele busca o card
 * antes de decidir o alerta; lá o usuário não pode ver a conversa.
 */
export function markInboxCardOmittedByBudget(
  event: string,
  original: unknown,
  payload: unknown,
): unknown {
  if (!shouldAttachInboxSseCard(event, original)) return payload;
  if (!payload || typeof payload !== "object") return payload;
  const rec = payload as Record<string, unknown>;
  if (rec.card && typeof rec.card === "object") return payload;
  if (event === "new_message" && rec.direction === "in") {
    metrics.sse.inboundWithoutCard.inc({ reason: "budget" });
  }
  const omitted = { ...rec, cardOmitted: "budget" };
  // Sem card não há gate: ninguém sabe quem pode ver. Fail-closed no
  // conteúdo — quem tem o thread aberto refaz o GET.
  return event === "new_message" ? redactNewMessageForUnlisted(omitted) : omitted;
}

function sseRedisPubSubEnabled(): boolean {
  // Com REDIS_URL, liga pub/sub por padrão — necessário no EasyPanel
  // (várias réplicas): webhook cai numa instância e o EventSource noutra.
  // Opt-out explícito: SSE_ENABLE_REDIS_PUBSUB=0.
  const url = process.env.REDIS_URL?.trim();
  if (!url) return false;
  const flag = (process.env.SSE_ENABLE_REDIS_PUBSUB ?? "1").trim();
  return flag !== "0" && flag.toLowerCase() !== "false";
}

/**
 * Fan-out de eventos para clientes SSE com isolamento por org.
 * - Modo default (sem Redis): so processo local (uma replica Next).
 * - Com SSE_ENABLE_REDIS_PUBSUB=1 e REDIS_URL: publica no Redis; cada
 *   replica subscreve e notifica os seus listeners (varias instancias).
 */
class SseBus {
  private listeners = new Set<ListenerEntry>();
  private redisPub: IORedis | null = null;
  private redisSub: IORedis | null = null;
  private redisReady = false;
  private redisInitPromise: Promise<void> | null = null;

  private async ensureRedis(): Promise<void> {
    if (!sseRedisPubSubEnabled()) return;
    if (this.redisReady) return;
    if (this.redisInitPromise) return this.redisInitPromise;

    const url = process.env.REDIS_URL!.trim();
    this.redisInitPromise = (async () => {
      this.redisSub = new IORedis(url, { maxRetriesPerRequest: null });
      this.redisPub = new IORedis(url, { maxRetriesPerRequest: null });
      await this.redisSub.subscribe(REDIS_CHANNEL);
      this.redisSub.on("message", (_ch, msg) => {
        this.ingestRedisMessage(msg);
      });
      this.redisReady = true;
    })();

    try {
      await this.redisInitPromise;
    } catch (e) {
      log.error({ err: e }, "[sse-bus] falha ao ligar Redis pub/sub");
      this.redisInitPromise = null;
      this.redisReady = false;
      this.redisSub?.disconnect();
      this.redisPub?.disconnect();
      this.redisSub = null;
      this.redisPub = null;
      throw e;
    }
  }

  /**
   * Inscreve um listener com filtro por org (atendimento) e por userId
   * (team-chat privado / revogação).
   */
  subscribe(
    ctx: {
      organizationId: string | null;
      userId: string | null;
      isSuperAdmin: boolean;
    },
    listener: Listener,
  ) {
    if (sseRedisPubSubEnabled()) {
      void this.ensureRedis().catch(() => {
        /* já logado */
      });
    }
    const entry: ListenerEntry = {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      isSuperAdmin: ctx.isSuperAdmin,
      fn: listener,
    };
    this.listeners.add(entry);
    metrics.sse.subscribers.inc({
      organization: safeLabel(ctx.organizationId, ctx.isSuperAdmin ? "super-admin" : "anon"),
      channel: "messages",
    });
    return () => {
      this.listeners.delete(entry);
      metrics.sse.subscribers.dec({
        organization: safeLabel(ctx.organizationId, ctx.isSuperAdmin ? "super-admin" : "anon"),
        channel: "messages",
      });
    };
  }

  /**
   * Fecha conexões SSE deste usuário nesta instância e avisa as outras
   * via Redis. Ordem: entregar `sse_access_revoked` → remover listeners
   * locais → publicar no Redis (réplicas fazem o mesmo no dispatch).
   */
  revokeUser(args: { userId: string; organizationId: string | null }) {
    const envelope: SseEventEnvelope = {
      organizationId: args.organizationId,
      data: { organizationId: args.organizationId, userId: args.userId },
      audienceUserIds: [args.userId],
    };
    const targets = [...this.listeners].filter((e) => e.userId === args.userId);
    for (const entry of targets) {
      try {
        entry.fn(SSE_ACCESS_REVOKED, envelope);
      } catch {
        /* ignore */
      }
      this.listeners.delete(entry);
    }
    void this.fanout(
      SSE_ACCESS_REVOKED,
      args.organizationId ?? "revoked",
      envelope.data,
      [args.userId],
    );
  }

  /**
   * Caminho da réplica: aplica o JSON já publicado em `crm:sse:events`.
   * Testes usam isto para simular distribuição Redis sem broker.
   */
  ingestRedisMessage(raw: string) {
    const parsed = parseSseRedisMessage(raw);
    if (!parsed) return;
    this.dispatch(parsed.event, {
      organizationId: parsed.organizationId,
      data: parsed.data,
      audienceUserIds: parsed.audienceUserIds,
    });
  }

  /**
   * Publica evento. `organizationId` eh OBRIGATORIO no envelope —
   * publishers que ainda nao foram migrados emitem warning e o evento
   * cai no chao (fail-closed pra evitar leak).
   *
   * Não chame direto: use o publisher do evento em `realtime-events.ts`
   * (`publishNewMessage`, `publishConversationUpdated`, …).
   *
   * `new_message` / `conversation_updated` that can land a ticket in the
   * inbox list get an extra `card` field (slim list DTO). See
   * `withInboxSseCard`. Old clients ignore it.
   */
  publish(event: string, data: unknown, opts?: SsePublishOptions) {
    const orgId =
      data && typeof data === "object" && "organizationId" in data
        ? ((data as Record<string, unknown>).organizationId as string | null | undefined) ?? null
        : null;

    // Replay com handoff real: o operador não pode ver conversa de teste
    // aparecendo no inbox dele.
    if (isReplaySandboxActive(orgId)) {
      recordBlockedEffect("sse_publish", event);
      return;
    }

    if (!orgId) {
      // fail-closed: sem org, ninguem recebe (exceto super-admin se for
      // intencional — nesses casos o publisher passa { organizationId: null,
      // _broadcast: true } e a flag _broadcast pode ser respeitada no
      // futuro). Por ora, dropamos e logamos pra detectar publishers
      // legados.
      //
      // Loga em produção também: o drop silencioso já apareceu como
      // "mensagem não atualiza no chat" sem nenhum rastro no servidor.
      log.error(
        { event },
        "[sse-bus] publish SEM organizationId no payload — evento dropado (multi-tenancy fail-closed).",
      );
      return;
    }

    const audienceUserIds = opts?.audienceUserIds;
    if (
      isPrivateTeamChatEvent(event) &&
      (!audienceUserIds || audienceUserIds.length === 0)
    ) {
      if (process.env.NODE_ENV !== "production") {
        log.warn(
          { event },
          "[sse-bus] publish SEM audienceUserIds — dropado (team-chat fail-closed).",
        );
      }
      return;
    }

    // Mensagem nova deixa o cache-aside do board (TTL 45s) desatualizado:
    // os cards do Kanban/Flow continuariam com a prévia e o "aguardando
    // resposta" anteriores. Purgar aqui cobre TODOS os produtores (envio
    // manual, webhook Meta/Baileys, automação, IA) num ponto só. Só os
    // pipelines onde o contato tem deal (ver `board-invalidation.ts`).
    // Começa antes do fan-out; o refetch do cliente sai ~800ms depois do SSE.
    //
    // `message_status` (ticks entregue→lida) fica de fora de propósito: são
    // vários eventos por mensagem e o ganho no card não paga o recompute do
    // board. Esses ticks acompanham o TTL / o poll de 30s.
    //
    // A mesma resolução (cache de 60 s ou UMA consulta) devolve o escopo
    // que o fan-out anexa ao evento: `pipelineIds` / `dealIds`.
    let boardScope: Promise<MessageBoardScope | null> | undefined;
    if (event === "new_message") {
      boardScope = scheduleBoardInvalidationForMessage(orgId, data).catch(
        () => null,
      );
    }

    // Badges: NÃO purgar em `new_message` (preview). O FE ainda recebe o
    // SSE e patcha o card; `?counts=1` deve bater no Redis (TTL 90s).
    // Purga só quando o payload indica mudança de aba.
    if (shouldInvalidateInboxTabCounts(event, data)) {
      scheduleTabCountsInvalidation(orgId);
    }

    metrics.sse.messages.inc({
      event: safeLabel(event),
      organization: safeLabel(orgId),
    });

    void this.fanout(event, orgId, data, audienceUserIds, boardScope);
  }

  private async fanout(
    event: string,
    orgId: string,
    data: unknown,
    audienceUserIds?: string[],
    boardScope?: Promise<MessageBoardScope | null>,
  ) {
    // Corre junto com o snapshot do card, não depois dele.
    const scopeWithinBudget = boardScope
      ? boardScopeWithinBudget(boardScope)
      : null;
    let payload = data;
    try {
      payload = await inboxSseCardWithinBudget(event, data);
    } catch (e) {
      log.error({ err: e }, "[sse-bus] inbox card snapshot");
    }
    payload = markInboxCardOmittedByBudget(event, data, payload);
    if (scopeWithinBudget) {
      payload = withMessageBoardScope(payload, await scopeWithinBudget);
    }

    const envelope: SseEventEnvelope = {
      organizationId: orgId,
      data: payload,
      audienceUserIds,
    };

    if (sseRedisPubSubEnabled()) {
      try {
        await this.ensureRedis();
        if (!this.redisPub) return;
        const body = serializeSseRedisBody({
          event,
          organizationId: orgId,
          data: payload,
          audienceUserIds,
        });
        await this.redisPub.publish(REDIS_CHANNEL, body);
      } catch (e) {
        log.error({ err: e }, "[sse-bus] publish Redis");
      }
      return;
    }

    this.dispatch(event, envelope);
  }

  private dispatch(event: string, envelope: SseEventEnvelope) {
    for (const entry of [...this.listeners]) {
      if (!shouldDeliverSseEvent(entry, event, envelope)) {
        continue;
      }
      // Serializa uma vez por evento, não uma vez por conexão: com N
      // conexões na org eram N `JSON.stringify` + N `encode` do mesmo
      // `card`. Só quando há pelo menos um destinatário.
      if (!envelope.wire) {
        envelope.wire = encodeSseFrame(event, envelope.data);
      }
      try {
        entry.fn(event, envelope);
      } catch {
        /* ignore */
      }
      if (event === SSE_ACCESS_REVOKED) {
        this.listeners.delete(entry);
      }
    }
  }
}

export const sseBus = new SseBus();

// Lazily start background services on first module load.
// This runs server-side only (sse-bus is never imported by client components).
let _bootstrapped = false;

function bootstrapBackgroundServices() {
  if (_bootstrapped) return;
  _bootstrapped = true;

  // Sweepers rodam em UM processo só. Em produção (workers externos):
  //   - APP_MODE=api NÃO sobe nenhum (senão duplica wait_for_reply / sessão).
  //   - worker-automation sobe o timeout (startTimeoutSweeper no próprio worker).
  //   - worker-whatsapp sobe o restante via startWhatsappOwnedSweepers().
  //   - worker-campaigns NÃO sobe sweepers de sessão (só campanha).
  // Import transitivo de sse-bus num worker-* NÃO deve auto-iniciar nada.
  // A decisão (padrão de produção = desligado; API_RUN_SWEEPERS=1 religa;
  // dev local mantém ligado) está em `resolveApiSweepers` (B5).
  const decision = resolveApiSweepers();
  if (decision.reason === "not_api" || decision.reason === "build" || decision.reason === "skip_flag") {
    return;
  }
  const automation = resolveAutomationExecution();
  if (!decision.enabled) {
    log.info(
      { reason: decision.reason, automationMode: automation.mode },
      "[sse-bus] sweepers desligados na API — rodam no worker-whatsapp e no worker-automation (API_RUN_SWEEPERS=1 religa)",
    );
    if (automation.mode === "inline") {
      log.warn(
        { automationMode: automation.mode },
        "[sse-bus] AUTOMATION_WORKER_MODE=inline na API: automação executa neste processo, não no worker-automation",
      );
    }
    return;
  }
  if (decision.reason === "explicit_on" && process.env.NODE_ENV === "production") {
    // Ligado à mão em produção: o worker-whatsapp e o worker-automation
    // também sobem os mesmos sweepers — só faz sentido sem esses workers.
    log.warn(
      { automationMode: automation.mode },
      "[sse-bus] API_RUN_SWEEPERS ligado em produção: sweepers também na API (duplicam o worker-whatsapp/worker-automation se eles estiverem no ar)",
    );
  }

  // Sweepers no mesmo processo da API competem pelo pool no boot
  // (inbox + health + 6 timers). Atrasa o 1º tick para o Postgres
  // aceitar conexões e o GET /conversations não ficar atrás da fila.
  const bootDelayMs = Number(process.env.API_SWEEPER_BOOT_DELAY_MS) || 25_000;
  log.info({ bootDelayMs }, "[sse-bus] sweepers agendados");
  setTimeout(() => startBackgroundSweepers(), bootDelayMs);
}

/**
 * Sweepers de sessão WhatsApp, presença, agendadas, IA e push.
 * Chamado pelo `worker-whatsapp`. Timeout de automação NÃO entra aqui —
 * fica só no `worker-automation`. worker-campaigns não chama isto.
 */
export function startWhatsappOwnedSweepers() {
  import("@/services/system-presence")
    .then(({ startSystemPresenceSweeper }) => startSystemPresenceSweeper())
    .catch((e) =>
      log.error({ err: e }, "[sse-bus] failed to start system-presence sweeper"),
    );

  import("@/services/system-activity")
    .then(({ startSystemActivitySweeper }) => startSystemActivitySweeper())
    .catch((e) =>
      log.error({ err: e }, "[sse-bus] failed to start system-activity sweeper"),
    );

  import("@/services/scheduled-messages-worker")
    .then(({ startScheduledMessagesWorker }) => startScheduledMessagesWorker())
    .catch((e) =>
      log.error({ err: e }, "[sse-bus] failed to start scheduled-messages worker"),
    );

  import("@/services/stale-outbound-sweeper")
    .then(({ startStaleOutboundSweeper }) => startStaleOutboundSweeper())
    .catch((e) =>
      log.error({ err: e }, "[sse-bus] failed to start stale outbound sweeper"),
    );

  import("@/services/ai-agent-inactivity-worker")
    .then(({ startAIAgentInactivityWorker }) => startAIAgentInactivityWorker())
    .catch((e) =>
      log.error({ err: e }, "[sse-bus] failed to start ai-agent inactivity worker"),
    );

  import("@/services/whatsapp-session-expiry-sweeper")
    .then(({ startWhatsappSessionExpirySweeper }) =>
      startWhatsappSessionExpirySweeper(),
    )
    .catch((e) =>
      log.error({ err: e }, "[sse-bus] failed to start session-expiry sweeper"),
    );

  import("@/services/activity-alert-push-sweeper")
    .then(({ startActivityAlertPushSweeper }) => startActivityAlertPushSweeper())
    .catch((e) =>
      log.error({ err: e }, "[sse-bus] failed to start activity-alert push sweeper"),
    );

  // Só lê activity_outbox de tabulação e grava activity_events.
  // Não entra na fila de mídia/envio do worker-whatsapp.
  import("@/services/activity-outbox")
    .then(({ startTabulationOutboxProjector }) =>
      startTabulationOutboxProjector(),
    )
    .catch((e) =>
      log.error({ err: e }, "[sse-bus] failed to start tabulation outbox projector"),
    );

  // Consumidor de CONVERSATION_CLOSED da mesma outbox (filtro por tipo: não
  // disputa linha com o projetor de tabulação). ACTIVITY_OUTBOX_WORKER=0
  // desliga; lote/intervalo em ACTIVITY_OUTBOX_WORKER_BATCH/_INTERVAL_MS.
  import("@/services/activity-outbox")
    .then(({ startConversationClosedOutboxProjector }) =>
      startConversationClosedOutboxProjector(),
    )
    .catch((e) =>
      log.error(
        { err: e },
        "[sse-bus] failed to start conversation-closed outbox projector",
      ),
    );
}

function startBackgroundSweepers() {
  import("@/services/automation-context")
    .then(({ startTimeoutSweeper }) => startTimeoutSweeper())
    .catch((e) => log.error({ err: e }, "[sse-bus] failed to start timeout sweeper"));

  startWhatsappOwnedSweepers();
}
bootstrapBackgroundServices();
