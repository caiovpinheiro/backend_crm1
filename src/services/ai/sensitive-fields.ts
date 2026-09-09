/**
 * Filtro de saída das ferramentas — o que o modelo pode ver.
 *
 * `consultar_matricula` devolvia o registro acadêmico inteiro (nome, curso,
 * polo, série, ciclo, situação, instituição) com uma instrução em caixa alta
 * pedindo para não divulgar. O modelo divulgou: "Marcelo, seu curso está
 * cancelado". Instrução dentro de payload não é mecanismo de segurança — o
 * dado simplesmente não pode chegar ao modelo.
 *
 * O corte total resolveu o vazamento e criou outro problema: o operador
 * lia na tela que a ferramenta devolvia "curso, polo, série" e ela devolvia
 * um booleano. Agora o meio existe — `academic-record-policy.ts` guarda a
 * allowlist nominal do operador, e este módulo continua sendo o único
 * lugar que decide o que sai.
 *
 * O que NÃO tem configuração que libere: CPF, data de nascimento e
 * telefone do relatório (chaves de identidade, servem para achar a linha),
 * além de senha, situação financeira e nota. Ver a lista em
 * `ACADEMIC_RECORD_FIELDS`.
 */

import {
  filterByConfirmedName,
  partitionAcademicFields,
  resolveStudentIdentity,
  type AcademicEnrollmentView,
  type AcademicRecordLike,
} from "@/services/ai/academic-record-policy";

/** O que o agente deve fazer com o aluno, sem saber o motivo real. */
export type EnrollmentGuidance =
  | "atender_normalmente"
  | "encaminhar_secretaria";

/**
 * Eixo separado da `orientacao`: ela é sobre a rota do atendimento, este é
 * sobre saber com quem se está falando. Presente só quando exige ação.
 */
export type EnrollmentIdentityAction =
  /// Mesma pessoa, mais de uma matrícula: pergunte de qual curso ela fala.
  | "varias_matriculas"
  /// Linhas de pessoas diferentes: peça o nome completo e chame de novo.
  | "confirmar_identidade";

export type EnrollmentContextForModel = {
  found: boolean;
  /// O aluno consegue usar o portal/AVA hoje.
  podeAcessarPortal: boolean;
  orientacao: EnrollmentGuidance;
  /// Frase pronta quando o aluno pede dado específico da própria situação.
  transferMessage: string;
  hint: string;
  /// Campos liberados pelo operador, por matrícula. Ausente quando a
  /// allowlist está vazia — que é o estado inicial de todo agente.
  matriculas?: AcademicEnrollmentView[];
  /// Rótulos de campos que existem e NÃO foram liberados.
  camposOcultos?: string[];
  identidade?: EnrollmentIdentityAction;
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

/**
 * Payload completo da consulta: o bit derivado de sempre MAIS os campos que
 * o operador liberou, se ele liberou algum.
 *
 * A ordem importa. Primeiro a identidade: linhas de pessoas diferentes não
 * devolvem valor nenhum, mesmo com a allowlist cheia — liberar campo é
 * autorizar o agente a falar do dado DAQUELA pessoa, não de quem
 * compartilha o final do telefone com ela. Depois a allowlist.
 */
export function academicLookupForModel(input: {
  records: AcademicRecordLike[];
  readableFields: string[];
  transferMessage: string;
  /// Nome que o aluno confirmou no chat, quando a chamada anterior pediu.
  nomeCompleto?: string | null;
}): EnrollmentContextForModel {
  let records = input.records;

  // Nome confirmado desempata antes de tudo: com uma pessoa só sobrando, o
  // atendimento segue normal em vez de ficar preso no pedido de confirmação.
  const confirmed = input.nomeCompleto?.trim();
  if (confirmed) {
    const narrowed = filterByConfirmedName(records, confirmed);
    // Nome que não casa com ninguém não "libera" o registro do outro: sem
    // linha, a resposta é a de contato sem registro.
    records = narrowed;
  }

  const identity = resolveStudentIdentity(records);
  const base = enrollmentContextForModel({
    situacoes: records.map((r) => r.situacao ?? null),
    transferMessage: input.transferMessage,
  });

  if (identity.kind === "ambiguous") {
    return {
      ...base,
      // Nenhum valor sai daqui. `found` continua true: existe registro, só
      // não sabemos qual é o da pessoa na conversa.
      identidade: "confirmar_identidade",
      hint: `Encontrei ${identity.pessoas} pessoas diferentes com este contato e nenhum dado foi devolvido. Peça o NOME COMPLETO em uma frase gentil e chame a ferramenta de novo passando \`nomeCompleto\`. PROIBIDO pedir CPF.`,
    };
  }

  const { matriculas, camposOcultos } = partitionAcademicFields(
    records,
    input.readableFields,
  );

  const out: EnrollmentContextForModel = { ...base };
  if (matriculas.length > 0) out.matriculas = matriculas;
  if (camposOcultos.length > 0) out.camposOcultos = camposOcultos;
  if (identity.kind === "multi_enrollment") {
    out.identidade = "varias_matriculas";
    out.hint = `${base.hint} Esta pessoa tem ${identity.records.length} matrículas. Diga quantas são, liste os cursos que vieram em \`matriculas\` e pergunte sobre qual ela quer falar antes de responder o resto.`;
  }
  return out;
}
