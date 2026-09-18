import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { prisma } from "@/lib/prisma";
import { sseBus } from "@/lib/sse-bus";

const APPROVE_SEND_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Aprova um rascunho da IA. O operador pode editar o texto antes de
 * aprovar (via `body.content`). O rascunho vira mensagem "real" (não
 * privada) e é enviado pro cliente via WhatsApp.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  return withOrgContext(async () => {
    try {
      const { messageId } = await params;

      const body = (await request.json().catch(() => ({}))) as {
        content?: string;
      };

      const draft = await prisma.message.findUnique({
        where: { id: messageId },
        include: {
          conversation: {
            select: {
              id: true,
              contactId: true,
              organizationId: true,
              // Trazer canal pra resolver cliente Meta correto (per-tenant).
              channelRef: { select: { id: true, config: true } },
            },
          },
        },
      });
      if (!draft || draft.messageType !== "ai_draft" || !draft.isPrivate) {
        return NextResponse.json(
          { message: "Rascunho não encontrado." },
          { status: 404 },
        );
      }

      const content = (body.content ?? draft.content).trim();
      if (!content) {
        return NextResponse.json(
          { message: "Conteúdo vazio." },
          { status: 400 },
        );
      }

      const channelConfig = draft.conversation.channelRef?.config as
        | Record<string, unknown>
        | null
        | undefined;
      const metaClient = metaClientFromConfig(channelConfig);

      if (!metaClient.configured) {
        return NextResponse.json(
          { message: "Canal WhatsApp da conversa sem credenciais Meta." },
          { status: 500 },
        );
      }
      const contact = draft.conversation.contactId
        ? await prisma.contact.findUnique({
            where: { id: draft.conversation.contactId },
            select: { phone: true },
          })
        : null;
      if (!contact?.phone) {
        return NextResponse.json(
          { message: "Contato sem telefone." },
          { status: 400 },
        );
      }

      let externalId: string | null = null;
      try {
        const send = await withTimeout(
          metaClient.sendText(contact.phone, content),
          APPROVE_SEND_TIMEOUT_MS,
          `Timeout ao enviar mensagem para Meta (${APPROVE_SEND_TIMEOUT_MS}ms).`,
        );
        externalId = send.messages?.[0]?.id ?? null;
      } catch (err) {
        return NextResponse.json(
          { message: err instanceof Error ? err.message : "Falha no envio." },
          { status: 502 },
        );
      }

      let senderName = "Agente IA";
      if (draft.aiAgentUserId) {
        const agentUser = await prisma.user.findUnique({
          where: { id: draft.aiAgentUserId },
          select: { name: true },
        });
        senderName = agentUser?.name?.trim() || senderName;
      }

      const approved = await prisma.message.update({
        where: { id: messageId },
        data: {
          content,
          messageType: "text",
          isPrivate: false,
          externalId,
          sendStatus: "sent",
          senderName,
        },
      });
      await prisma.conversation
        .update({
          where: { id: draft.conversation.id },
          data: {
            lastMessageDirection: "out",
            hasAgentReply: true,
            updatedAt: new Date(),
          },
        })
        .catch(() => null);
      sseBus.publish("message_updated", {
        organizationId: draft.conversation.organizationId,
        conversationId: draft.conversation.id,
        messageId,
        status: "approved",
      });
      return NextResponse.json(approved);
    } catch (err) {
      console.error("[ai-draft-approve] unexpected error:", err);
      return NextResponse.json(
        { message: "Erro ao aprovar rascunho do agente." },
        { status: 500 },
      );
    }
  });
}
