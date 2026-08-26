import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { sendFlowToConversation } from "@/services/outbound-messaging";

import type { InboxMessageDto } from "../messages/route";

type RouteContext = { params: Promise<{ id: string }> };

type FlowBody = {
  flowDefinitionId?: unknown;
  body?: unknown;
  flowCta?: unknown;
  header?: unknown;
  footer?: unknown;
  channelId?: unknown;
};

/** POST /api/conversations/:id/flow — envia um WhatsApp Flow na janela 24h. */
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

      const b = body as FlowBody;
      const result = await sendFlowToConversation({
        conversationId: id,
        actor: {
          id: session.user.id as string,
          name: session.user.name,
          email: session.user.email,
          role: session.user.role,
          organizationId: session.user.organizationId,
          isSuperAdmin: session.user.isSuperAdmin,
        },
        flowDefinitionId: typeof b.flowDefinitionId === "string" ? b.flowDefinitionId : "",
        body: typeof b.body === "string" ? b.body : null,
        flowCta: typeof b.flowCta === "string" ? b.flowCta : null,
        header: typeof b.header === "string" ? b.header : null,
        footer: typeof b.footer === "string" ? b.footer : null,
        channelId: typeof b.channelId === "string" && b.channelId.trim() ? b.channelId.trim() : null,
      });

      if (!result.ok) {
        return NextResponse.json({ message: result.message }, { status: result.status });
      }

      const dto: InboxMessageDto = {
        id: result.message.externalId ?? result.message.id,
        content: result.message.content,
        createdAt: result.message.createdAt,
        direction: "out",
        messageType: "interactive",
        senderName: result.message.senderName,
      };

      return NextResponse.json(
        {
          message: dto,
          conversationId: result.conversationId,
          ...(result.reopenedConversationId
            ? { reopenedConversationId: result.reopenedConversationId }
            : {}),
        },
        { status: 201 },
      );
    } catch (e: unknown) {
      console.error(e);
      const msg = e instanceof Error ? e.message : "Erro ao enviar formulário.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
