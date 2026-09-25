/**
 * Contadores de paradas do motor v2 (SPEC 3.16).
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";

export interface V2Counters {
  courtesyReplies: number;
  helpOffers: number;
  stalledExchanges: number;
  nonsenseMessages: number;
  loopCount: number;
  lastLoopMessage?: string;
  aiTransferCount: number;
  surveyPending: boolean;
}

export function defaultV2Counters(): V2Counters {
  return {
    courtesyReplies: 0,
    helpOffers: 0,
    stalledExchanges: 0,
    nonsenseMessages: 0,
    loopCount: 0,
    aiTransferCount: 0,
    surveyPending: false,
  };
}

export function parseV2Counters(raw: unknown): V2Counters {
  if (!raw || typeof raw !== "object") return defaultV2Counters();
  const r = raw as Record<string, unknown>;
  return {
    courtesyReplies: Number(r.courtesyReplies) || 0,
    helpOffers: Number(r.helpOffers) || 0,
    stalledExchanges: Number(r.stalledExchanges) || 0,
    nonsenseMessages: Number(r.nonsenseMessages) || 0,
    loopCount: Number(r.loopCount) || 0,
    lastLoopMessage: typeof r.lastLoopMessage === "string" ? r.lastLoopMessage : undefined,
    aiTransferCount: Number(r.aiTransferCount) || 0,
    surveyPending: Boolean(r.surveyPending),
  };
}

// Os limites só valem depois que o contador andou: com limite 0 (aceito
// pela config) `0 >= 0` bloqueava toda resposta do agente desde o 1º turno.
export function shouldStopCourtesy(config: V2AgentConfig, counters: V2Counters): boolean {
  return counters.courtesyReplies > 0 && counters.courtesyReplies >= config.limits.maxCourtesyReplies;
}

export function shouldStopHelpOffer(config: V2AgentConfig, counters: V2Counters): boolean {
  return counters.helpOffers > 0 && counters.helpOffers >= config.limits.maxHelpOffers;
}

export function shouldStopStalled(config: V2AgentConfig, counters: V2Counters): boolean {
  return counters.stalledExchanges > 0 && counters.stalledExchanges >= config.limits.maxStalledExchanges;
}

export function shouldStopNonsense(config: V2AgentConfig, counters: V2Counters): boolean {
  return counters.nonsenseMessages > 0 && counters.nonsenseMessages >= config.limits.nonsenseLimit;
}

export function detectLoop(
  config: V2AgentConfig,
  counters: V2Counters,
  message: string,
): boolean {
  const normalized = message.toLowerCase().trim();
  if (counters.lastLoopMessage && counters.lastLoopMessage === normalized) {
    counters.loopCount++;
  } else {
    counters.loopCount = 1;
    counters.lastLoopMessage = normalized;
  }
  return counters.loopCount >= config.limits.maxLoopCount;
}

export type V2StopAction = "none" | "handoff" | "close" | "silence";

export interface V2StopResult {
  blocksReply: boolean;
  action: V2StopAction;
  reason: string;
  /**
   * "Avisar e silenciar": no turno em que o limite é atingido o cliente
   * recebe um aviso; nos seguintes, silêncio. Antes só silenciava.
   */
  warn?: boolean;
}

export function evaluateV2StopLimits(
  config: V2AgentConfig,
  counters: V2Counters,
  message: string,
  opts: { countLoop?: boolean } = {},
): V2StopResult {
  // A detecção de loop soma 1 a cada chamada. O motor avalia os limites em
  // mais de um ponto do turno; só a primeira chamada pode contar, senão a
  // mesma mensagem conta como repetida dentro do próprio turno.
  if (opts.countLoop !== false) detectLoop(config, counters, message);
  if (counters.loopCount >= config.limits.maxLoopCount) {
    return {
      blocksReply: true,
      action: config.limits.nonsenseAction === "handoff" ? "handoff" : "silence",
      reason: "loop detectado",
      warn: config.limits.nonsenseAction !== "handoff" && counters.loopCount === config.limits.maxLoopCount,
    };
  }
  if (shouldStopCourtesy(config, counters)) {
    return { blocksReply: true, action: "none", reason: "limite de respostas de cortesia" };
  }
  if (shouldStopHelpOffer(config, counters)) {
    return { blocksReply: true, action: "none", reason: "limite de ofertas de ajuda" };
  }
  if (shouldStopNonsense(config, counters)) {
    return {
      blocksReply: true,
      action: config.limits.nonsenseAction === "handoff" ? "handoff" : "silence",
      reason: "limite de mensagens sem sentido",
      warn: config.limits.nonsenseAction !== "handoff" && counters.nonsenseMessages === config.limits.nonsenseLimit,
    };
  }
  if (shouldStopStalled(config, counters)) {
    return {
      blocksReply: true,
      action: config.limits.stalledExchangesAction,
      reason: "limite de trocas sem avanço",
    };
  }
  return { blocksReply: false, action: "none", reason: "" };
}
