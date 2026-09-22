import type { AppUserRole } from "@/lib/auth-types";
import { auth } from "@/lib/auth";
import { applyBrowserApiCors } from "@/lib/browser-api-cors";
import {
  allowAllInboxSseCards,
  buildInboxSseCardGate,
  stripHiddenInboxSseCard,
  type InboxSseCardGate,
} from "@/lib/inbox-sse-card-visibility";
import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import { SSE_ACCESS_REVOKED } from "@/lib/sse-audience";
import { sseBus } from "@/lib/sse-bus";

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
  let membershipWatch: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  function teardown() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (membershipWatch) clearInterval(membershipWatch);
    membershipWatch = null;
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

      membershipWatch = setInterval(() => {
        if (closed) return;
        void (async () => {
          try {
            const row = await prismaBase.user.findFirst({
              where: { id: userId },
              select: { isErased: true, organizationId: true },
            });
            const lost =
              !row ||
              row.isErased ||
              (organizationId != null &&
                row.organizationId !== organizationId &&
                !isSuperAdmin);
            if (lost) {
              sseBus.revokeUser({ userId, organizationId });
            }
          } catch {
            /* ignore */
          }
        })();
      }, 60_000);

      unsubscribe = sseBus.subscribe(
        { organizationId, userId, isSuperAdmin },
        (event, envelope) => {
          if (closed) return;
          if (event === SSE_ACCESS_REVOKED) {
            closeStream();
            return;
          }
          try {
            const data = stripHiddenInboxSseCard(envelope.data, cardGate);
            const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch {
            closeStream();
          }
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
