/**
 * `#porque`: de onde veio a última resposta.
 *
 * A pergunta que motivou isto foi literal — "onde no prompt ou nas
 * configurações do agente diz que esse é o procedimento?". Não havia como
 * responder sem abrir o banco. Três mecanismos podem decidir um turno (regra
 * de assunto, documento recuperado, texto do prompt) e, de fora, os três
 * produzem uma bolha de WhatsApp indistinguível.
 *
 * O diagnóstico é montado de fato observado, não de narrativa: a regra é
 * reavaliada pela mesma função pura do runtime, o run vem de `AIAgentRun`, e
 * os documentos vêm de uma recuperação real feita agora com a mesma query.
 *
 * Onde a recuperação de agora pode divergir da do turno original — base
 * editada no meio, documento vencido desde então — o texto diz "agora", sem
 * fingir que é o retrato do passado. Persistir os trechos recuperados por
 * run resolveria isso e é a evolução natural; não vale mudar schema antes de
 * o comando provar que é usado.
 */

import {
  evaluateMessageRules,
  MESSAGE_RULE_LABELS,
} from "@/lib/ai-agents/message-rules";
import type { InboxPolicy } from "@/lib/ai-agents/steering";
import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { prisma } from "@/lib/prisma";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import { buildRetrievalQuery } from "@/services/ai/retrieval-query";
import { retrieveAgentKnowledge } from "@/services/ai/retrieval";

export type WhyReport = {
  question: string;
  /// Regra de assunto que pega a pergunta hoje, se alguma.
  rule: { position: number; label: string; action: string } | null;
  /// O modelo chegou a rodar no último turno?
  llmInvoked: boolean | null;
  outcome: string | null;
  confidence: number | null;
  /// Documentos que a recuperação traz AGORA para esta pergunta.
  documents: string[];
  /// Documentos relevantes cuja validade passou.
  expired: string[];
};

const MAX_DOCS = 4;

export async function buildWhyReport(args: {
  agentConfigId: string;
  conversationId: string;
  question: string;
}): Promise<WhyReport> {
  const agent = await prisma.aIAgentConfig.findUnique({
    where: { id: args.agentConfigId },
    select: { inboxPolicy: true, verticalPack: true },
  });
  const policy: InboxPolicy = normalizeInboxPolicy(
    agent?.inboxPolicy,
    agent?.verticalPack,
  );

  const hit = evaluateMessageRules(args.question, policy.messageRules);
  const actionLabel = hit
    ? (MESSAGE_RULE_LABELS.actions.find((a) => a.id === hit.rule.action)
        ?.label ?? hit.rule.action)
    : null;

  const run = await prisma.aIAgentRun.findFirst({
    where: { conversationId: args.conversationId, agentId: args.agentConfigId },
    orderBy: { createdAt: "desc" },
    select: { llmInvoked: true, outcome: true, confidence: true },
  });

  const { documents, expired } = await retrieveForReport(
    args.agentConfigId,
    args.conversationId,
    args.question,
  );

  return {
    question: args.question,
    rule: hit
      ? {
          position: hit.position,
          label: hit.rule.label,
          action: actionLabel ?? hit.rule.action,
        }
      : null,
    llmInvoked: run?.llmInvoked ?? null,
    outcome: run?.outcome ?? null,
    confidence: run?.confidence ?? null,
    documents,
    expired,
  };
}

/**
 * Recuperação real, com a MESMA query do runtime (mensagem atual mais as
 * últimas do cliente). Rodar com a query crua daria um diagnóstico que não
 * corresponde ao que o agente viu.
 *
 * Falha de recuperação não derruba o diagnóstico: o resto do relatório ainda
 * responde a pergunta principal, que é qual mecanismo decidiu.
 */
async function retrieveForReport(
  agentConfigId: string,
  conversationId: string,
  question: string,
): Promise<{ documents: string[]; expired: string[] }> {
  const apiKey = await tryGetAgentApiKey(agentConfigId);
  if (!apiKey) return { documents: [], expired: [] };

  const priorMessages = await prisma.message.findMany({
    where: { conversationId, direction: "inbound" },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { content: true },
  });

  const query = buildRetrievalQuery({
    userMessage: question,
    // O runtime recebe da mais antiga para a mais nova.
    priorUserMessages: priorMessages
      .map((m) => m.content ?? "")
      .filter(Boolean)
      .reverse(),
  });

  try {
    const result = await retrieveAgentKnowledge(
      agentConfigId,
      query,
      apiKey,
      MAX_DOCS,
    );
    // Um documento vira vários trechos; o operador quer a lista de
    // documentos, não a de pedaços.
    const titles = new Set(result.chunks.map((c) => c.docTitle));
    return {
      documents: [...titles],
      expired: result.expired.map((d) => d.title),
    };
  } catch {
    return { documents: [], expired: [] };
  }
}

/** Diagnóstico em texto de WhatsApp: linhas curtas, sem jargão de campo. */
export function formatWhyReport(report: WhyReport): string {
  const lines: string[] = [
    `🧪 Última pergunta: "${truncate(report.question, 120)}"`,
    "",
  ];

  if (report.rule) {
    lines.push(
      `📍 Regra de assunto ${report.rule.position} — ${report.rule.label}`,
      `   Próximo passo: ${report.rule.action}`,
    );
  } else {
    lines.push("📍 Nenhuma regra de assunto pegou esta pergunta.");
  }

  if (report.llmInvoked === false) {
    lines.push("🤖 O modelo NÃO rodou — a regra resolveu o turno sozinha.");
  } else if (report.llmInvoked === true) {
    lines.push("🤖 O modelo rodou e escreveu a resposta.");
  }

  if (report.documents.length > 0) {
    lines.push("", "📚 Base consultada agora para esta pergunta:");
    for (const title of report.documents) lines.push(`   • ${title}`);
  } else {
    lines.push("", "📚 Nenhum documento da base casou com esta pergunta.");
  }

  if (report.expired.length > 0) {
    lines.push(
      "",
      `⏰ Vencidos (fora de uso): ${report.expired.join(", ")}`,
    );
  }

  if (report.outcome) lines.push("", `🏁 Desfecho registrado: ${report.outcome}`);
  if (report.confidence !== null) {
    lines.push(`📊 Confiança declarada: ${report.confidence.toFixed(1)}`);
  }

  if (!report.rule && report.documents.length === 0) {
    lines.push(
      "",
      "Sem regra e sem documento, quem decidiu foi o texto das Regras do agente.",
    );
  }

  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
