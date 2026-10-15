import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  CONVERSATION_ACCESS_SELECT,
  requireConversationAccess,
  requireConversationAccessAndLoad,
} from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import {
  createScheduledMessage,
  listPendingByConversation,
  ScheduledMessageValidationError,
} from "@/services/scheduled-messages";
import { getLogger } from "@/lib/logger";
import { etagMatches } from "@/lib/cache/response-cache";
import { scheduledListEtag } from "@/lib/cache/scheduled-versions";
import { recordConditionalResponse } from "@/lib/metrics";

const log = getLogger("api/scheduled-messages");

const SCHEDULED_CACHE_CONTROL = "private, no-cache";
const SCHEDULED_VARY = "Origin, Cookie, Authorization";

function scheduledCacheHeaders(etag: string): Record<string, string> {
  return { ETag: etag, "Cache-Control": SCHEDULED_CACHE_CONTROL, Vary: SCHEDULED_VARY };
}

/**
 * GET /api/scheduled-messages?conversationId=...
 * Lista agendamentos PENDING da conversa (ordem ASC por scheduledAt).
 * Usado pelo banner do composer. Mesma política do inbox:
 * 401 sem sessão, 404 se a conversa não existe, é de outra org ou o
 * usuário não tem visibilidade.
 *
 * Cache HTTP (gate de carga 15/10): `ETag` = versão da lista da conversa no
 * Redis (`lib/cache/scheduled-versions.ts`) + `rc_users` + org,
 * `Cache-Control: private, no-cache`. `If-None-Match` igual → 304 sem ler
 * a lista — só DEPOIS do acesso (sem acesso continua 404, nunca 304). A
 * lista muda por `scheduled_message_updated` (SSE), que sai junto do bump.
 */
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const { searchParams } = new URL(request.url);
      const conversationId = searchParams.get("conversationId");
      if (!conversationId) {
        return NextResponse.json(
          { message: "conversationId é obrigatório." },
          { status: 400 },
        );
      }

      // Acesso e org da conversa numa leitura só (a chave da versão é da
      // org DONA da conversa — o super-admin pode estar em outra).
      const access = await requireConversationAccessAndLoad(session, conversationId, (where) =>
        prisma.conversation.findFirst({ where, select: CONVERSATION_ACCESS_SELECT }),
      );
      if (access.response) return access.response;

      const orgId = access.conversation.organizationId;
      const routePath = new URL(request.url).pathname;
      // Versão lida ANTES do banco: versão velha + lista nova só custa um
      // 200 a mais; o contrário daria 304 para a lista velha.
      const etag = await scheduledListEtag(orgId, access.conversation.id);
      if (etag && etagMatches(request.headers.get("if-none-match"), etag)) {
        recordConditionalResponse(routePath, 304);
        return new NextResponse(null, { status: 304, headers: scheduledCacheHeaders(etag) });
      }

      const items = await listPendingByConversation(access.conversation.id);
      if (!etag) return NextResponse.json({ items });
      recordConditionalResponse(routePath, 200);
      return NextResponse.json({ items }, { headers: scheduledCacheHeaders(etag) });
    } catch (e) {
      log.error({ err: e }, "GET /api/scheduled-messages error");
      return NextResponse.json(
        { message: "Erro ao listar mensagens agendadas." },
        { status: 500 },
      );
    }
  });
}

/**
 * POST /api/scheduled-messages
 * Cria um agendamento. Body:
 *  {
 *    conversationId: string
 *    content: string
 *    scheduledAt: string (ISO)
 *    media?: { url, type?, name? }
 *    fallbackTemplate?: { name, params?, language? }
 *  }
 */
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const uid = session.user.id;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      const data = body as {
        conversationId?: unknown;
        content?: unknown;
        scheduledAt?: unknown;
        media?: {
          url?: unknown;
          type?: unknown;
          name?: unknown;
        } | null;
        fallbackTemplate?: {
          name?: unknown;
          params?: unknown;
          language?: unknown;
        } | null;
      };

      const conversationId =
        typeof data.conversationId === "string" ? data.conversationId.trim() : "";
      const content = typeof data.content === "string" ? data.content : "";
      const scheduledAtRaw =
        typeof data.scheduledAt === "string" ? data.scheduledAt : "";

      if (!conversationId) {
        return NextResponse.json(
          { message: "conversationId é obrigatório." },
          { status: 400 },
        );
      }
      const scheduledAt = new Date(scheduledAtRaw);
      if (Number.isNaN(scheduledAt.getTime())) {
        return NextResponse.json(
          { message: "scheduledAt inválido." },
          { status: 400 },
        );
      }

      const denied = await requireConversationAccess(session, conversationId);
      if (denied) return denied;

      const media =
        data.media && typeof data.media.url === "string"
          ? {
              url: data.media.url,
              type:
                typeof data.media.type === "string" ? data.media.type : null,
              name:
                typeof data.media.name === "string" ? data.media.name : null,
            }
          : null;

      const fallbackTemplate =
        data.fallbackTemplate && typeof data.fallbackTemplate.name === "string"
          ? {
              name: data.fallbackTemplate.name,
              params:
                data.fallbackTemplate.params &&
                typeof data.fallbackTemplate.params === "object"
                  ? (data.fallbackTemplate.params as Record<string, unknown>)
                  : null,
              language:
                typeof data.fallbackTemplate.language === "string"
                  ? data.fallbackTemplate.language
                  : null,
            }
          : null;

      const item = await createScheduledMessage({
        conversationId,
        createdById: uid,
        content,
        scheduledAt,
        media,
        fallbackTemplate,
      });

      return NextResponse.json(item, { status: 201 });
    } catch (e) {
      if (e instanceof ScheduledMessageValidationError) {
        return NextResponse.json(
          { message: e.message, code: e.code },
          { status: 400 },
        );
      }
      log.error({ err: e }, "POST /api/scheduled-messages error");
      return NextResponse.json(
        { message: "Erro ao criar mensagem agendada." },
        { status: 500 },
      );
    }
  });
}
