import type { AppUserRole } from "@/lib/auth-types";
import { auth } from "@/lib/auth";
import { loadAuthzContext, canViewPipeline, canViewStage } from "@/lib/authz";
import { conversationBlockedByFunnel, funnelScopeOf } from "@/lib/authz/funnel-visibility";
import { applyBrowserApiCors } from "@/lib/browser-api-cors";
import {
  allowAllInboxSseCards,
  buildInboxSseCardGate,
  stripHiddenInboxSseCard,
  type InboxSseCardGate,
} from "@/lib/inbox-sse-card-visibility";
import { runWithContext } from "@/lib/request-context";
import { SSE_ACCESS_REVOKED } from "@/lib/sse-audience";
import { sseBus } from "@/lib/sse-bus";
import { watchSseMembership } from "@/lib/sse-membership-watch";

export const dynamic = "force-dynamic";

/**
 * Stream SSE de eventos do CRM.
 * Atendimento: filtro por organizationId da sessão (card por visibilidade).
 * Team-chat privado: audiência = membership (userId), sem bypass de super-admin.
 */
function sseError(request: Request, body: string, status: number): Response {
  const headers = new Headers();
  applyBrowserApiCors(request, { headers });
  return new Response(body, { status, headers });
}

export async function GET(request: Request) {
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

  let cardGate: InboxSseCardGate = allowAllInboxSseCards;
  if (sessionUser.id && sessionUser.role && organizationId && !isSuperAdmin) {
    try {
      cardGate = await runWithContext(
        { organizationId, userId: sessionUser.id, isSuperAdmin: false },
        () =>
          buildInboxSseCardGate({
            id: sessionUser.id!,
            role: sessionUser.role!,
            organizationId,
            isSuperAdmin: false,
          }),
      );
    } catch (e) {
      console.error("[sse] falha ao montar o gate de card do inbox:", e);
    }
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unwatchMembership: (() => void) | null = null;
  let closed = false;
  const convBlockCache = new Map<string, { at: number; blocked: boolean }>();

  function teardown() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unwatchMembership?.();
    unwatchMembership = null;
    unsubscribe?.();
    unsubscribe = null;
    closed = true;
  }

  const stream = new ReadableStream({
    start(controller) {
      const closeStream = () => {
        teardown();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      controller.enqueue(encoder.encode(": connected\n\n"));

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          closeStream();
        }
      }, 25_000);

      // Uma consulta por processo para todas as conexões (antes: uma por
      // conexão por minuto). Perdeu o acesso → sseBus.revokeUser fecha.
      unwatchMembership = watchSseMembership({ userId, organizationId, isSuperAdmin });

      unsubscribe = sseBus.subscribe(
        { organizationId, userId, isSuperAdmin },
        (event, envelope) => {
          if (closed) return;
          if (event === SSE_ACCESS_REVOKED) {
            closeStream();
            return;
          }
          void (async () => {
            try {
              if (closed) return;
              if (
                await sseEventHiddenByFunnel(
                  envelope.data,
                  {
                    userId: sessionUser.id ?? "",
                    organizationId,
                    isSuperAdmin,
                  },
                  convBlockCache,
                )
              ) {
                return;
              }
              if (closed) return;
              const data = stripHiddenInboxSseCard(envelope.data, cardGate, event);
              const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
              controller.enqueue(encoder.encode(payload));
            } catch {
              closeStream();
            }
          })();
        },
      );

      request.signal.addEventListener("abort", closeStream, { once: true });
    },
    cancel() {
      teardown();
    },
  });

  const headers = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  applyBrowserApiCors(request, { headers });

  return new Response(stream, { headers });
}

function readId(data: unknown, key: string): string | null {
  if (!data || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Não entrega evento de funil/etapa/conversa bloqueados para o assinante. */
async function sseEventHiddenByFunnel(
  data: unknown,
  user: { userId: string; organizationId: string | null; isSuperAdmin: boolean },
  convCache: Map<string, { at: number; blocked: boolean }>,
): Promise<boolean> {
  if (!user.organizationId || !user.userId || user.isSuperAdmin) return false;
  const pipelineId = readId(data, "pipelineId");
  const stageId = readId(data, "stageId");
  const conversationId = readId(data, "conversationId");
  if (!pipelineId && !stageId && !conversationId) return false;

  const ctx = await loadAuthzContext({
    userId: user.userId,
    organizationId: user.organizationId,
    isSuperAdmin: false,
  });
  if (!funnelScopeOf(ctx)) return false;
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
