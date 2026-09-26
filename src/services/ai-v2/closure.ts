/**
 * Encerramento e janela pós-encerramento da v2 (SPEC 3.18).
 * Nenhum domínio de cliente.
 */

import type { V2Action, V2AgentConfig, V2CloseReason, V2PostCloseCaseBehavior, V2Stage } from "@/lib/ai-v2/types";
import { hasSearchableQuestion } from "./ground-reply";

export type V2PostCloseCase = "courtesy" | "new_demand" | "ambiguous";

const foldText = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Agradecimento, confirmação de que deu certo, despedida. */
const COURTESY_TERMS = [
  "obrigado", "obrigada", "obrigad", "brigado", "brigada", "agradeco", "agradecido", "agradecida", "grato", "grata",
  "valeu", "vlw", "tmj", "tchau", "ate mais", "ate logo", "falou", "flw",
  "ok", "okay", "blz", "beleza", "combinado", "certo", "perfeito", "otimo", "show", "top", "joia", "legal", "massa",
  "entendi", "entendido", "fechou", "fechado", "tudo certo", "tudo bem", "deu certo", "resolvido", "resolveu",
  "consegui", "funcionou", "so isso", "era so isso", "nada mais", "so agradecer",
];
/** Pedido novo. */
const NEW_DEMAND_TERMS = [
  "preciso", "quero", "queria", "gostaria", "duvida", "problema", "ajuda", "ajudar", "solicitar", "comprar", "alterar", "mudar",
  "como faco", "como eu", "onde", "quando", "qual", "quanto", "nao consigo", "nao consegui", "nao funciona", "nao funcionou",
  "erro", "outra coisa", "mais uma",
];
/** Só cumprimento: pode ser pedido novo chegando — ambíguo, nunca agradecimento. */
const GREETING_ONLY = /^(?:oi+|ola|opa|e ai|eai|bom dia|boa tarde|boa noite|hello|hi)(?: (?:tudo bem|td bem|tudo bom))?\??$/;
const COURTESY_EMOJI = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u;

const hasTerm = (text: string, terms: string[]) => terms.some((t) => ` ${text} `.includes(` ${t} `));

export function classifyPostCloseMessage(
  config: V2AgentConfig,
  message: string,
): V2PostCloseCase {
  // Resposta numérica à pergunta pós-encerramento ("1 Sim / 2 Não").
  const text = foldText(message);
  const bare = text.replace(/\?/g, "").trim();
  if (bare === "1" || bare === "sim") return "new_demand";
  if (bare === "2") return "courtesy";
  if (!bare) return COURTESY_EMOJI.test(message.trim()) && message.trim() ? "courtesy" : "ambiguous";
  if (GREETING_ONLY.test(text)) return "ambiguous";

  // "Não consegui" e "não funcionou" não são "consegui"/"funcionou".
  const withoutNegated = bare.replace(/\bnao (?:consegui|funcionou|deu certo|resolveu|resolvido|entendi)\b/g, " ");
  const hasCourtesy = hasTerm(withoutNegated, COURTESY_TERMS);
  const hasNewDemand = hasTerm(bare, NEW_DEMAND_TERMS);
  if (hasCourtesy && !hasNewDemand) return "courtesy";
  if (hasNewDemand && !hasCourtesy) return "new_demand";
  // "Não, obrigado. Preciso de mais nada" — negação de pedido é agradecimento.
  if (hasCourtesy && /\b(?:nao preciso|nada mais|mais nada|so isso)\b/.test(bare)) return "courtesy";
  return "ambiguous";
}

/**
 * A mensagem traz um pedido novo (não é só agradecimento/despedida). Com
 * pedido novo o turno não encerra: ao encerrar, o cliente recebe a despedida
 * no lugar da resposta — perguntou as datas e recebeu "fico feliz em ajudar".
 */
export function isNewRequest(config: V2AgentConfig, message: string): boolean {
  if (!hasSearchableQuestion(message) && !message.includes("?")) return false;
  return classifyPostCloseMessage(config, message) !== "courtesy";
}

/**
 * Tira o encerramento do turno quando o cliente fez um pedido novo: `concluded`
 * e a ação `close_conversation` vão para descartados. Devolve se mudou algo.
 */
export function keepOpenOnNewRequest(
  config: V2AgentConfig,
  message: string,
  output: { concluded: boolean; actions: V2Action[] },
): boolean {
  const closing = output.concluded || output.actions.some((a) => a.type === "close_conversation");
  if (!closing || !isNewRequest(config, message)) return false;
  output.concluded = false;
  output.actions = output.actions.filter((a) => a.type !== "close_conversation");
  return true;
}

/** Pergunta pós-encerramento e rótulos dos botões (até 20 caracteres), da config ou padrão. */
export function postCloseQuestion(config: V2AgentConfig): { message: string; yes: string; no: string } {
  const q = config.closure?.postCloseQuestion ?? {};
  return {
    message: q.message?.trim() || "Você precisa de ajuda com algo novo?",
    yes: (q.yesLabel?.trim() || "Preciso de ajuda").slice(0, 20),
    no: (q.noLabel?.trim() || "Só agradecer").slice(0, 20),
  };
}

/**
 * Mensagem do caso pós-encerramento: a própria do caso; senão, a resposta
 * curta geral; senão o padrão. Antes era uma frase só para todos os casos —
 * um aviso de transferência cadastrado para "pedido novo" saía também para
 * "valeu".
 */
export function postCloseShortReply(config: V2AgentConfig, caseType: V2PostCloseCase = "courtesy"): string {
  return (
    config.closure?.postCloseMessages?.[caseType]?.trim() ||
    config.closure?.shortReplyMessage?.trim() ||
    "Por nada! Se precisar de algo novo, é só chamar."
  );
}

/** Aviso ao transferir depois de encerrar: o do caso; senão o de transferência. */
export function postCloseHandoffMessage(config: V2AgentConfig, caseType: V2PostCloseCase): string {
  return config.closure?.postCloseMessages?.[caseType]?.trim() || config.handoff?.message?.trim() || "Vou transferir para um atendente.";
}

/**
 * A pergunta pós-encerramento já foi feita (as opções pendentes são as dela):
 * a resposta decide, e nunca se pergunta de novo — "Oi" outra vez é pedido
 * novo. Antes cada "Oi" repetia a pergunta.
 */
export function answerToPostCloseQuestion(
  config: V2AgentConfig,
  pendingOptions: string[],
  chosen: string | null,
): V2PostCloseCase | null {
  const q = postCloseQuestion(config);
  if (pendingOptions.length !== 2 || pendingOptions[0] !== q.yes || pendingOptions[1] !== q.no) return null;
  return chosen === q.no ? "courtesy" : "new_demand";
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
