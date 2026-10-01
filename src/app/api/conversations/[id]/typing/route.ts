import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { channelSendsReadReceipts } from "@/lib/channels/config";
import { publishTypingEvent } from "@/lib/realtime-events";

type RouteContext = { params: Promise<{ id: string }> };

// Bug 29/mai/26 — duas tentativas:
//   1) `auth()` direto -> sem RequestContext, chain getOrgIdOrThrow explodia.
//   2) `requireAuth()` que faz `storage.enterWith()` -> em teoria propaga pro
//      caller, mas na prática (com NextAuth `auth()` antes do enterWith) o
//      contexto se perdia ao retornar pro handler. Stack continuou apontando
//      pra mesma linha do requireConversationAccess.
// Solução final: `withOrgContext` que usa `storage.run(ctx, fn)` —
// determinístico, toda a continuation roda dentro do scope. Mesmo padrão
// do fix em /api/templates/route.ts.
export async function POST(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      // CRITICO: typing indicator tem que sair pelo canal da conversa
      // (token/phoneId desse tenant). Sem isso, "digitando..." aparecia no
      // numero da Eduit (singleton global do env) mesmo quando o operador
      // estava digitando numa conversa da DNA.
      const conv = await prisma.conversation.findUnique({
        where: { id },
        select: {
          organizationId: true,
          contactId: true,
          channelRef: { select: { id: true, config: true } },
        },
      });

      // Evento SSE `typing` para os OUTROS agentes da conversa — sai
      // independente do canal (Meta sem config / sem recibo de leitura
      // continua mostrando "digitando…" no CRM). Throttle por
      // (conversa, agente) em `realtime-events.ts`.
      if (conv?.organizationId) {
        publishTypingEvent({
          organizationId: conv.organizationId,
          conversationId: id,
          contactId: conv.contactId ?? null,
          userId: session.user.id,
          userName: session.user.name ?? null,
        });
      }

      const channelConfig = conv?.channelRef?.config as
        | Record<string, unknown>
        | null
        | undefined;
      const metaClient = metaClientFromConfig(channelConfig);

      if (!metaClient.configured) {
        return NextResponse.json({ ok: false });
      }

      // O "digitando…" da Meta (sendTypingIndicator) sai no MESMO request que
      // marca a mensagem como lida (status:"read"). Se o canal está com a
      // confirmação de leitura desligada, pular o indicador evita vazar o
      // visto azul — Meta acopla os dois.
      if (!channelSendsReadReceipts(channelConfig)) {
        return NextResponse.json({ ok: false });
      }

      const lastInbound = await prisma.message.findFirst({
        where: { conversationId: id, direction: "in", externalId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { externalId: true },
      });

      if (!lastInbound?.externalId) {
        return NextResponse.json({ ok: false });
      }

      await metaClient.sendTypingIndicator(lastInbound.externalId);

      return NextResponse.json({ ok: true });
    } catch (e) {
      console.warn("[typing] error:", e);
      return NextResponse.json({ ok: false });
    }
  });
}
