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
  /**
   * O modelo afirma que o contato pediu pessoa/equipe/atendente nesta
   * conversa (parâmetro `userExplicitlyAsked` das tools de transferência).
   * Vale por si só: a lista de keywords nunca cobre todas as formas de
   * pedir ("me passa pra alguém", "tem gente aí?").
   */
  userExplicitlyAsked?: boolean;
};

export type TransferGateState = {
  /// O pack impõe condição para transferir.
  active: boolean;
  /// A condição está satisfeita agora.
  allows: boolean;
  /// O cliente pediu humano em algum momento da conversa.
  askedForHuman: boolean;
  /// Como o pedido foi reconhecido. `null` = não houve pedido de humano.
  matchedBy: "keyword" | "model_assertion" | null;
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
  const matchedByKeyword = [
    ...(input.priorUserMessages ?? []).slice(-TRANSFER_GATE_HISTORY_DEPTH),
    current,
  ].some((msg) => !!msg?.trim() && userWantsHumanDistribution(msg, queueCtx));

  // Afirmação do modelo tem o mesmo peso da keyword: o gate existe para
  // impedir transferência que ninguém pediu, não para exigir que o
  // contato use as palavras que a lista conhece.
  const askedForHuman = matchedByKeyword || input.userExplicitlyAsked === true;
  const matchedBy: TransferGateState["matchedBy"] = matchedByKeyword
    ? "keyword"
    : input.userExplicitlyAsked === true
      ? "model_assertion"
      : null;

  if (policyOf(input) === "always") {
    return { active: false, allows: true, askedForHuman, matchedBy };
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
    matchedBy,
  };
}

/** true quando o gate vai recusar qualquer tool de transferência agora. */
export function transferBlockedByGate(state: TransferGateState): boolean {
  return state.active && !state.allows;
}

function foldIdle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[!?.…,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mensagem sem assunto para orquestrar: saudação, recado de “depois falo”,
 * agradeço/tchau. O coordenador não deve chamar especialista nem humano.
 */
export function isIdleOrchestrationMessage(raw?: string | null): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return true;
  const n = foldIdle(trimmed);
  if (!n) return true;
  if (
    trimmed.length <= 48 &&
    /^(oi+|ola+|oie+|hey|hello|bom dia|boa tarde|boa noite)( tudo bem)?$/.test(n)
  ) {
    return true;
  }
  if (n.length < 90) {
    if (
      /so posso responder( mais)? tarde|depois eu (falo|respondo)|te falo depois|agora nao posso|so depois/.test(
        n,
      )
    ) {
      return true;
    }
    if (/^(ok+|obrigad[oa]|valeu|tchau|ate mais|combinado|entendi|perfeito|deu certo|consegui|ta bom|ja sim)$/.test(n)) {
      return true;
    }
  }
  if (n.length < 55) {
    if (
      /^(oi+|ola+|oie+|oii+|hey|hello)(\s+[a-z]+){0,4}( tudo bem| td bem| td)?$/.test(
        n,
      )
    ) {
      return true;
    }
    if (
      /^(bom dia|boa tarde|boa noite)\b/.test(n) &&
      !/\b(acesso|senha|portal|prova|contrato|boleto)\w*/.test(
        n,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sem conteúdo verbal: vazio, só emoji/pontuação, ou tokens sem letras.
 * Uma palavra real ("Financeiro", "boleto") nunca é nonsense.
 */
export function isUnintelligibleInbound(raw?: string | null): boolean {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return true;
  if (/\d/.test(trimmed) || /@/.test(trimmed)) return false;
  const letters = trimmed.replace(/[^\p{L}]+/gu, " ").trim();
  const tokens = letters.split(/\s+/).filter((w) => w.length >= 2);
  if (tokens.length === 0) return true;
  return false;
}

export function unintelligibleStreak(
  current: string,
  priorUserMessages: string[],
): number {
  if (!isUnintelligibleInbound(current)) return 0;
  let n = 1;
  for (let i = priorUserMessages.length - 1; i >= 0; i--) {
    const prev = priorUserMessages[i];
    if (isIdleOrchestrationMessage(prev) && (prev ?? "").trim()) continue;
    if (isUnintelligibleInbound(prev)) n += 1;
    else break;
  }
  return n;
}

/** Fallback neutro — sem vocabulário de produto. */
export const DEFAULT_NONSENSE_ASK_ONCE =
  "Não entendi essa mensagem. Pode repetir em uma frase o que você precisa?";
export const DEFAULT_NONSENSE_STOP =
  "Quando tiver um pedido objetivo, me chama que eu te ajudo. Por aqui não consigo seguir com isso.";

/** @deprecated use DEFAULT_* ou inboxPolicy */
export const NONSENSE_ASK_ONCE = DEFAULT_NONSENSE_ASK_ONCE;
export const NONSENSE_STOP = DEFAULT_NONSENSE_STOP;

export function resolveNonsenseCopy(policy?: InboxPolicy | null): {
  ask: string;
  stop: string;
} {
  const ask = policy?.nonsenseAskOnceMessage?.trim();
  const stop = policy?.nonsenseStopMessage?.trim();
  return {
    ask: ask || DEFAULT_NONSENSE_ASK_ONCE,
    stop: stop || DEFAULT_NONSENSE_STOP,
  };
}

export function nonsenseGuardReply(
  current: string,
  priorUserMessages: string[],
  policy?: InboxPolicy | null,
): string | null {
  if (isIdleOrchestrationMessage(current) && (current ?? "").trim()) {
    return null;
  }
  const threadHasWork = priorUserMessages.some(
    (p) => !isIdleOrchestrationMessage(p) && !isUnintelligibleInbound(p),
  );
  if (threadHasWork) return null;
  const streak = unintelligibleStreak(current, priorUserMessages);
  const copy = resolveNonsenseCopy(policy);
  if (streak >= 2) return copy.stop;
  if (streak === 1) return copy.ask;
  return null;
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
