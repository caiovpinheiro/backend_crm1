/**
 * Filtro de saída das ferramentas — o que o modelo pode ver.
 *
 * `consultar_matricula` devolvia o registro acadêmico inteiro (nome, curso,
 * polo, série, ciclo, situação, instituição) com uma instrução em caixa alta
 * pedindo para não divulgar. O modelo divulgou: "Marcelo, seu curso está
 * cancelado". Instrução dentro de payload não é mecanismo de segurança — o
 * dado simplesmente não pode chegar ao modelo.
 *
 * A regra vale para senha, RGM, CPF, situação financeira e nota: nunca
 * serializados. O modelo recebe status derivado e orientação de rota.
 */

/** O que o agente deve fazer com o aluno, sem saber o motivo real. */
export type EnrollmentGuidance =
  | "atender_normalmente"
  | "encaminhar_secretaria";

export type EnrollmentContextForModel = {
  found: boolean;
  /// O aluno consegue usar o portal/AVA hoje.
  podeAcessarPortal: boolean;
  orientacao: EnrollmentGuidance;
  /// Frase pronta quando o aluno pede dado específico da própria situação.
  transferMessage: string;
  hint: string;
};

const ACTIVE_MARKERS = ["EM CURSO", "ATIVO", "CURSANDO"];

/**
 * Deriva o único bit que o modelo precisa: dá para acessar o portal ou não.
 * O motivo (cancelado, trancado, inadimplente, transferido) fica retido.
 */
export function enrollmentContextForModel(input: {
  situacoes: Array<string | null | undefined>;
  transferMessage: string;
}): EnrollmentContextForModel {
  const found = input.situacoes.length > 0;
  const podeAcessarPortal = input.situacoes.some((s) =>
    ACTIVE_MARKERS.some((marker) => (s ?? "").toUpperCase().includes(marker)),
  );

  if (!found) {
    return {
      found: false,
      podeAcessarPortal: false,
      orientacao: "atender_normalmente",
      transferMessage: input.transferMessage,
      hint: "Sem registro para este contato. Atenda normalmente. Se ele pedir dado específico da própria situação, envie a mensagem de transferência e encaminhe para um consultor.",
    };
  }

  if (podeAcessarPortal) {
    return {
      found: true,
      podeAcessarPortal: true,
      orientacao: "atender_normalmente",
      transferMessage: input.transferMessage,
      hint: "O aluno tem acesso ativo. Ajude com portal, senha, AVA e provas normalmente. Se ele pedir informação específica da própria situação, envie a mensagem de transferência e encaminhe para um consultor.",
    };
  }

  return {
    found: true,
    podeAcessarPortal: false,
    orientacao: "encaminhar_secretaria",
    transferMessage: input.transferMessage,
    hint: "O acesso deste aluno está indisponível no momento e você não tem o motivo. Não afirme nada sobre matrícula, curso ou situação. Envie a mensagem de transferência e encaminhe para a secretaria resolver com ele.",
  };
}
