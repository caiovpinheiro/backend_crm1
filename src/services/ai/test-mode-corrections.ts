/**
 * Correção durante o modo de teste, direto do WhatsApp.
 *
 * Duas naturezas, dois destinos, porque são coisas diferentes:
 *
 * - CONDUTA (`#regra`) → `AIAgentConfig.steeringRules`. Como o agente deve
 *   falar, o que não deve prometer, quando deve calar.
 * - FATO (`#base`) → `AIAgentKnowledgeDoc` indexado. O que é verdade sobre o
 *   negócio: prazo, procedimento, link, valor.
 *
 * Misturar os dois é o erro clássico: fato no prompt some no meio de mil
 * linhas de instrução; conduta na base vira um "documento" que a recuperação
 * só traz quando por acaso casa com a pergunta.
 *
 * O texto é gravado EXATAMENTE como o operador digitou nos dois casos: nada
 * de interpretar, resumir ou reescrever. Quem decide é quem atende — o
 * sistema só guarda e passa a obedecer.
 *
 * A regra vale no turno seguinte porque o runner relê a config do banco a
 * cada run (`prisma.aIAgentConfig.findUnique` em `runner.ts`), sem cache no
 * meio. O documento vale assim que a indexação termina.
 *
 * Procedência e desfazer vivem em `AIAgentConfigAudit`: cada correção grava
 * o estado anterior e o novo, mais conversa, mensagem e autor. `#desfazer`
 * reverte a última correção ainda não desfeita DESTA conversa, seja regra ou
 * documento — não é histórico global, é a sessão de teste acontecendo.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";

/** Marca as entradas de auditoria criadas por este fluxo. */
export const TEST_CORRECTION_SOURCE = "whatsapp_test";

type CorrectionOrigin = {
  text: string;
  conversationId: string;
  messageId: string | null;
};

type SteeringDiff = {
  field: "steeringRules";
  before: string;
  after: string;
  correction: CorrectionOrigin;
  undoneAt: string | null;
};

/**
 * Documento criado por `#base`. Guarda o id para o desfazer apagar e o
 * título para a confirmação dizer o que saiu.
 */
type KnowledgeDiff = {
  field: "knowledgeDoc";
  docId: string;
  title: string;
  correction: CorrectionOrigin;
  undoneAt: string | null;
};

type CorrectionDiff = SteeringDiff | KnowledgeDiff;

/** O que `#desfazer` reverteu, para a confirmação saber o que dizer. */
export type UndoneCorrection =
  | { field: "steeringRules"; text: string }
  | { field: "knowledgeDoc"; title: string };

export type CorrectionTarget = {
  agentConfigId: string;
  organizationId: string;
};

/**
 * Agente cuja conduta esta conversa está exercitando: o atribuído, quando é
 * IA; senão o agente ativo da org — o mesmo que o `#iniciar` encaixaria.
 */
export async function resolveCorrectionTarget(
  conversationId: string,
): Promise<CorrectionTarget | null> {
  const organizationId = getOrgIdOrNull();
  if (!organizationId) return null;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      assignedTo: {
        select: { type: true, aiAgentConfig: { select: { id: true } } },
      },
    },
  });
  const assigned = conversation?.assignedTo;
  if (assigned?.type === "AI" && assigned.aiAgentConfig) {
    return { agentConfigId: assigned.aiAgentConfig.id, organizationId };
  }

  const agent = await prisma.aIAgentConfig.findFirst({
    where: { organizationId, active: true, autonomyMode: "AUTONOMOUS" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return agent ? { agentConfigId: agent.id, organizationId } : null;
}

async function recordCorrection(
  target: CorrectionTarget,
  userId: string,
  diff: CorrectionDiff,
): Promise<void> {
  await prisma.aIAgentConfigAudit.create({
    data: {
      organizationId: target.organizationId,
      agentId: target.agentConfigId,
      userId,
      source: TEST_CORRECTION_SOURCE,
      diff,
    },
  });
}

/**
 * Acrescenta a orientação às Regras de condução, verbatim.
 *
 * @returns o texto gravado, ou `null` se o agente sumiu no meio do caminho.
 */
export async function appendSteeringRule(args: {
  target: CorrectionTarget;
  text: string;
  conversationId: string;
  messageId: string | null;
  userId: string;
}): Promise<string | null> {
  const text = args.text.trim();
  if (!text) return null;

  const agent = await prisma.aIAgentConfig.findUnique({
    where: { id: args.target.agentConfigId },
    select: { steeringRules: true },
  });
  if (!agent) return null;

  const before = agent.steeringRules ?? "";
  const after = before.trim() ? `${before.trimEnd()}\n${text}` : text;

  await prisma.aIAgentConfig.update({
    where: { id: args.target.agentConfigId },
    data: { steeringRules: after },
  });

  await recordCorrection(args.target, args.userId, {
    field: "steeringRules",
    before,
    after,
    correction: {
      text,
      conversationId: args.conversationId,
      messageId: args.messageId,
    },
    undoneAt: null,
  });

  return text;
}

export type KnowledgeCorrection = { docId: string; title: string };

/**
 * Cria um documento de conhecimento com o que o operador ditou.
 *
 * Passa pelo MESMO serviço da tela (`createKnowledgeDoc`), então validação,
 * limite de tamanho e indexação são idênticos — um documento criado pelo
 * celular não é um cidadão de segunda classe na base.
 *
 * Import dinâmico porque `knowledge-docs` arrasta o pipeline de embedding, e
 * o caminho de comando não deve pagar isso quando o operador só mandou
 * `#iniciar`.
 */
export async function createKnowledgeCorrection(args: {
  target: CorrectionTarget;
  title: string;
  content: string;
  conversationId: string;
  messageId: string | null;
  userId: string;
}): Promise<KnowledgeCorrection> {
  const { createKnowledgeDoc } = await import("@/services/ai/knowledge-docs");
  const doc = await createKnowledgeDoc(args.target.agentConfigId, {
    title: args.title,
    content: args.content,
  });

  await recordCorrection(args.target, args.userId, {
    field: "knowledgeDoc",
    docId: doc.id,
    title: doc.title,
    correction: {
      text: args.content,
      conversationId: args.conversationId,
      messageId: args.messageId,
    },
    undoneAt: null,
  });

  return { docId: doc.id, title: doc.title };
}

/**
 * Desfaz a última correção desta conversa ainda não desfeita — regra ou
 * documento, o que tiver vindo por último.
 *
 * Para regra, restaura o texto anterior INTEIRO em vez de recortar a linha:
 * se alguém editou as Regras pela tela no meio do caminho, recortar deixaria
 * um Frankenstein. Restaurar é previsível, e a auditoria mostra o que voltou.
 *
 * @returns o que foi revertido, ou `null` se não havia nada.
 */
export async function undoLastCorrection(args: {
  target: CorrectionTarget;
  conversationId: string;
  userId: string;
}): Promise<UndoneCorrection | null> {
  const recent = await prisma.aIAgentConfigAudit.findMany({
    where: {
      agentId: args.target.agentConfigId,
      organizationId: args.target.organizationId,
      source: TEST_CORRECTION_SOURCE,
    },
    orderBy: { changedAt: "desc" },
    take: 30,
    select: { id: true, diff: true },
  });

  const entry = recent.find((row) => {
    const diff = row.diff as CorrectionDiff | null;
    if (!diff || diff.undoneAt !== null) return false;
    if (diff.correction?.conversationId !== args.conversationId) return false;
    return diff.field === "steeringRules" || diff.field === "knowledgeDoc";
  });
  if (!entry) return null;

  const diff = entry.diff as CorrectionDiff;
  const undone = await revert(args.target, diff);

  await prisma.aIAgentConfigAudit.update({
    where: { id: entry.id },
    data: { diff: { ...diff, undoneAt: new Date().toISOString() } },
  });

  return undone;
}

async function revert(
  target: CorrectionTarget,
  diff: CorrectionDiff,
): Promise<UndoneCorrection> {
  if (diff.field === "steeringRules") {
    await prisma.aIAgentConfig.update({
      where: { id: target.agentConfigId },
      data: { steeringRules: diff.before },
    });
    return { field: "steeringRules", text: diff.correction.text };
  }

  // Documento já apagado pela tela não é erro: o desfazer só precisa
  // garantir que ele não esteja mais valendo.
  const { deleteKnowledgeDoc } = await import("@/services/ai/knowledge-docs");
  await deleteKnowledgeDoc(target.agentConfigId, diff.docId).catch(() => null);
  return { field: "knowledgeDoc", title: diff.title };
}
