import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { sendTemplateToConversation } from "@/services/outbound-messaging";

import type { InboxMessageDto } from "../messages/route";

type RouteContext = { params: Promise<{ id: string }> };

type TemplateBody = {
  templateName?: unknown;
  languageCode?: unknown;
  components?: unknown;
  bodyPreview?: unknown;
  /** ID Graph do template (Meta `message_templates.id`) — melhora envio de templates com botão FLOW. */
  templateGraphId?: unknown;
  /** Token Flow (opcional); vazio = o servidor gera UUID v4 por envio e persiste em `Message.flowToken`. */
  flowToken?: unknown;
  /** JSON com dados iniciais do formulário / `navigate` — ver docs WhatsApp Flows. */
  flowActionData?: unknown;
  /**
   * Override do canal de saída (11/ago/26). Ausente = usa o canal da própria
   * conversa. Presente = força um outro canal WhatsApp CONNECTED da mesma
   * org — usado quando o canal original está DISCONNECTED e o operador
   * precisa mandar template por outro número.
   */
  channelId?: unknown;
};

// Bug 24/abr/26: usavamos `auth()` direto. O envio depende da Prisma
// extension multi-tenant pra resolver organizationId; sem o AsyncLocalStorage
// scope ativo o template "nao saia". withOrgContext envolve em runWithContext.
//
// 03/ago/26: a logica de envio saiu daqui para `services/outbound-messaging`,
// compartilhada com `POST /api/deals/:id/messages` (node do n8n). Esta rota
// permanece como a porta de entrada da UI: sessao + acesso a conversa.
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      const b = body as TemplateBody;
      const result = await sendTemplateToConversation({
        conversationId: id,
        actor: {
          id: session.user.id as string,
          name: session.user.name,
          email: session.user.email,
          role: session.user.role,
          organizationId: session.user.organizationId,
          isSuperAdmin: session.user.isSuperAdmin,
        },
        templateName: typeof b.templateName === "string" ? b.templateName : "",
        languageCode: typeof b.languageCode === "string" ? b.languageCode : null,
        components: Array.isArray(b.components) ? (b.components as unknown[]) : null,
        bodyPreview: typeof b.bodyPreview === "string" ? b.bodyPreview : null,
        templateGraphId: typeof b.templateGraphId === "string" ? b.templateGraphId : null,
        flowToken: typeof b.flowToken === "string" ? b.flowToken : null,
        flowActionData:
          b.flowActionData && typeof b.flowActionData === "object" && !Array.isArray(b.flowActionData)
            ? (b.flowActionData as Record<string, unknown>)
            : null,
        channelId: typeof b.channelId === "string" && b.channelId.trim() ? b.channelId.trim() : null,
      });

      if (!result.ok) {
        return NextResponse.json({ message: result.message }, { status: result.status });
      }

      // Paridade com POST texto: pending + id interno até o worker gravar
      // o wamid. Se o fallback síncrono já mandou, id continua = wamid.
      const sendStatus = result.sendStatus ?? (result.message.externalId ? "sent" : "pending");
      const dto: InboxMessageDto = {
        id: result.message.externalId ?? result.message.id,
        content: result.message.content,
        createdAt: result.message.createdAt,
        direction: "out",
        messageType: "template",
        senderName: result.message.senderName,
        sendStatus,
        status:
          sendStatus === "failed" ? "FAILED" : sendStatus === "sent" ? "SENT" : "PENDING",
      };

      return NextResponse.json(
        {
          message: dto,
          conversationId: result.conversationId,
          ...(result.reopenedConversationId
            ? { reopenedConversationId: result.reopenedConversationId }
            : {}),
          ...(result.metaError ? { metaError: result.metaError } : {}),
        },
        { status: 201 },
      );
    } catch (e: unknown) {
      console.error(e);
      const msg = e instanceof Error ? e.message : "Erro ao enviar template.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
