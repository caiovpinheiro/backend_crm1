/**
 * Protocolo genérico de encerramento (org toggle + passo de canvas).
 * Saídas Encerrar / Devolver são arestas — o destino é do fluxo, não do motor.
 */

import {
  classifyInboundIdleIntent,
  isIdleClosingText,
} from "@/lib/ai-agents/tabulation-classify-policy";
import { getLogger } from "@/lib/logger";
import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { DEFAULT_CHAT_MODEL, generateWithTools } from "@/services/ai/provider";
import { fireTrigger } from "@/services/automation-triggers";

const log = getLogger("closing-protocol");

export const CLOSING_PHASE_VAR = "__closingPhase";
export const DEFAULT_WAIT_MS = 3_600_000;
export const DEFAULT_CLOSING_WAIT_MS = 900_000;

export async function isClosingProtocolEnabled(): Promise<boolean> {
  return getOrgSettingBool("conversation.closingProtocolEnabled", false);
}

export function closingProtocolWaitMs(cfg: Record<string, unknown>): number {
  const n = Number(cfg.waitMs ?? cfg.timeoutMs ?? 0);
  return n > 0 ? n : DEFAULT_WAIT_MS;
}

export function closingProtocolClosingWaitMs(cfg: Record<string, unknown>): number {
  const n = Number(cfg.closingWaitMs ?? 0);
  return n > 0 ? n : DEFAULT_CLOSING_WAIT_MS;
}

export async function emitAttendanceClosing(args: {
  contactId: string;
  conversationId?: string | null;
}): Promise<void> {
  await fireTrigger("attendance_closing", {
    contactId: args.contactId,
    data: {
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      source: "closing_protocol",
    },
  }).catch((err) => {
    log.warn(
      `attendance_closing falhou: ${err instanceof Error ? err.message : err}`,
    );
  });
}

async function loadThreadForClosing(args: {
  contactId: string;
  conversationId?: string | null;
}): Promise<string> {
  const where = args.conversationId
    ? { conversationId: args.conversationId }
    : { contactId: args.contactId, isPrivate: false };
  const rows = await prisma.message.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 16,
    select: { direction: true, content: true, messageType: true },
  });
  return rows
    .reverse()
    .map((m) => {
      const who = m.direction === "in" ? "CONTATO" : "ATENDIMENTO";
      const text = (m.content ?? "").trim() || `[${m.messageType ?? "msg"}]`;
      return `${who}: ${text.slice(0, 240)}`;
    })
    .join("\n");
}

/** Encerrar = despedida; devolver = demanda nova. Sem destino hardcoded. */
export async function classifyClosingExit(args: {
  lastInbound: string;
  contactId: string;
  conversationId?: string | null;
}): Promise<"encerrar" | "devolver"> {
  if (isIdleClosingText(args.lastInbound)) return "encerrar";
  const intent = classifyInboundIdleIntent(args.lastInbound);
  if (intent === "demand") return "devolver";

  const orgAgents = await prisma.aIAgentConfig.findMany({
    where: { active: true },
    select: { id: true, archetype: true, model: true },
    take: 20,
  });
  const preferred =
    orgAgents.find((a) => a.archetype === "ENCERRAMENTO") ?? orgAgents[0];
  if (!preferred) {
    return intent === "idle" || intent === "greeting" ? "encerrar" : "devolver";
  }
  const apiKey = await tryGetAgentApiKey(preferred.id);
  if (!apiKey) {
    return intent === "idle" ? "encerrar" : "devolver";
  }

  const thread = await loadThreadForClosing(args);
  try {
    const result = await Promise.race([
      generateWithTools({
        model: preferred.model || DEFAULT_CHAT_MODEL,
        apiKey,
        temperature: 0,
        maxOutputTokens: 8,
        maxSteps: 1,
        system:
          "Você lê o histórico do atendimento. A última fala do contato " +
          "encerra o assunto ou reabre demanda? Responda só ENCERRAR ou DEVOLVER. " +
          "ENCERRAR = ok, obrigado, confirmação, despedida, sem pedido novo. " +
          "DEVOLVER = dúvida, problema, pedido, assunto novo.",
        messages: [
          {
            role: "user",
            content: `Histórico:\n${thread.slice(0, 3500)}\n\nÚltima fala do contato:\n${args.lastInbound.slice(0, 400)}`,
          },
        ],
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("closing-classify-timeout")), 2000);
      }),
    ]);
    const token = (result.text ?? "").trim().toUpperCase();
    if (token.startsWith("ENCERRAR") || token.startsWith("IDLE") || token.startsWith("CLOSE")) {
      return "encerrar";
    }
    if (token.startsWith("DEVOLVER") || token.startsWith("RETURN") || token.startsWith("DEMAND")) {
      return "devolver";
    }
  } catch (err) {
    log.debug(
      `classificador de encerramento: ${err instanceof Error ? err.message : err}`,
    );
  }
  return intent === "idle" ? "encerrar" : "devolver";
}
