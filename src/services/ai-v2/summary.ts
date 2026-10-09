/**
 * Resumo do atendimento ("Começo e fim › Resumir o atendimento").
 *
 * Ao encerrar ou transferir, o agente escreve o que aconteceu em cinco
 * itens (motivo, o que foi feito, pendência, resultado, próximo passo). O
 * texto vai para o chat como mensagem privada (`messageType=ai_summary`,
 * só a equipe vê) e entra no contexto do próximo turno — do mesmo agente,
 * de outro agente ou de quem voltar a falar com o cliente dias depois.
 * Com "atualizar a cada resposta", o resumo corrente fica no estado da
 * conversa (sem mensagem) e é refeito a cada turno.
 *
 * Nenhum domínio de cliente: os itens vêm da conversa e da configuração.
 */

import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";
import type { V2AgentConfig, V2SummaryConfig, V2SummaryVerbosity } from "@/lib/ai-v2/types";
import { getAgentChatKey, tryGetAgentApiKey } from "@/services/ai/agent-key";
import { generateWithTools } from "@/services/ai/provider";
import { maskSensitive } from "./sensitive";
import { traceStep } from "./trace";

const log = getLogger("ai-v2.summary");

/** `messageType` da mensagem privada com o resumo. */
export const SUMMARY_MESSAGE_TYPE = "ai_summary";

/** Resumos mais velhos que isso não entram no contexto do turno. */
const PRIOR_SUMMARY_MAX_AGE_DAYS = 30;
const TRANSCRIPT_MESSAGES = 40;
const TRANSCRIPT_CLIP = 400;

export type V2SummaryMoment = "close" | "transfer" | "turn";

export type V2SummaryItems = {
  motivo: string;
  feito: string;
  pendencia: string;
  resultado: string;
  proximo: string;
  /** Só no nível detalhado: "campo: valor". */
  dados?: string[];
  /** Só no nível detalhado: "hh:mm — o que aconteceu". */
  marcos?: string[];
};

export const SUMMARY_LABELS = {
  motivo: "Motivo",
  feito: "O que foi feito",
  pendencia: "Pendência",
  resultado: "Resultado",
  proximo: "Próximo passo",
  dados: "Dados coletados",
  marcos: "Mensagens-chave",
} as const;

export function summaryEnabled(config: Pick<V2AgentConfig, "closure">): V2SummaryConfig | null {
  const cfg = config.closure?.summary;
  return cfg?.enabled ? cfg : null;
}

/** "Resultado" a partir do motivo do encerramento ou do destino da transferência. */
export function outcomeLabel(moment: V2SummaryMoment, reason: string): string {
  if (moment === "transfer") {
    switch (reason) {
      case "ai_agent":
        return "Transferido para outro agente de IA";
      case "automation":
        return "Transferido para um fluxo de automação";
      case "user":
      case "department":
      case "distribution_rule":
        return "Transferido para a equipe";
      default:
        return `Transferido (${reason})`;
    }
  }
  if (moment === "turn") return "Em andamento";
  switch (reason) {
    case "resolved":
      return "Encerrado: resolvido";
    case "inactivity":
      return "Encerrado por inatividade";
    case "deferred":
      return "Encerrado: cliente vai falar depois";
    case "transferred":
      return "Encerrado após transferência";
    default:
      return `Encerrado (${reason})`;
  }
}

/** Texto do resumo no nível configurado. */
export function renderSummary(items: V2SummaryItems, verbosity: V2SummaryVerbosity): string {
  const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  if (verbosity === "minimal") {
    const pend = clean(items.pendencia);
    const tail = pend && !/^(nenhum|nenhuma|sem pend|—|-)/i.test(pend) ? ` · ${pend}` : "";
    return `${clean(items.motivo)} → ${clean(items.resultado)}${tail}`.trim();
  }
  const lines = [
    `${SUMMARY_LABELS.motivo}: ${clean(items.motivo) || "—"}`,
    `${SUMMARY_LABELS.feito}: ${clean(items.feito) || "—"}`,
    `${SUMMARY_LABELS.pendencia}: ${clean(items.pendencia) || "Nenhuma"}`,
    `${SUMMARY_LABELS.resultado}: ${clean(items.resultado) || "—"}`,
    `${SUMMARY_LABELS.proximo}: ${clean(items.proximo) || "—"}`,
  ];
  if (verbosity === "detailed") {
    const dados = (items.dados ?? []).map(clean).filter(Boolean);
    const marcos = (items.marcos ?? []).map(clean).filter(Boolean);
    if (dados.length > 0) lines.push(`${SUMMARY_LABELS.dados}: ${dados.join("; ")}`);
    if (marcos.length > 0) lines.push(`${SUMMARY_LABELS.marcos}: ${marcos.join("; ")}`);
  }
  return lines.join("\n");
}

/** Linha única para o cartão fechado: "motivo → resultado · pendência". */
export function summaryOneLine(text: string): string {
  const get = (label: string) => {
    const m = new RegExp(`^${label}:\\s*(.+)$`, "im").exec(text);
    return m ? m[1].trim() : "";
  };
  const motivo = get(SUMMARY_LABELS.motivo);
  const resultado = get(SUMMARY_LABELS.resultado);
  if (!motivo && !resultado) return text.split("\n")[0]?.trim() ?? "";
  const pend = get(SUMMARY_LABELS.pendencia);
  const tail = pend && !/^(nenhum|nenhuma|sem pend|—|-)/i.test(pend) ? ` · ${pend}` : "";
  return `${motivo || "—"} → ${resultado || "—"}${tail}`;
}

type TranscriptLine = { role: "cliente" | "agente" | "equipe"; at: Date; text: string };

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Sem modelo (erro, sem chave, conversa curta): o resumo sai do próprio histórico. */
export function fallbackSummaryItems(transcript: TranscriptLine[], outcome: string, moment: V2SummaryMoment): V2SummaryItems {
  const firstClient = transcript.find((l) => l.role === "cliente");
  const lastAgent = [...transcript].reverse().find((l) => l.role !== "cliente");
  const last = transcript[transcript.length - 1];
  return {
    motivo: firstClient ? clip(firstClient.text, 120) : "Sem mensagem do cliente",
    feito: lastAgent ? clip(lastAgent.text, 120) : "Nenhuma resposta enviada",
    pendencia: last && last.role === "cliente" ? "Cliente escreveu por último, sem resposta" : "Nenhuma",
    resultado: outcome,
    proximo: moment === "transfer" ? "Continuar de onde parou" : "—",
  };
}

async function loadTranscript(conversationId: string): Promise<TranscriptLine[]> {
  const rows = await prisma.message.findMany({
    where: {
      conversationId,
      isPrivate: false,
      messageType: { notIn: ["note", "ai_draft", SUMMARY_MESSAGE_TYPE] },
      NOT: { messageType: { startsWith: "event" } },
    },
    orderBy: { createdAt: "desc" },
    take: TRANSCRIPT_MESSAGES,
    select: { direction: true, content: true, createdAt: true, authorType: true },
  });
  return rows
    .reverse()
    .filter((r) => (r.content ?? "").trim())
    .map((r) => ({
      role: r.direction === "in" ? "cliente" : r.authorType === "human" ? "equipe" : "agente",
      at: r.createdAt,
      text: clip(r.content ?? "", TRANSCRIPT_CLIP),
    }));
}

function hhmm(d: Date): string {
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

function extractJson(text: string): Record<string, unknown> | null {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, 6) : [];
}

export function summaryPrompt(verbosity: V2SummaryVerbosity, outcome: string): string {
  const size =
    verbosity === "minimal"
      ? "Cada item com no máximo 12 palavras."
      : verbosity === "detailed"
        ? "Cada item em uma ou duas frases. Inclua \"dados\" (até 5 itens \"campo: valor\" que o cliente informou) e \"marcos\" (até 4 itens \"hh:mm — o que aconteceu\", usando os horários do histórico)."
        : "Cada item em uma frase.";
  return [
    "Você resume um atendimento ao cliente para a equipe e para o próximo atendente. Escreva em português, direto, sem elogios nem floreios, sem se dirigir ao cliente.",
    "Itens: motivo (por que o cliente procurou), feito (o que foi informado ou feito), pendencia (o que ficou em aberto: pergunta sem resposta, dado prometido, procedimento a confirmar; \"Nenhuma\" se não houver), resultado (use exatamente o texto informado), proximo (o que quem assumir deve fazer; \"—\" se nada).",
    `Resultado deste atendimento: ${outcome}`,
    size,
    "Não invente fatos: só o que está no histórico. Documento, senha e cartão nunca entram no resumo.",
    'Responda APENAS um JSON: {"motivo":"...","feito":"...","pendencia":"...","resultado":"...","proximo":"...","dados":["..."],"marcos":["..."]}',
  ].join("\n\n");
}

async function generateSummaryItems(args: {
  agentId: string;
  config: V2AgentConfig;
  transcript: TranscriptLine[];
  outcome: string;
  moment: V2SummaryMoment;
  verbosity: V2SummaryVerbosity;
}): Promise<{ items: V2SummaryItems; source: "model" | "fallback" }> {
  const fallback = fallbackSummaryItems(args.transcript, args.outcome, args.moment);
  const clientMessages = args.transcript.filter((l) => l.role === "cliente").length;
  // Conversa de uma mensagem não precisa de modelo.
  if (clientMessages < 2) return { items: fallback, source: "fallback" };
  try {
    const openaiKey = await tryGetAgentApiKey(args.agentId);
    const apiKey = await getAgentChatKey(args.agentId, args.config.model, openaiKey ?? undefined);
    const history = args.transcript
      .map((l) => `[${hhmm(l.at)}] ${l.role === "cliente" ? "Cliente" : l.role === "equipe" ? "Equipe" : "Agente"}: ${l.text}`)
      .join("\n");
    const result = await generateWithTools({
      model: args.config.model,
      apiKey,
      system: summaryPrompt(args.verbosity, args.outcome),
      messages: [{ role: "user", content: `Histórico:\n${history}` }] as never,
      temperature: 0,
      maxOutputTokens: args.verbosity === "detailed" ? 700 : args.verbosity === "minimal" ? 200 : 400,
      maxSteps: 1,
    });
    const parsed = extractJson(result.text ?? "");
    if (!parsed) return { items: fallback, source: "fallback" };
    const items: V2SummaryItems = {
      motivo: str(parsed.motivo) || fallback.motivo,
      feito: str(parsed.feito) || fallback.feito,
      pendencia: str(parsed.pendencia) || fallback.pendencia,
      // O resultado é fato do sistema, não opinião do modelo.
      resultado: args.outcome,
      proximo: str(parsed.proximo) || fallback.proximo,
      ...(args.verbosity === "detailed" ? { dados: strList(parsed.dados), marcos: strList(parsed.marcos) } : {}),
    };
    return { items, source: "model" };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "[ai-v2 resumo] modelo falhou; resumo pelo histórico");
    return { items: fallback, source: "fallback" };
  }
}

/**
 * Gera o resumo e grava como mensagem privada na conversa. Devolve o texto,
 * ou null quando o recurso está desligado. Nunca lança: resumo não pode
 * derrubar o encerramento nem a transferência.
 */
export async function writeV2Summary(args: {
  organizationId: string;
  conversationId: string;
  contactId?: string | null;
  agentId: string;
  config: V2AgentConfig;
  moment: "close" | "transfer";
  /** Motivo do encerramento ou tipo do destino da transferência. */
  reason: string;
}): Promise<string | null> {
  const cfg = summaryEnabled(args.config);
  if (!cfg) return null;
  try {
    const transcript = await loadTranscript(args.conversationId);
    if (transcript.length === 0) return null;
    const outcome = outcomeLabel(args.moment, args.reason);
    const { items, source } = await generateSummaryItems({
      agentId: args.agentId,
      config: args.config,
      transcript,
      outcome,
      moment: args.moment,
      verbosity: cfg.verbosity,
    });
    const text = maskSensitive(renderSummary(items, cfg.verbosity)).text;
    await prisma.message.create({
      data: {
        organizationId: args.organizationId,
        conversationId: args.conversationId,
        content: text,
        direction: "out",
        messageType: SUMMARY_MESSAGE_TYPE,
        isPrivate: true,
        authorType: "bot",
        senderName: args.config.name,
      },
    });
    traceStep("resumo", `${args.moment === "close" ? "Ao encerrar" : "Ao transferir"}: resumo gravado para a equipe (${source === "model" ? "pelo modelo" : "pelo histórico"}): "${summaryOneLine(text).slice(0, 90)}"`);
    return text;
  } catch (err) {
    log.warn(
      { conversationId: args.conversationId, err: err instanceof Error ? err.message : String(err) },
      "[ai-v2 resumo] não gravado",
    );
    traceStep("resumo", "Resumo não gravado (erro ao gerar ou salvar)");
    return null;
  }
}

/** "Atualizar a cada resposta": resumo corrente, só para o estado da conversa. */
export async function updateRunningSummary(args: {
  conversationId: string;
  agentId: string;
  config: V2AgentConfig;
}): Promise<string | null> {
  const cfg = summaryEnabled(args.config);
  if (!cfg?.everyTurn) return null;
  try {
    const transcript = await loadTranscript(args.conversationId);
    if (transcript.length === 0) return null;
    const { items } = await generateSummaryItems({
      agentId: args.agentId,
      config: args.config,
      transcript,
      outcome: outcomeLabel("turn", ""),
      moment: "turn",
      verbosity: "standard",
    });
    return maskSensitive(renderSummary(items, "standard")).text;
  } catch (err) {
    log.warn({ conversationId: args.conversationId, err: err instanceof Error ? err.message : String(err) }, "[ai-v2 resumo] corrente não atualizado");
    return null;
  }
}

export type V2PriorSummary = { text: string; at: Date | null; agent: string | null; current: boolean };

/**
 * Contexto para o turno: o resumo corrente desta conversa (quando "a cada
 * resposta" está ligado) ou o último resumo gravado em outra conversa do
 * contato nos últimos 30 dias — de qualquer agente.
 */
export async function loadPriorV2Summary(args: {
  contactId: string | null | undefined;
  conversationId: string;
  runningSummary?: string | null;
}): Promise<V2PriorSummary | null> {
  if (args.runningSummary?.trim()) return { text: args.runningSummary.trim(), at: null, agent: null, current: true };
  if (!args.contactId) return null;
  const since = new Date(Date.now() - PRIOR_SUMMARY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const row = await prisma.message.findFirst({
    where: {
      messageType: SUMMARY_MESSAGE_TYPE,
      isPrivate: true,
      createdAt: { gte: since },
      conversation: { contactId: args.contactId, id: { not: args.conversationId } },
    },
    orderBy: { createdAt: "desc" },
    select: { content: true, createdAt: true, senderName: true },
  });
  if (!row?.content?.trim()) return null;
  return { text: row.content.trim(), at: row.createdAt, agent: row.senderName ?? null, current: false };
}
