/**
 * Encerramento e janela pós-encerramento da v2 (SPEC 3.18).
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2CloseReason, V2PostCloseCaseBehavior, V2Stage } from "@/lib/ai-v2/types";

export type V2PostCloseCase = "courtesy" | "new_demand" | "ambiguous";

export function classifyPostCloseMessage(
  config: V2AgentConfig,
  message: string,
): V2PostCloseCase {
  const m = message.toLowerCase();
  // Resposta à pergunta do `ask_with_options` pós-encerramento
  // ("1 para Sim ou 2 para Só agradecer"). Sem isto "1"/"2" caíam em
  // "ambíguo" e a mesma pergunta era repetida.
  const trimmed = m.trim().replace(/[.!]+$/, "");
  if (trimmed === "1" || trimmed === "sim") return "new_demand";
  if (trimmed === "2") return "courtesy";
  const courtesyWords = ["obrigado", "obrigada", "valeu", "vlw", "tchau", "até", "ate", "boa noite", "boa tarde", "bom dia", "ok"];
  const newDemandWords = ["preciso", "quero", "dúvida", "duvida", "problema", "ajuda", "solicitar", "comprar", "alterar", "mudar"];

  const hasCourtesy = courtesyWords.some((w) => m.includes(w));
  const hasNewDemand = newDemandWords.some((w) => m.includes(w));

  if (hasCourtesy && !hasNewDemand) return "courtesy";
  if (hasNewDemand && !hasCourtesy) return "new_demand";
  return "ambiguous";
}

export function getPostCloseBehavior(
  config: V2AgentConfig,
  caseType: V2PostCloseCase,
): V2PostCloseCaseBehavior {
  switch (caseType) {
    case "courtesy":
      return config.closure.courtesyBehavior;
    case "new_demand":
      return config.closure.newDemandBehavior;
    case "ambiguous":
      return config.closure.ambiguousBehavior;
  }
}

export function closeV2Conversation(args: {
  config: V2AgentConfig;
  reason: V2CloseReason;
  tabulationId?: string;
}): { goodbyeMessage?: string; returnToOrigin: boolean } {
  return {
    goodbyeMessage: args.config.closure.goodbyeMessage,
    returnToOrigin: args.config.closure.returnToOriginStage,
  };
}

export function stageAfterPostClose(
  config: V2AgentConfig,
  caseType: V2PostCloseCase,
): V2Stage {
  const behavior = getPostCloseBehavior(config, caseType);
  if (behavior === "reopen_and_route") return "active";
  return "closed";
}
