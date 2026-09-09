/**
 * Inbound do arquétipo ENCERRAMENTO: ok/obrigado → frase fixa + fecha
 * (dispara a automação Encerramento). Demanda nova → humano.
 */

import {
  FAREWELL_CLOSE_MESSAGE,
  isFarewellCloser,
} from "@/lib/ai-agents/farewell-closer";
import { getLogger } from "@/lib/logger";
import { closeAiOnlyConversation } from "@/services/ai/close-ai-conversation";
import { executeDepartmentHandoff } from "@/services/ai/department-handoff";
import { sendAgentMessage } from "@/services/ai/piloting-actions";
import {
  studentWrappedUp,
  userAcknowledgedAndClosed,
} from "@/verticals/academic/closure";

const log = getLogger("ai-farewell");

export function isClosingCourtesy(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  return userAcknowledgedAndClosed(text) || studentWrappedUp(text);
}

export async function handleFarewellCloserInbound(args: {
  conversationId: string;
  contactId: string;
  agentUserId: string;
  userMessage: string;
  autonomyMode: "AUTONOMOUS" | "DRAFT";
  simulateTyping: boolean;
  typingPerCharMs: number;
  markMessagesRead: boolean;
}): Promise<"closed" | "handoff" | "skipped"> {
  if (isClosingCourtesy(args.userMessage)) {
    const sent = await sendAgentMessage({
      conversationId: args.conversationId,
      contactId: args.contactId,
      agentUserId: args.agentUserId,
      autonomyMode: args.autonomyMode,
      text: FAREWELL_CLOSE_MESSAGE,
      kind: "farewell",
      channel: "meta",
      humanBehavior: {
        simulateTyping: args.simulateTyping,
        typingPerCharMs: args.typingPerCharMs,
        markMessagesRead: args.markMessagesRead,
      },
    });
    if (sent.status === "skipped") {
      log.warn(
        `farewell closer: envio pulado (${sent.reason}) conv=${args.conversationId}`,
      );
    }
    const closed = await closeAiOnlyConversation({
      conversationId: args.conversationId,
      contactId: args.contactId,
      allowAfterHumanReply: true,
      reason: "Despedida do contato",
    });
    log.info(
      `farewell closer: ${closed.closed ? "closed" : closed.reason} conv=${args.conversationId}`,
    );
    return closed.closed ? "closed" : "skipped";
  }

  await executeDepartmentHandoff({
    conversationId: args.conversationId,
    contactId: args.contactId,
    dealId: null,
    departmentName: null,
    userMessage: args.userMessage,
    reason: "Nova demanda — agente de encerramento não atende",
  });
  log.info(`farewell closer: handoff conv=${args.conversationId}`);
  return "handoff";
}

export { isFarewellCloser };
