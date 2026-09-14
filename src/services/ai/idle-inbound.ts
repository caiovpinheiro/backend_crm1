/**
 * Inbound ocioso (ok / obrigado / confirmação): não reabre automação,
 * não assume agente novo, não dispara gatilho de conversa/mensagem.
 * Cumprimento ("oi") continua no pipe. Política genérica — sem tenant if.
 *
 * Heurística síncrona primeiro. Texto curto ambíguo: agente ENCERRAMENTO
 * (ou qualquer IA ativa da org) classifica IDLE|DEMAND.
 */

import { getLogger } from "@/lib/logger";
import {
  classifyInboundIdleIntent,
  isIdleClosingText,
  messageHasMedia,
} from "@/lib/ai-agents/tabulation-classify-policy";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { DEFAULT_CHAT_MODEL, generateWithTools } from "@/services/ai/provider";
import { releaseOtherAutomationContexts } from "@/services/automation-context";
import { logEvent } from "@/services/activity-log";
import { sseBus } from "@/lib/sse-bus";

const log = getLogger("idle-inbound");

const AGENT_CLASSIFY_TIMEOUT_MS = 1200;

function readOpeningText(data: Record<string, unknown> | null | undefined): {
  content: string;
  messageType: string;
} {
  const d = data ?? {};
  const content =
    (typeof d.content === "string" ? d.content : null) ??
    (typeof d.text === "string" ? d.text : null) ??
    "";
  const messageType = typeof d.messageType === "string" ? d.messageType : "";
  return { content, messageType };
}

function looksLikeMedia(messageType: string): boolean {
  return messageHasMedia({
    direction: "in",
    content: "",
    messageType,
  });
}

async function classifyUnknownWithAgent(text: string): Promise<boolean> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return false;
  const agents = await prisma.aIAgentConfig.findMany({
    where: { organizationId: orgId, active: true },
    select: { id: true, archetype: true, model: true },
    take: 20,
  });
  const preferred =
    agents.find((a) => a.archetype === "ENCERRAMENTO") ?? agents[0];
  if (!preferred) return false;
  const apiKey = await tryGetAgentApiKey(preferred.id);
  if (!apiKey) return false;

  try {
    const result = await Promise.race([
      generateWithTools({
        model: preferred.model || DEFAULT_CHAT_MODEL,
        apiKey,
        temperature: 0,
        maxOutputTokens: 8,
        maxSteps: 1,
        system:
          "Classifique a mensagem do contato. Responda só IDLE ou DEMAND. " +
          "IDLE = ok, obrigado, confirmação, despedida, sem pedido novo. " +
          "DEMAND = dúvida, problema, pedido. Cumprimento (oi, bom dia) é DEMAND.",
        messages: [{ role: "user", content: text.slice(0, 400) }],
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("idle-classify-timeout")),
          AGENT_CLASSIFY_TIMEOUT_MS,
        );
      }),
    ]);
    const token = (result.text ?? "").trim().toUpperCase();
    return token.startsWith("IDLE");
  } catch (err) {
    log.debug(
      `classificador idle falhou: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/** true = não enfileirar automação / não assumir IA nova. */
export async function shouldSkipIdleInboundAutomation(
  data: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  const { isClosingProtocolEnabled } = await import(
    "@/services/automation-closing-protocol"
  );
  if (!(await isClosingProtocolEnabled())) return false;
  const { content, messageType } = readOpeningText(data);
  if (looksLikeMedia(messageType)) return false;
  const intent = classifyInboundIdleIntent(content);
  if (intent === "idle") return true;
  if (intent === "greeting" || intent === "demand") return false;
  if (!content.trim()) return false;
  return classifyUnknownWithAgent(content);
}

export function isIdleClosingInboundText(text: string | null | undefined): boolean {
  return isIdleClosingText(text);
}

/**
 * Ticket novo só com ack, depois de um encerrado no mesmo canal:
 * fecha sem tabulação e sem Encerramento.
 */
export async function maybeResolveIdleReopenTicket(args: {
  conversationId?: string | null;
  contactId: string;
  content?: string | null;
  messageType?: string | null;
}): Promise<boolean> {
  const { isClosingProtocolEnabled } = await import(
    "@/services/automation-closing-protocol"
  );
  if (!(await isClosingProtocolEnabled())) return false;
  if (!args.conversationId) return false;
  if (looksLikeMedia(args.messageType ?? "")) return false;
  if (!isIdleClosingText(args.content)) return false;

  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      id: true,
      status: true,
      channelId: true,
      assignedToId: true,
      organizationId: true,
      externalId: true,
    },
  });
  if (!conv || conv.status !== "OPEN" || conv.assignedToId) return false;

  const prior = await prisma.conversation.findFirst({
    where: {
      contactId: args.contactId,
      id: { not: conv.id },
      status: "RESOLVED",
      ...(conv.channelId ? { channelId: conv.channelId } : {}),
    },
    select: { id: true },
  });
  if (!prior) return false;

  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      status: "RESOLVED",
      closedAt: new Date(),
      assignedToId: null,
      updatedAt: new Date(),
    },
  });
  await releaseOtherAutomationContexts({
    contactId: args.contactId,
    conversationId: conv.id,
  }).catch(() => {});

  void logEvent({
    type: "CONVERSATION_CLOSED",
    entityType: "CONVERSATION",
    entityId: conv.id,
    entityLabel: conv.externalId ?? null,
    conversationId: conv.id,
    contactId: args.contactId,
    field: "status",
    oldValue: "OPEN",
    newValue: "RESOLVED",
    meta: { from: "OPEN", to: "RESOLVED", source: "idle_inbound" },
  });
  try {
    if (conv.organizationId) {
      sseBus.publish("conversation_updated", {
        organizationId: conv.organizationId,
        conversationId: conv.id,
        contactId: args.contactId,
        status: "RESOLVED",
      });
    }
  } catch {
    /* best-effort */
  }
  log.info(
    `reopen ocioso encerrado sem automação conv=${conv.id} contact=${args.contactId}`,
  );
  return true;
}

export async function shouldSkipNewAiForIdleInbound(args: {
  conversationId: string;
  userMessage?: string | null;
}): Promise<boolean> {
  const { isClosingProtocolEnabled } = await import(
    "@/services/automation-closing-protocol"
  );
  if (!(await isClosingProtocolEnabled())) return false;
  if (!isIdleClosingText(args.userMessage)) {
    const intent = classifyInboundIdleIntent(args.userMessage);
    if (intent !== "unknown") return false;
    const skip = await classifyUnknownWithAgent(args.userMessage ?? "");
    if (!skip) return false;
  }
  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: { assignedTo: { select: { type: true } } },
  });
  return conv?.assignedTo?.type !== "AI";
}
