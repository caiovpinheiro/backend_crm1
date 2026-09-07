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

import type { InboxPolicy } from "@/lib/ai-agents/steering";
import { userWantsHumanDistribution } from "@/services/ai/human-queue-policy";
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

function gateFn(verticalPack?: string | null) {
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

export function evaluateTransferGate(
  input: TransferGateInput,
): TransferGateState {
  const current = input.userMessage ?? "";
  // O pedido explícito de humano vale para a conversa inteira. Olhar só a
  // mensagem atual fazia o gate esquecer o pedido no turno seguinte: o
  // cliente pedia consultor, mandava "ok" depois, e voltava para a IA.
  const askedForHuman = [
    ...(input.priorUserMessages ?? []).slice(-TRANSFER_GATE_HISTORY_DEPTH),
    current,
  ].some((msg) => !!msg?.trim() && userWantsHumanDistribution(msg));

  const justified = gateFn(input.verticalPack);
  // Sem pack não existe gate. Antes o agente genérico caía no `return false`
  // do pack acadêmico e nunca conseguia transferir.
  if (!justified) return { active: false, allows: true, askedForHuman };

  return {
    active: true,
    // O tema (retenção, curso, TCE) justifica pela mensagem ATUAL; o pedido
    // explícito de humano persiste.
    allows: askedForHuman || justified(current, input.inboxPolicy ?? null),
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
}): AgentConfigWarning[] {
  if (!gateFn(input.verticalPack)) return [];
  if (input.unknownAnswerMode !== "handoff") return [];
  return [
    {
      field: "unknownAnswerMode",
      message:
        "Este agente só transfere quando o cliente pede atendimento humano ou o tema exige um departamento. " +
        'Nos demais casos, mesmo com "Admitir e transferir para humano", ele vai admitir que não sabe e seguir o atendimento.',
    },
  ];
}
