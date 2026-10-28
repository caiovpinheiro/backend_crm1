/**
 * Resposta do agente de IA numa conversa WEBCHAT (docs/decisoes/webchat-widget.md
 * §9.4): o mesmo caminho do texto do composer (§3.6) — grava a `out` com
 * `sendStatus = "sent"` e o widget busca em `GET /api/public/webchat/messages`.
 * Nenhuma API externa: nada de uma conversa webchat sai pela Meta/WhatsApp
 * (`outbound-guard`). Botões/lista viram o texto com as opções numeradas;
 * anexo do agente segue sem suporte (send-agent-media recusa).
 *
 * Chamado por `sendAgentMessage` depois das checagens comuns (anti-spam,
 * allowlist, canal conectado, autorização).
 */
import { noteMessageChange } from "@/lib/cache/message-versions";
import { botOutboundReplyMark } from "@/lib/conversation-reply-marking";
import { touchChatLastMessageAt } from "@/lib/conversation-last-message";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { publishNewMessage } from "@/lib/realtime-events";
import { getOrgIdOrNull } from "@/lib/request-context";
import { computeTypingDelayMs, typingDelayWithinBudget } from "@/lib/typing-delay";
import { markWebchatAgentTyping, WEBCHAT_AGENT_TYPING_TTL_SEC } from "@/lib/webchat/agent-typing";

const log = getLogger("ai.send-agent-webchat");

export type WebchatAgentSendResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** "Digitando…" no widget pelo tempo calculado (a chave expira em 6 s: renova). */
async function simulateWidgetTyping(orgId: string | null, conversationId: string, ms: number) {
  if (!orgId || ms <= 0) return;
  const step = Math.max(1000, (WEBCHAT_AGENT_TYPING_TTL_SEC - 2) * 1000);
  let left = ms;
  while (left > 0) {
    await markWebchatAgentTyping(orgId, conversationId);
    const wait = Math.min(step, left);
    await sleep(wait);
    left -= wait;
  }
}

export async function deliverAgentWebchatMessage(args: {
  conversationId: string;
  contactId: string;
  agentUserId: string;
  text: string;
  senderName: string;
  humanBehavior?: {
    simulateTyping: boolean;
    typingPerCharMs: number;
    maxTypingMs?: number;
    turnStartedAt?: number;
    abortIf?: () => Promise<boolean>;
  };
  /** Revalida a autorização logo antes de gravar (humano assumiu, etc.). */
  reauthorize?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}): Promise<WebchatAgentSendResult> {
  const orgId = getOrgIdOrNull();
  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: { channelId: true },
  });
  if (!conv) return { status: "skipped", reason: "conversation_not_found" };

  const hb = args.humanBehavior;
  if (hb?.simulateTyping) {
    const delay = typingDelayWithinBudget(
      computeTypingDelayMs(args.text.length, hb.typingPerCharMs),
      hb,
    );
    await simulateWidgetTyping(orgId, args.conversationId, delay);
  }
  if (hb?.abortIf) {
    let abort = false;
    try {
      abort = await hb.abortIf();
    } catch {
      abort = false;
    }
    if (abort) return { status: "skipped", reason: "superseded" };
  }
  if (args.reauthorize) {
    const auth = await args.reauthorize();
    if (!auth.ok) return { status: "skipped", reason: auth.reason };
  }

  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: args.conversationId,
      channelId: conv.channelId ?? undefined,
      content: args.text,
      direction: "out",
      messageType: "text",
      authorType: "bot",
      aiAgentUserId: args.agentUserId,
      senderName: args.senderName,
      sendStatus: "sent",
    }),
  });
  void noteMessageChange(saved.organizationId, saved.conversationId, "new", saved.id, saved.externalId);
  await prisma.conversation
    .update({
      where: { id: args.conversationId },
      data: { updatedAt: new Date(), hasError: false, ...(await botOutboundReplyMark()) },
    })
    .catch((err) => log.warn({ err, conversationId: args.conversationId }, "update do card falhou"));
  await touchChatLastMessageAt({ conversationId: args.conversationId, message: saved }).catch(() => null);
  publishNewMessage({
    organizationId: orgId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    direction: "out",
    content: args.text,
    senderName: args.senderName,
    timestamp: saved.createdAt,
  });
  return { status: "sent", messageId: saved.id };
}
