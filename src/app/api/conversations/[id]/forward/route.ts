import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getConversationSession } from "@/lib/channel-session";
import { getContactWhatsAppTargets } from "@/lib/contact-whatsapp-target";
import { requireConversationAccess } from "@/lib/conversation-access";
import { touchChatLastMessageAt } from "@/lib/conversation-last-message";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { metaClientFromConfig, formatMetaSendError } from "@/lib/meta-whatsapp/client";
import { publishNewMessage } from "@/lib/realtime-events";
import { getConversationLite } from "@/services/conversations";
import { fireTrigger, buildMessageTriggerData } from "@/services/automation-triggers";
import { cancelPendingForConversation } from "@/services/scheduled-messages";
import { maskPhone } from "@/lib/pii-mask";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/conversations/[id]/forward");

type RouteContext = { params: Promise<{ id: string }> };

function buildForwardBody(params: {
  senderLabel: string;
  content: string;
  hasMedia: boolean;
}): string {
  const lines = [
    "📤 *Encaminhado*",
    "",
    `De: ${params.senderLabel}`,
    "──────────",
    params.content.trim() || "[Sem texto]",
  ];
  if (params.hasMedia) lines.push("", "_(Havia mídia na mensagem original — veja na conversa de origem.)_");
  const body = lines.join("\n");
  if (body.length > 4000) return `${body.slice(0, 3997)}…`;
  return body;
}

/**
 * Encaminha o texto de uma mensagem da conversa de origem para o contato da conversa alvo (WhatsApp).
 */
// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id: targetConversationId } = await context.params;

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      const b = body as Record<string, unknown>;
      const sourceConversationId =
        typeof b.sourceConversationId === "string" ? b.sourceConversationId.trim() : "";
      const messageRef = typeof b.messageRef === "string" ? b.messageRef.trim() : "";

      if (!sourceConversationId || !messageRef) {
        return NextResponse.json(
          { message: "sourceConversationId e messageRef são obrigatórios." },
          { status: 400 }
        );
      }

      if (sourceConversationId === targetConversationId) {
        return NextResponse.json(
          { message: "Escolha outra conversa para encaminhar." },
          { status: 400 }
        );
      }

      const deniedTarget = await requireConversationAccess(session, targetConversationId);
      if (deniedTarget) return deniedTarget;
      const deniedSource = await requireConversationAccess(session, sourceConversationId);
      if (deniedSource) return deniedSource;

      const targetConv = await getConversationLite(targetConversationId);
      const sourceConv = await getConversationLite(sourceConversationId);
      if (!targetConv || !sourceConv) {
        return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
      }

      const sourceMsg = await prisma.message.findFirst({
        where: {
          conversationId: sourceConversationId,
          OR: [{ id: messageRef }, { externalId: messageRef }],
          isPrivate: false,
          direction: { not: "system" },
        },
        select: {
          id: true,
          content: true,
          senderName: true,
          direction: true,
          mediaUrl: true,
          messageType: true,
        },
      });

      if (!sourceMsg) {
        return NextResponse.json({ message: "Mensagem não encontrada ou não pode ser encaminhada." }, { status: 404 });
      }

      const senderLabel =
        sourceMsg.direction === "in"
          ? (sourceMsg.senderName?.trim() || "Cliente")
          : (sourceMsg.senderName?.trim() || "Equipe");

      const hasMedia = Boolean(sourceMsg.mediaUrl?.trim());
      const content = buildForwardBody({
        senderLabel,
        content: sourceMsg.content,
        hasMedia,
      });

      // CRITICO: respeita o canal da conversa de DESTINO (nao o singleton
      // global do env). Sem isso, encaminhamentos saiam pelo numero da
      // primeira org configurada no .env -> leak entre tenants.
      const targetChannelConfig = targetConv.channelRef?.config as
        | Record<string, unknown>
        | null
        | undefined;
      const metaClient = metaClientFromConfig(targetChannelConfig);

      if (!metaClient.configured) {
        return NextResponse.json(
          {
            message:
              "Canal WhatsApp do destino sem credenciais Meta (accessToken/phoneNumberId). Configure em Canais.",
          },
          { status: 503 }
        );
      }

      const waTarget = await getContactWhatsAppTargets(targetConv.contactId);
      if (!waTarget) {
        return NextResponse.json(
          { message: "Contato de destino sem telefone nem BSUID WhatsApp." },
          { status: 400 }
        );
      }

      // Encaminhamento é envio humano de texto livre: mesmo bloqueio duro
      // da janela de 24h do POST /messages (rota session-only). ANTES do
      // message.create — encaminhamento bloqueado não marca erro na
      // conversa de destino.
      if (targetConv.channelRef?.provider === "META_CLOUD_API") {
        const targetSession = await getConversationSession(targetConv);
        if (!targetSession.active) {
          return NextResponse.json(
            {
              message: "Sessão de 24h encerrada neste canal. Envie um template.",
              code: "SESSION_CLOSED",
            },
            { status: 409 },
          );
        }
      }

      const senderName = session.user.name ?? session.user.email ?? "Agente";

      const saved = await prisma.message.create({
        data: withOrgFromCtx({
          conversationId: targetConversationId,
          channelId: targetConv.channelRef?.id ?? undefined,
          content,
          direction: "out",
          messageType: "text",
          senderName,
        }),
      });

      let externalId: string | null = null;
      let sendErrorMsg: string | null = null;
      try {
        const result = await metaClient.sendText(waTarget.to, content, waTarget.recipient);
        externalId = result.messages?.[0]?.id ?? null;
        log.info(
          {
            channel: targetConv.channelRef?.id ?? "ENV",
            to: maskPhone(waTarget.to),
            recipient: waTarget.recipient ?? null,
            wamid: externalId,
          },
          "[meta-forward] enviado",
        );
        if (externalId) {
          await prisma.message.update({
            where: { id: saved.id },
            data: { externalId, sendStatus: "sent" },
          });
        }
      } catch (sendErr) {
        sendErrorMsg = formatMetaSendError(sendErr);
        await prisma.message.update({
          where: { id: saved.id },
          data: { sendStatus: "failed", sendError: sendErrorMsg },
        }).catch(() => {});
      }

      try {
        await prisma.conversation.update({
          where: { id: targetConversationId },
          data: {
            lastMessageDirection: "out",
            hasAgentReply: true,
            hasHumanReply: true,
            ...(sendErrorMsg ? { hasError: true } : { hasError: false }),
          },
        });
        await touchChatLastMessageAt({
          conversationId: targetConversationId,
          message: saved,
        });
      } catch {
        /* optional columns */
      }

      fireTrigger("message_sent", {
        contactId: targetConv.contactId,
        data: buildMessageTriggerData({
          channel: "WhatsApp",
          channelId: targetConv.channelId,
          conversationId: targetConversationId,
          content: "[encaminhado]",
        }),
      }).catch(() => {});

      try {
        publishNewMessage({
          organizationId: targetConv.organizationId,
          conversationId: targetConversationId,
          contactId: targetConv.contactId,
          direction: "out",
          content,
          timestamp: saved.createdAt,
        });
      } catch {
        // best-effort
      }

      cancelPendingForConversation(targetConversationId, "agent_reply").catch(
        (err) =>
          log.warn({ err }, "[scheduled-messages] falha ao cancelar apos encaminhamento"),
      );

      return NextResponse.json(
        {
          message: {
            id: externalId ?? saved.id,
            content,
            createdAt: saved.createdAt.toISOString(),
            direction: "out",
            messageType: "text",
            senderName,
          },
          ...(sendErrorMsg ? { metaError: sendErrorMsg } : {}),
        },
        { status: 201 }
      );
    } catch (e: unknown) {
      log.error({ err: e }, "POST falhou");
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao encaminhar." },
        { status: 500 }
      );
    }
  });
}
