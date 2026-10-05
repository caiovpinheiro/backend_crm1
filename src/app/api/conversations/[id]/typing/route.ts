import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { dispatchMetaTyping, resolveTypingTarget } from "@/lib/conversation-typing";
import { publishTypingEvent } from "@/lib/realtime-events";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/conversations/[id]/typing");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * "Digitando…" do agente, a cada 3 s enquanto há texto no composer.
 * Caminho quente: sessão → acesso em cache (60 s) → evento SSE `typing`.
 * O indicador da Meta sai fora da requisição, deduplicado por conversa
 * (`lib/conversation-typing.ts`).
 *
 * Resposta `{ ok }` — o front não lê (fire-and-forget). `ok: true` quando o
 * canal da conversa recebe o indicador da Meta.
 *
 * Bug 29/mai/26: `withOrgContext` (storage.run) — com `requireAuth` +
 * `enterWith` o contexto de org se perdia antes da checagem de acesso.
 */
export async function POST(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      const resolved = await resolveTypingTarget(session, id);
      if (resolved.response) return resolved.response;
      const target = resolved.target;

      // Evento SSE `typing` para os OUTROS agentes — independe do canal
      // (Meta sem config / sem recibo de leitura continua mostrando
      // "digitando…" no CRM). Throttle por (conversa, agente) em
      // `realtime-events.ts`.
      publishTypingEvent({
        organizationId: target.organizationId,
        conversationId: target.conversationId,
        contactId: target.contactId,
        userId: session.user.id,
        userName: session.user.name ?? null,
      });

      if (!target.metaTyping) return NextResponse.json({ ok: false });
      // Sem await: a Graph não segura a resposta (nunca lança).
      void dispatchMetaTyping(target);
      return NextResponse.json({ ok: true });
    } catch (e) {
      log.warn({ err: e }, "[typing] error");
      return NextResponse.json({ ok: false });
    }
  });
}
