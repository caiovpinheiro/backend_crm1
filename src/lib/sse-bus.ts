import IORedis from "ioredis";

import { scheduleBoardInvalidation, scheduleTabCountsInvalidation } from "@/lib/cache/keys";
import { metrics, safeLabel } from "@/lib/metrics";

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
 * Agora cada listener registra com `{ organizationId, isSuperAdmin }` e o
 * dispatcher so chama o listener se:
 *   - super-admin (vê tudo, pra debugger / painel /admin)
 *   - listener.organizationId === event.organizationId
 *
 * Eventos sem organizationId no envelope (caminho legado) sao DROPADOS
 * com warning — fail-closed.
 */

export type SseEventEnvelope = {
  organizationId: string | null;
  data: unknown;
};

type Listener = (event: string, envelope: SseEventEnvelope) => void;

type ListenerEntry = {
  organizationId: string | null;
  isSuperAdmin: boolean;
  fn: Listener;
};

const REDIS_CHANNEL = "crm:sse:events";

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
        try {
          const parsed = JSON.parse(msg) as {
            event?: string;
            organizationId?: string | null;
            data?: unknown;
          };
          if (typeof parsed.event !== "string") return;
          const envelope: SseEventEnvelope = {
            organizationId:
              typeof parsed.organizationId === "string" ? parsed.organizationId : null,
            data: parsed.data,
          };
          this.dispatch(parsed.event, envelope);
        } catch {
          /* ignore malformed */
        }
      });
      this.redisReady = true;
    })();

    try {
      await this.redisInitPromise;
    } catch (e) {
      console.error("[sse-bus] falha ao ligar Redis pub/sub:", e);
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
   * Inscreve um listener com filtro por org. Chamada por
   * /api/sse/messages com a sessao do usuario corrente.
   *
   * @param ctx.organizationId - tenant a filtrar. Se null + isSuperAdmin
   *                              false, o listener nao recebe NADA
   *                              (fail-closed para sessao sem org).
   * @param ctx.isSuperAdmin   - true => recebe todos os eventos sem filtro.
   */
  subscribe(
    ctx: { organizationId: string | null; isSuperAdmin: boolean },
    listener: Listener,
  ) {
    if (sseRedisPubSubEnabled()) {
      void this.ensureRedis().catch(() => {
        /* já logado */
      });
    }
    const entry: ListenerEntry = {
      organizationId: ctx.organizationId,
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
   * Publica evento. `organizationId` eh OBRIGATORIO no envelope —
   * publishers que ainda nao foram migrados emitem warning e o evento
   * cai no chao (fail-closed pra evitar leak).
   *
   * Ex.: sseBus.publish("new_message", { organizationId: conv.organizationId, conversationId, ... })
   */
  publish(event: string, data: unknown) {
    const orgId =
      data && typeof data === "object" && "organizationId" in data
        ? ((data as Record<string, unknown>).organizationId as string | null | undefined) ?? null
        : null;

    if (!orgId) {
      // fail-closed: sem org, ninguem recebe (exceto super-admin se for
      // intencional — nesses casos o publisher passa { organizationId: null,
      // _broadcast: true } e a flag _broadcast pode ser respeitada no
      // futuro). Por ora, dropamos e logamos pra detectar publishers
      // legados.
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `[sse-bus] publish "${event}" SEM organizationId no payload — evento dropado (multi-tenancy fail-closed).`,
        );
      }
      return;
    }

    // Mensagem nova deixa o cache-aside do board (TTL 45s) desatualizado:
    // os cards do Kanban/Flow continuariam com a prévia e o "aguardando
    // resposta" anteriores. Purgar aqui cobre TODOS os produtores (envio
    // manual, webhook Meta/Baileys, automação, IA) num ponto só. Feito
    // antes do fan-out pra que o refetch disparado pelo SSE no cliente já
    // encontre o cache limpo.
    //
    // `message_status` (ticks entregue→lida) fica de fora de propósito: são
    // vários eventos por mensagem e o ganho no card não paga o recompute do
    // board. Esses ticks acompanham o TTL / o poll de 30s.
    if (event === "new_message") {
      scheduleBoardInvalidation(orgId);
    }

    // Os badges das abas seguem a mesma lógica do board: o cliente refaz
    // `?counts=1` ~1s depois destes eventos. Invalidar aqui garante que esse
    // refetch encontre o cache limpo, em vez de recomputar a agregação por
    // acaso de TTL. `conversation_updated` cobre transferência, troca de
    // responsável e mudança de status — tudo que move conversa entre abas.
    if (event === "new_message" || event === "conversation_updated") {
      scheduleTabCountsInvalidation(orgId);
    }

    const envelope: SseEventEnvelope = { organizationId: orgId, data };

    metrics.sse.messages.inc({
      event: safeLabel(event),
      organization: safeLabel(orgId),
    });

    if (sseRedisPubSubEnabled()) {
      void (async () => {
        try {
          await this.ensureRedis();
          if (!this.redisPub) return;
          const payload = JSON.stringify({ event, organizationId: orgId, data });
          await this.redisPub.publish(REDIS_CHANNEL, payload);
        } catch (e) {
          console.error("[sse-bus] publish Redis:", e);
        }
      })();
      return;
    }

    this.dispatch(event, envelope);
  }

  private dispatch(event: string, envelope: SseEventEnvelope) {
    for (const entry of this.listeners) {
      // super-admin recebe tudo (debug/admin panel)
      // demais listeners: filtro estrito por org
      if (
        !entry.isSuperAdmin &&
        entry.organizationId !== envelope.organizationId
      ) {
        continue;
      }
      try {
        entry.fn(event, envelope);
      } catch {
        /* ignore */
      }
    }
  }
}

export const sseBus = new SseBus();

// Lazily start background services on first module load.
// This runs server-side only (sse-bus is never imported by client components).
let _bootstrapped = false;

function resolveAppMode(): string {
  return (process.env.APP_MODE ?? "api").trim().toLowerCase() || "api";
}

function isAutomationWorkerExternal(): boolean {
  return (process.env.AUTOMATION_WORKER_MODE ?? "").trim().toLowerCase() === "external";
}

/** Durante `next build`, o Next define NEXT_PHASE=phase-production-build; não há DB real no container de build. */
function shouldSkipBackgroundServices(): boolean {
  // Sweepers rodam em UM processo só. Em produção (workers externos):
  //   - APP_MODE=api NÃO sobe nenhum (senão duplica wait_for_reply / sessão).
  //   - worker-automation sobe o timeout (startTimeoutSweeper no próprio worker).
  //   - worker-whatsapp sobe o restante via startWhatsappOwnedSweepers().
  //   - worker-campaigns NÃO sobe sweepers de sessão (só campanha).
  // Import transitivo de sse-bus num worker-* NÃO deve auto-iniciar nada.
  // Dev local (APP_MODE=api/ausente, AUTOMATION_WORKER_MODE ≠ external)
  // mantém o bootstrap na API.
  if (process.env.NEXT_PHASE === "phase-production-build") return true;
  if (process.env.CRM_SKIP_BACKGROUND_SERVERS === "1") return true;
  const appMode = resolveAppMode();
  if (appMode !== "api") return true;
  return isAutomationWorkerExternal();
}

function bootstrapBackgroundServices() {
  if (_bootstrapped) return;
  _bootstrapped = true;

  if (shouldSkipBackgroundServices()) {
    if (
      resolveAppMode() === "api" &&
      isAutomationWorkerExternal() &&
      process.env.NEXT_PHASE !== "phase-production-build" &&
      process.env.CRM_SKIP_BACKGROUND_SERVERS !== "1"
    ) {
      console.info(
        "[sse-bus] sweepers desligados (APP_MODE=api, AUTOMATION_WORKER_MODE=external)",
      );
    }
    return;
  }

  // Sweepers no mesmo processo da API competem pelo pool no boot
  // (inbox + health + 6 timers). Atrasa o 1º tick para o Postgres
  // aceitar conexões e o GET /conversations não ficar atrás da fila.
  const bootDelayMs = Number(process.env.API_SWEEPER_BOOT_DELAY_MS) || 25_000;
  console.info(`[sse-bus] sweepers agendados em ${bootDelayMs}ms`);
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
      console.error("[sse-bus] failed to start system-presence sweeper:", e),
    );

  import("@/services/system-activity")
    .then(({ startSystemActivitySweeper }) => startSystemActivitySweeper())
    .catch((e) =>
      console.error("[sse-bus] failed to start system-activity sweeper:", e),
    );

  import("@/services/scheduled-messages-worker")
    .then(({ startScheduledMessagesWorker }) => startScheduledMessagesWorker())
    .catch((e) =>
      console.error("[sse-bus] failed to start scheduled-messages worker:", e),
    );

  import("@/services/stale-outbound-sweeper")
    .then(({ startStaleOutboundSweeper }) => startStaleOutboundSweeper())
    .catch((e) =>
      console.error("[sse-bus] failed to start stale outbound sweeper:", e),
    );

  import("@/services/ai-agent-inactivity-worker")
    .then(({ startAIAgentInactivityWorker }) => startAIAgentInactivityWorker())
    .catch((e) =>
      console.error("[sse-bus] failed to start ai-agent inactivity worker:", e),
    );

  import("@/services/whatsapp-session-expiry-sweeper")
    .then(({ startWhatsappSessionExpirySweeper }) =>
      startWhatsappSessionExpirySweeper(),
    )
    .catch((e) =>
      console.error("[sse-bus] failed to start session-expiry sweeper:", e),
    );

  import("@/services/activity-alert-push-sweeper")
    .then(({ startActivityAlertPushSweeper }) => startActivityAlertPushSweeper())
    .catch((e) =>
      console.error("[sse-bus] failed to start activity-alert push sweeper:", e),
    );
}

function startBackgroundSweepers() {
  import("@/services/automation-context")
    .then(({ startTimeoutSweeper }) => startTimeoutSweeper())
    .catch((e) => console.error("[sse-bus] failed to start timeout sweeper:", e));

  startWhatsappOwnedSweepers();
}
bootstrapBackgroundServices();
