/**
 * Gate de transferência — fonte única para quem monta o prompt e para
 * quem executa a tool.
 *
 * O pack decide quando a IA pode jogar a conversa na fila humana. Antes,
 * só as tools consultavam essa regra: o prompt mandava `handoff` mesmo
 * com o gate fechado, o modelo prometia a transferência ao cliente, a
 * tool recusava, e o turno seguinte repetia tudo. Prompt e execução agora
 * leem daqui.
 */

import {
  messagePromisesTransfer,
  type InboxPolicy,
} from "@/lib/ai-agents/steering";
import {
  humanQueueContextFromAgent,
  userWantsHumanDistribution,
} from "@/services/ai/human-queue-policy";
import { getVerticalPack } from "@/verticals";

/** Quantas mensagens anteriores do cliente contam como "já pediu humano". */
export const TRANSFER_GATE_HISTORY_DEPTH = 10;

export type TransferGateInput = {
  verticalPack?: string | null;
  userMessage?: string | null;
  /// Mensagens anteriores do cliente na conversa, da mais antiga para a mais nova.
  priorUserMessages?: string[];
  inboxPolicy?: InboxPolicy | null;
};

export type TransferGateState = {
  /// O pack impõe condição para transferir.
  active: boolean;
  /// A condição está satisfeita agora.
  allows: boolean;
  /// O cliente pediu humano em algum momento da conversa.
  askedForHuman: boolean;
};

/**
 * Refino do pack: dado o tema da mensagem, ele sabe dizer se um
 * departamento da vertical é exigido. É OPCIONAL — sem pack, "tema que
 * exige departamento" simplesmente não se aplica e sobra o pedido
 * explícito de humano.
 */
function packTopicJustifies(verticalPack?: string | null) {
  const ops = getVerticalPack(verticalPack ?? null)?.ops as
    | {
        isImmediateAcademicHandoffJustified?: (
          userMessage?: string | null,
          policy?: InboxPolicy | null,
        ) => boolean;
      }
    | undefined;
  return ops?.isImmediateAcademicHandoffJustified;
}

/**
 * A política é declarativa (`inboxPolicy.transferPolicy`). Antes, a
 * ÚNICA condição possível era um método do pack acadêmico: agente sem
 * vertical não tinha política alguma.
 */
function policyOf(input: {
  verticalPack?: string | null;
  inboxPolicy?: InboxPolicy | null;
}): "always" | "on_request_or_topic" {
  if (input.inboxPolicy) return input.inboxPolicy.transferPolicy;
  // Config não carregada neste caminho: preserva o default do pack.
  return input.verticalPack === "academic" ? "on_request_or_topic" : "always";
}

export function evaluateTransferGate(
  input: TransferGateInput,
): TransferGateState {
  const current = input.userMessage ?? "";
  // O pedido explícito de humano vale para a conversa inteira. Olhar só a
  // mensagem atual fazia o gate esquecer o pedido no turno seguinte: o
  // cliente pedia consultor, mandava "ok" depois, e voltava para a IA.
  const queueCtx = humanQueueContextFromAgent({
    inboxPolicy: input.inboxPolicy ?? null,
  });
  const askedForHuman = [
    ...(input.priorUserMessages ?? []).slice(-TRANSFER_GATE_HISTORY_DEPTH),
    current,
  ].some((msg) => !!msg?.trim() && userWantsHumanDistribution(msg, queueCtx));

  if (policyOf(input) === "always") {
    return { active: false, allows: true, askedForHuman };
  }

  const topicJustifies = packTopicJustifies(input.verticalPack);
  return {
    active: true,
    // O tema (quando o pack sabe classificá-lo) justifica pela mensagem
    // ATUAL; o pedido explícito de humano persiste na conversa.
    allows:
      askedForHuman ||
      Boolean(topicJustifies?.(current, input.inboxPolicy ?? null)),
    askedForHuman,
  };
}

/** true quando o gate vai recusar qualquer tool de transferência agora. */
export function transferBlockedByGate(state: TransferGateState): boolean {
  return state.active && !state.allows;
}

export type AgentConfigWarning = { field: string; message: string };

/**
 * Combinação impossível de configurar: o pack fecha a transferência para
 * quem não pediu humano, mas o modo "não sei" manda transferir. O runtime
 * rebaixa para "admitir e seguir" — aqui avisamos quem configurou.
 */
export function validateUnknownAnswerAgainstGate(input: {
  verticalPack?: string | null;
  unknownAnswerMode?: string | null;
  unknownAnswerMessage?: string | null;
  inboxPolicy?: InboxPolicy | null;
}): AgentConfigWarning[] {
  const gateCanBlock = policyOf(input) !== "always";
  const warnings: AgentConfigWarning[] = [];

  if (gateCanBlock && input.unknownAnswerMode === "handoff") {
    warnings.push({
      field: "unknownAnswerMode",
      message:
        "Este agente só transfere quando o cliente pede atendimento humano ou o tema exige um departamento. " +
        'Nos demais casos, mesmo com "Admitir e transferir para humano", ele vai admitir que não sabe e seguir o atendimento.',
    });
  }

  // O runtime rebaixa o modo para "admitir e seguir", mas a frase escrita
  // pelo operador continua prometendo transferência. Nesse turno a frase é
  // descartada (`buildUnknownAnswerBlock`) — o operador precisa saber que o
  // texto dele não vai ao ar como está.
  const message =
    input.unknownAnswerMessage ?? input.inboxPolicy?.unknownAnswerMessage ?? null;
  const modeEndsInAcknowledge =
    input.unknownAnswerMode === "acknowledge" || gateCanBlock;
  if (modeEndsInAcknowledge && messagePromisesTransfer(message)) {
    warnings.push({
      field: "unknownAnswerMessage",
      message:
        "A frase de \"não sei\" promete transferir, mas neste agente o turno pode terminar sem transferência. " +
        "Nesses casos o agente ignora a frase e admite com o tom configurado — reescreva-a sem prometer transferência.",
    });
  }

  return warnings;
}
