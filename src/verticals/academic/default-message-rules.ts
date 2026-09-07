/**
 * Regras de mensagem SEMEADAS para quem já usa o pack academic.
 *
 * Estes termos estavam em regex fixo dentro de
 * `inferDepartmentFromContext` (`department-routing.ts`): o operador não
 * conseguia ver, reordenar nem remover — e desligar o intercepto de
 * retenção matava trancamento e cancelamento junto. Aqui eles viram DADO
 * de configuração: mesmo comportamento, agora visível e editável na tela.
 *
 * Só valem como base: assim que o agente salva a própria lista de regras,
 * o que está no banco vence (inclusive lista vazia = operador removeu).
 *
 * Nada disso é importado pelo motor de regras — o motor não conhece tema.
 */

import type { MessageRule } from "@/lib/ai-agents/message-rules";

/**
 * Fidelidade ao regex antigo, com uma assimetria corrigida de propósito:
 * "transferir de polo" não casava com `transferenc\w*` e caía no modelo,
 * enquanto "trocar de polo" era interceptado. A diferença era acidente de
 * digitação do regex, não decisão de produto.
 */
export const ACADEMIC_RETENTION_MESSAGE_RULES: MessageRule[] = [
  {
    id: "academic-retencao-cancelamento",
    label: "Cancelamento, trancamento ou desistência",
    enabled: true,
    anyOf: ["cancel", "tranc", "desist"],
    allOf: [],
    noneOf: [],
    action: "transfer_department",
    department: "Retenção",
    message: null,
  },
  {
    id: "academic-retencao-troca-curso-polo",
    label: "Troca de curso ou de polo",
    enabled: true,
    anyOf: [
      "transferencia de curso",
      "transferencia curso",
      "transferencia de polo",
      "transferencia polo",
      "transferir de curso",
      "transferir de polo",
      "mudar de curso",
      "mudar curso",
      "mudar de polo",
      "mudar polo",
      "trocar de curso",
      "trocar curso",
      "trocar de polo",
      "trocar polo",
    ],
    allOf: [],
    noneOf: [],
    action: "transfer_department",
    department: "Retenção",
    message: null,
  },
];

/** Base de regras do pack, quando o agente ainda não salvou as próprias. */
export function academicDefaultMessageRules(opts: {
  interceptRetention: boolean;
}): MessageRule[] {
  return opts.interceptRetention
    ? ACADEMIC_RETENTION_MESSAGE_RULES.map((r) => ({ ...r }))
    : [];
}
