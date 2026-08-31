import { auth } from "@/lib/auth";
import { applyBrowserApiCors } from "@/lib/browser-api-cors";
import { sseBus } from "@/lib/sse-bus";

export const dynamic = "force-dynamic";

/**
 * Stream SSE de eventos do CRM. Multi-tenant fail-closed: a inscricao no
 * bus passa o organizationId da sessao, e o bus so dispara eventos cuja
 * organizationId corresponde (super-admin ve tudo).
 *
 * Antes (24/abr/26) o subscriber recebia TODOS os eventos do bus sem
 * filtro — operador da org A via metadados de eventos da org B no stream.
 * Corrigido junto com a inclusao de organizationId obrigatorio no envelope
 * de cada publish.
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
    organizationId?: string | null;
    isSuperAdmin?: boolean;
  };
  const organizationId = sessionUser.organizationId ?? null;
  const isSuperAdmin = Boolean(sessionUser.isSuperAdmin);

  // Sessao sem org E sem super-admin = nao tem nada pra escutar.
  // Fail-closed: 403 explicito em vez de stream vazio silencioso.
  if (!organizationId && !isSuperAdmin) {
    return sseError(request, "Sem organização vinculada à sessão", 403);
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 60_000);

      unsubscribe = sseBus.subscribe(
        { organizationId, isSuperAdmin },
        (event, envelope) => {
          try {
            // Repassa apenas `data` pro cliente (mantem compat com o
            // formato anterior), mas o bus ja garantiu o filtro por org.
            const payload = `event: ${event}\ndata: ${JSON.stringify(envelope.data)}\n\n`;
            controller.enqueue(encoder.encode(payload));
          } catch {
            /* client disconnected */
          }
        },
      );

      void new Promise<void>((resolve) => {
        const checkClosed = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(""));
          } catch {
            clearInterval(checkClosed);
            clearInterval(heartbeat);
            unsubscribe?.();
            resolve();
          }
        }, 10_000);
      });
    },
    cancel() {
      unsubscribe?.();
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
