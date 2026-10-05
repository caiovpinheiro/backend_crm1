import {
  isApiDraining,
  registerSseStream,
  sseShutdownRetryAfterSec,
} from "@/lib/api-shutdown";
import type { AppUserRole } from "@/lib/auth-types";
import { auth } from "@/lib/auth";
import {
  loadAuthzContext,
  canViewPipeline,
  canViewStage,
  type AuthzContext,
} from "@/lib/authz";
import { projectDealMovedForViewer } from "@/lib/authz/deal-moved-visibility";
import { conversationBlockedByFunnel, funnelScopeOf } from "@/lib/authz/funnel-visibility";
import { applyBrowserApiCors } from "@/lib/browser-api-cors-node";
import {
  allowAllInboxSseCards,
  buildInboxSseCardGate,
  stripHiddenInboxSseCard,
  type InboxSseCardGate,
} from "@/lib/inbox-sse-card-visibility";
import { getLogger } from "@/lib/logger";
import { metrics } from "@/lib/metrics";
import { runWithContext } from "@/lib/request-context";
import { SSE_ACCESS_REVOKED } from "@/lib/sse-audience";
import { encodeSseFrame, sseBus } from "@/lib/sse-bus";
import {
  SSE_EVICTED_EVENT,
  SSE_HEARTBEAT_MS,
  acquireSseConnection,
} from "@/lib/sse-connection-limit";
import { watchSseMembership } from "@/lib/sse-membership-watch";

export const dynamic = "force-dynamic";

const log = getLogger("sse");

/**
 * Contexto de authz memorizado por conexão. Antes: `loadAuthzContext`
 * (Redis GET + parse) por evento × por conexão, mesmo para quem não tem
 * restrição de funil. Perda de acesso chega por `sse_access_revoked`
 * (fecha o stream); mudança de grants entra no próximo ciclo do TTL.
 */
const SSE_AUTHZ_CTX_TTL_MS = 45_000;

/** Gate fail-closed: usado enquanto o gate real não pôde ser montado. */
const denyAllInboxSseCards: InboxSseCardGate = () => false;
/** Nova tentativa de montar o gate após falha: base + jitter de até 1×. */
const SSE_CARD_GATE_RETRY_MS = 15_000;

/**
 * Stream SSE de eventos do CRM.
 * Atendimento: filtro por organizationId da sessão (card por visibilidade).
 * Team-chat privado: audiência = membership (userId), sem bypass de super-admin.
 */
async function sseError(
  request: Request,
  body: string,
  status: number,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const headers = new Headers(extraHeaders);
  await applyBrowserApiCors(request, { headers });
  return new Response(body, { status, headers });
}

export async function GET(request: Request) {
  // Réplica em parada graciosa: não aceita stream novo (o cliente volta
  // depois do Retry-After, já na réplica nova).
  if (isApiDraining()) {
    metrics.sse.connectionsRejected.inc({ reason: "draining" });
    return sseError(request, "Servidor reiniciando. Tente novamente em instantes.", 503, {
      "Retry-After": String(sseShutdownRetryAfterSec()),
    });
  }

  const session = await auth();
  if (!session?.user) {
    return sseError(request, "Não autorizado", 401);
  }

  const sessionUser = session.user as {
    id?: string;
    role?: AppUserRole;
    organizationId?: string | null;
    isSuperAdmin?: boolean;
  };
  const userId = sessionUser.id ?? null;
  const organizationId = sessionUser.organizationId ?? null;
  const isSuperAdmin = Boolean(sessionUser.isSuperAdmin);

  if (!userId) {
    return sseError(request, "Não autorizado", 401);
  }

  if (!organizationId && !isSuperAdmin) {
    return sseError(request, "Sem organização vinculada à sessão", 403);
  }

  // SSE-2: teto por org (429) e por usuário (a mais antiga do usuário sai
  // para esta entrar — `evictStream` é preenchido quando o stream existe).
  let evictedEarly = false;
  let evictStream: (() => void) | null = null;
  const acquired = await acquireSseConnection({
    userId,
    organizationId,
    onEvict: () => {
      if (evictStream) evictStream();
      else evictedEarly = true;
    },
  });
  if (!acquired.ok) {
    return sseError(
      request,
      "Limite de conexões SSE da organização atingido. Tente novamente em instantes.",
      429,
      { "Retry-After": String(acquired.retryAfterSec) },
    );
  }
  const slot = acquired.slot;

  let cardGate: InboxSseCardGate = allowAllInboxSseCards;
  const gateRole = sessionUser.role;
  const buildCardGate =
    gateRole && organizationId && !isSuperAdmin
      ? async (): Promise<InboxSseCardGate> =>
          runWithContext({ organizationId, userId, isSuperAdmin: false }, () =>
            buildInboxSseCardGate({
              id: userId,
              role: gateRole,
              organizationId,
              isSuperAdmin: false,
            }),
          )
      : null;
  // V-INF-2: falha ao montar o gate (pool cheio na reconexão em massa pós-
  // deploy) NÃO libera tudo: nega todo card até remontar. Sem card o evento
  // sai como `cardOmitted: "hidden"` (sem conteúdo em `new_message`).
  let cardGateFailed = false;
  if (buildCardGate) {
    try {
      cardGate = await buildCardGate();
    } catch (e) {
      log.error(
        { err: e },
        "[sse] falha ao montar o gate de card do inbox — negando cards até remontar",
      );
      cardGate = denyAllInboxSseCards;
      cardGateFailed = true;
    }
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unwatchMembership: (() => void) | null = null;
  let closed = false;
  let unregisterShutdown: (() => void) | null = null;
  let cardGateRetry: ReturnType<typeof setTimeout> | null = null;
  const convBlockCache = new Map<string, { at: number; blocked: boolean }>();

  // Remonta o gate de card depois de uma falha (até conseguir ou a conexão
  // fechar). Até lá o `denyAllInboxSseCards` segue valendo.
  const scheduleCardGateRetry = () => {
    if (closed || !buildCardGate) return;
    const delay = SSE_CARD_GATE_RETRY_MS + Math.floor(Math.random() * SSE_CARD_GATE_RETRY_MS);
    cardGateRetry = setTimeout(() => {
      cardGateRetry = null;
      if (closed) return;
      buildCardGate()
        .then((gate) => {
          if (closed) return;
          cardGate = gate;
          log.info({ userId, organizationId }, "[sse] gate de card do inbox remontado");
        })
        .catch((err) => {
          log.warn({ err, userId, organizationId }, "[sse] gate de card ainda falhando — nova tentativa");
          scheduleCardGateRetry();
        });
    }, delay);
    cardGateRetry.unref?.();
  };

  // RT-2: uma carga de ctx por conexão dentro do TTL (singleflight entre
  // eventos concorrentes da mesma conexão). Reset na revogação.
  let authzMemo: { ctx: AuthzContext; at: number } | null = null;
  let authzInflight: Promise<AuthzContext> | null = null;
  const resetAuthz = () => {
    authzMemo = null;
    authzInflight = null;
  };
  const resolveAuthz = (): Promise<AuthzContext> => {
    const now = Date.now();
    if (authzMemo && now - authzMemo.at < SSE_AUTHZ_CTX_TTL_MS) {
      return Promise.resolve(authzMemo.ctx);
    }
    if (authzInflight) return authzInflight;
    const pending = loadAuthzContext({
      userId,
      organizationId,
      isSuperAdmin: false,
    })
      .then((ctx) => {
        authzMemo = { ctx, at: Date.now() };
        return ctx;
      })
      .finally(() => {
        if (authzInflight === pending) authzInflight = null;
      });
    authzInflight = pending;
    return pending;
  };

  function teardown(): Promise<void> {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unwatchMembership?.();
    unwatchMembership = null;
    unsubscribe?.();
    unsubscribe = null;
    unregisterShutdown?.();
    unregisterShutdown = null;
    if (cardGateRetry) clearTimeout(cardGateRetry);
    cardGateRetry = null;
    closed = true;
    return slot.release();
  }

  const stream = new ReadableStream({
    start(controller) {
      const closeStream = () => {
        void teardown();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Teto por usuário: outra conexão deste usuário entrou e esta é a
      // mais antiga. Avisa o motivo e pede ao EventSource nativo que espere
      // antes de reconectar (evita rodízio entre abas); cliente custom lê o
      // evento. Depois fecha.
      const evictNow = () => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `retry: ${SSE_HEARTBEAT_MS * 2}\nevent: ${SSE_EVICTED_EVENT}\ndata: ${JSON.stringify({
                reason: "user_limit",
                retryAfterMs: SSE_HEARTBEAT_MS * 2,
              })}\n\n`,
            ),
          );
        } catch {
          /* já fechado */
        }
        closeStream();
      };
      evictStream = evictNow;
      if (evictedEarly) {
        evictNow();
        return;
      }

      // Parada graciosa (SIGTERM): `retry:` com jitter para espalhar a
      // reconexão, libera a vaga no Redis e fecha. Ver lib/api-shutdown.ts.
      const shutdownNow = (retryMs: number): Promise<void> | undefined => {
        if (closed) return undefined;
        try {
          controller.enqueue(
            encoder.encode(
              `retry: ${retryMs}\nevent: ${SSE_EVICTED_EVENT}\ndata: ${JSON.stringify({
                reason: "server_shutdown",
                retryAfterMs: retryMs,
              })}\n\n`,
            ),
          );
        } catch {
          /* já fechado */
        }
        const released = teardown();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return released;
      };
      if (isApiDraining()) {
        void shutdownNow(sseShutdownRetryAfterSec() * 1000);
        return;
      }
      unregisterShutdown = registerSseStream(shutdownNow);
      if (cardGateFailed) scheduleCardGateRetry();

      controller.enqueue(encoder.encode(": connected\n\n"));

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          closeStream();
          return;
        }
        void slot.heartbeat();
      }, SSE_HEARTBEAT_MS);

      // Uma consulta por processo para todas as conexões (antes: uma por
      // conexão por minuto). Perdeu o acesso → sseBus.revokeUser fecha.
      unwatchMembership = watchSseMembership({ userId, organizationId, isSuperAdmin });

      unsubscribe = sseBus.subscribe(
        { organizationId, userId, isSuperAdmin },
        (event, envelope) => {
          if (closed) return;
          if (event === SSE_ACCESS_REVOKED) {
            resetAuthz();
            closeStream();
            return;
          }
          void (async () => {
            // RT-1: erro no filtro de visibilidade (pool cheio, Redis
            // fora) NÃO é "cliente desconectou". Fechar aqui derrubava
            // todas as conexões não-admin da réplica de uma vez e a
            // reconexão em massa realimentava a pressão no pool. O evento
            // é descartado (fail-closed); o stream segue vivo.
            let data: unknown;
            try {
              if (closed) return;
              // `deal_moved` é por lado (origem/destino). O gate genérico
              // olha `pipelineId` singular e derrubaria o frame inteiro.
              let visible = envelope.data;
              if (event === "deal_moved") {
                const ctx = isSuperAdmin ? null : await resolveAuthz();
                const projected = projectDealMovedForViewer(visible, ctx);
                if (!projected) return;
                visible = projected;
              }
              if (closed) return;
              if (
                await sseEventHiddenByFunnel(
                  visible,
                  { organizationId, isSuperAdmin },
                  resolveAuthz,
                  convBlockCache,
                )
              ) {
                return;
              }
              if (closed) return;
              data = stripHiddenInboxSseCard(visible, cardGate, event);
            } catch (err) {
              log.warn(
                { err, event, userId, organizationId },
                "[sse] filtro de visibilidade falhou — evento descartado",
              );
              return;
            }
            // RT-3: payload intacto → reaproveita o frame serializado no
            // dispatch; só re-serializa quando o gate alterou o objeto.
            const frame =
              data === envelope.data && envelope.wire
                ? envelope.wire
                : encodeSseFrame(event, data);
            try {
              controller.enqueue(frame);
            } catch {
              // Só o enqueue indica stream fechado/errado.
              closeStream();
            }
          })();
        },
      );

      request.signal.addEventListener("abort", closeStream, { once: true });
    },
    cancel() {
      void teardown();
    },
  });

  const headers = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  await applyBrowserApiCors(request, { headers });

  return new Response(stream, { headers });
}

function readId(data: unknown, key: string): string | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Não entrega evento de funil/etapa/conversa bloqueados para o assinante.
 * `resolveAuthz` é o memo por conexão: no caso comum (admin/manager/sem
 * grants de funil) o gate inteiro sai sem tocar Redis ou Postgres.
 */
async function sseEventHiddenByFunnel(
  data: unknown,
  user: { organizationId: string | null; isSuperAdmin: boolean },
  resolveAuthz: () => Promise<AuthzContext>,
  convCache: Map<string, { at: number; blocked: boolean }>,
): Promise<boolean> {
  if (!user.organizationId || user.isSuperAdmin) return false;
  const pipelineId = readId(data, "pipelineId");
  const stageId = readId(data, "stageId");
  const conversationId = readId(data, "conversationId");
  if (!pipelineId && !stageId && !conversationId) return false;

  const ctx = await resolveAuthz();
  if (funnelScopeOf(ctx) === null) return false;
  if (pipelineId && !canViewPipeline(ctx, pipelineId)) return true;
  if (stageId && !canViewStage(ctx, stageId)) return true;
  if (!conversationId) return false;

  const cached = convCache.get(conversationId);
  const now = Date.now();
  if (cached && now - cached.at < 15_000) return cached.blocked;
  const blocked = await conversationBlockedByFunnel(
    user.organizationId,
    conversationId,
    ctx,
  );
  convCache.set(conversationId, { at: now, blocked });
  return blocked;
}
