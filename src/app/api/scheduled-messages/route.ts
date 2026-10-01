import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  createScheduledMessage,
  listPendingByConversation,
  ScheduledMessageValidationError,
} from "@/services/scheduled-messages";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/scheduled-messages");

/**
 * GET /api/scheduled-messages?conversationId=...
 * Lista agendamentos PENDING da conversa (ordem ASC por scheduledAt).
 * Usado pelo banner do composer.
 */
export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversationId");
    if (!conversationId) {
      return NextResponse.json(
        { message: "conversationId é obrigatório." },
        { status: 400 },
      );
    }

    const items = await listPendingByConversation(conversationId);
    return NextResponse.json({ items });
  } catch (e) {
    log.error({ err: e }, "GET /api/scheduled-messages error");
    return NextResponse.json(
      { message: "Erro ao listar mensagens agendadas." },
      { status: 500 },
    );
  }
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
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const uid = session.user.id as string;

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
}
