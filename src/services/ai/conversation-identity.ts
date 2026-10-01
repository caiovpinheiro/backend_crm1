import { prisma } from "@/lib/prisma";

/**
 * QUEM É a pessoa da conversa, depois que algum agente confirmou.
 *
 * O run de um agente recebe o histórico de MENSAGENS, não os resultados de
 * ferramenta do agente anterior. Então tudo que foi descoberto chamando o CRM
 * — inclusive qual dos cadastros do telefone é o certo — morria no fim do
 * turno. Na prática: o especialista para quem a conversa foi transferida
 * pedia de novo o mesmo número que a pessoa já tinha informado.
 *
 * A identidade é da conversa. A LEITURA continua sendo de cada agente: isto
 * aqui guarda um ponteiro para o registro, nunca o conteúdo dele. Um agente
 * sem `readableFields` sabe que a pessoa está identificada e não a
 * interroga de novo, mas continua sem ver os campos.
 */
export type ConversationIdentity = {
  entity: string;
  recordId: string;
  /// Referência amigável já pronta ("negócio #12").
  ref: string;
  /// Rótulo do campo informado. Null = veio do vínculo com o telefone.
  by: string | null;
};

export async function loadConversationIdentity(
  conversationId: string | null | undefined,
): Promise<ConversationIdentity | null> {
  if (!conversationId) return null;
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      aiIdentifiedEntity: true,
      aiIdentifiedRecordId: true,
      aiIdentifiedRef: true,
      aiIdentifiedBy: true,
    },
  });
  if (!c?.aiIdentifiedEntity || !c.aiIdentifiedRecordId) return null;
  return {
    entity: c.aiIdentifiedEntity,
    recordId: c.aiIdentifiedRecordId,
    ref: c.aiIdentifiedRef ?? c.aiIdentifiedRecordId,
    by: c.aiIdentifiedBy,
  };
}

/**
 * Grava quem é a pessoa.
 *
 * `overwrite` separa os dois jeitos de chegar aqui. Quando ela DIGITA um
 * identificador, a resposta é a mais recente e manda — inclusive se corrigir
 * o número ou pedir por outro contrato dela. Quando o registro veio sozinho
 * do vínculo com o telefone, só preenche o que estiver vazio: um palpite do
 * sistema não derruba uma confirmação da pessoa.
 */
export async function rememberConversationIdentity(args: {
  conversationId: string | null | undefined;
  entity: string;
  recordId: string;
  ref: string;
  by: string | null;
  overwrite: boolean;
}): Promise<void> {
  if (!args.conversationId) return;
  if (!args.overwrite) {
    const current = await loadConversationIdentity(args.conversationId);
    if (current) return;
  }
  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: {
      aiIdentifiedEntity: args.entity,
      aiIdentifiedRecordId: args.recordId,
      aiIdentifiedRef: args.ref,
      aiIdentifiedBy: args.by,
      aiIdentifiedAt: new Date(),
    },
  });
}

/**
 * Bloco de prompt. Sem valor de campo de propósito — o que o agente pode ler
 * do registro é decidido pela ferramenta, com o `readableFields` dele.
 */
export function describeConversationIdentity(
  identity: ConversationIdentity | null,
): string {
  if (!identity) return "";
  const origem =
    identity.by === null
      ? "pelo cadastro ligado ao telefone"
      : `pelo ${identity.by} que ela informou`;
  return [
    `IDENTIFICAÇÃO JÁ FEITA: a pessoa desta conversa é ${identity.ref}, confirmada ${origem}.`,
    "Não peça de novo número de cadastro nem qualquer identificador — isso já foi resolvido, possivelmente por outro atendente, e repetir a pergunta passa a impressão de que ninguém leu a conversa.",
    "Para ver os dados dela, consulte o CRM: a ferramenta já sabe de qual registro se trata.",
  ].join("\n");
}
