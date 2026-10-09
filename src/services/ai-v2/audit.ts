/**
 * Auditoria do motor: defeitos objetivos por conversa, medidos do rastro e
 * das mensagens — sem depender de print nem de opinião. Cada defeito é algo
 * determinístico que o motor não devia ter feito (ou deixado de fazer);
 * decisão do modelo e lacuna de conhecimento ficam fora (são "inteligência"
 * e configuração, medidas pelo relatório de aprendizado).
 *
 * Índice do motor = conversas sem defeito / conversas atendidas (meta 100%).
 * Nenhum domínio de cliente.
 */

import { prismaBase } from "@/lib/prisma-base";
import { ensureV2AgentSchema } from "./ensure-schema";
import { isNearDuplicateReply } from "./ground-reply";
import { SUMMARY_MESSAGE_TYPE } from "./summary";

export const AUDIT_FLAGS = [
  "sem_resposta",
  "resposta_descartada",
  "transferencia_muda",
  "transferencia_em_cadeia",
  "ping_pong",
  "apresentacao_apos_transferencia",
  "resposta_duplicada",
  "pergunta_repetida",
  "fluxo_em_cima_do_agente",
  "canal_errado",
  "ia_apos_pessoa",
  "erro_no_turno",
] as const;
export type AuditFlag = (typeof AUDIT_FLAGS)[number];

export const AUDIT_FLAG_INFO: Record<AuditFlag, { label: string; what: string }> = {
  sem_resposta: { label: "Sem resposta", what: "O cliente escreveu, o turno rodou e nada saiu — sem motivo legítimo (cortesia, pessoa atendendo, mensagem já coberta)." },
  resposta_descartada: { label: "Resposta descartada", what: "A resposta foi descartada porque chegou outra mensagem e o turno seguinte não respondeu." },
  transferencia_muda: { label: "Transferência sem aviso", what: "A conversa foi transferida e o cliente não recebeu nenhum aviso." },
  transferencia_em_cadeia: { label: "Transferência em cadeia", what: "Duas transferências em menos de 3 minutos, sem resposta ao cliente no meio." },
  ping_pong: { label: "Ping-pong entre agentes", what: "Um agente devolveu a conversa para o agente que acabou de passá-la." },
  apresentacao_apos_transferencia: { label: "Apresentação depois de transferência", what: "O agente que recebeu a conversa mandou boas-vindas ou confirmação de cadastro em vez de responder." },
  resposta_duplicada: { label: "Resposta duplicada", what: "Duas mensagens quase iguais do agente em menos de 90 segundos." },
  pergunta_repetida: { label: "Pergunta repetida", what: "O agente fez a mesma pergunta duas vezes seguidas." },
  fluxo_em_cima_do_agente: { label: "Fluxo falando em cima do agente", what: "Um fluxo de automação mandou mensagem numa conversa que o agente estava atendendo." },
  canal_errado: { label: "Envio por outro canal", what: "Mensagem enviada por um canal diferente do canal da conversa." },
  ia_apos_pessoa: { label: "IA depois de atendimento de pessoa", what: "Ticket aberto até 60 min depois de um atendimento de pessoa foi atendido pela IA." },
  erro_no_turno: { label: "Erro no turno", what: "O turno terminou com erro do motor." },
};

export type AuditTurn = {
  id: string;
  conversationId: string;
  agentId: string;
  createdAt: Date;
  inboundText: string;
  reply: string | null;
  handoff: boolean;
  error: string | null;
  closed: string | null;
  executedActions: unknown;
  discardedActions: unknown;
  trace: unknown;
};

export type AuditMessage = {
  id: string;
  conversationId: string;
  direction: string;
  authorType: string | null;
  senderName: string | null;
  messageType: string | null;
  content: string | null;
  channelId: string | null;
  aiAgentUserId: string | null;
  isPrivate: boolean;
  createdAt: Date;
};

export type AuditConversation = {
  id: string;
  number: number | null;
  contactId: string | null;
  contactName: string | null;
  channelId: string | null;
  createdAt: Date;
  closedAt: Date | null;
  hasHumanReply: boolean;
};

/** Conversa anterior do mesmo contato encerrada com resposta de pessoa. */
export type AuditPriorHuman = { contactId: string; closedAt: Date; conversationId: string };

export type AuditFinding = { flag: AuditFlag; at: Date; detail: string };
export type AuditItem = { conversationId: string; number: number | null; contactName: string | null; findings: AuditFinding[] };
export type AuditSummary = {
  conversations: number;
  withDefects: number;
  engineIndex: number;
  byFlag: Partial<Record<AuditFlag, number>>;
  items: AuditItem[];
};

const SEND_ACTIONS = new Set(["send_message", "send_message_model", "send_whatsapp_template", "send_material_attachment", "send_product"]);
/** Motivos legítimos para um turno não responder. */
const LEGIT_NO_REPLY = new Set(["human owner", "post-close no_reply", "queued", "answered meanwhile", "conversation moved on", "already replied in a previous attempt"]);
/** Erros do motor que são "turno ignorado", não defeito. */
const SKIP_ERRORS = ["AI attendance disabled", "Agent config not found", "Agent inactive", "Conversation not found", "Conversation without contact", "No v2 agent assigned", "Phone number not in allowed test list"];

function steps(trace: unknown): Array<{ step: string; detail: string }> {
  if (!Array.isArray(trace)) return [];
  return trace
    .map((s) => (s && typeof s === "object" ? { step: String((s as { step?: unknown }).step ?? ""), detail: String((s as { detail?: unknown }).detail ?? "") } : null))
    .filter((s): s is { step: string; detail: string } => !!s);
}
function hasStep(trace: unknown, re: RegExp): boolean {
  return steps(trace).some((s) => re.test(s.detail));
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function noReplyReason(turn: AuditTurn): string | null {
  for (const d of asArray(turn.discardedActions)) {
    const a = d as { type?: unknown; reason?: unknown };
    if (a?.type === "no_reply") return typeof a.reason === "string" ? a.reason : "";
  }
  return null;
}
function sentSomething(turn: AuditTurn): boolean {
  if (turn.reply?.trim()) return true;
  return asArray(turn.executedActions).some((r) => {
    const x = r as { ok?: unknown; action?: { type?: unknown } };
    return x?.ok === true && typeof x.action?.type === "string" && SEND_ACTIONS.has(x.action.type);
  });
}
const transferTarget = (trace: unknown): string | null => {
  const m = steps(trace).map((s) => /Transferido para ([a-z_]+)(?: \(([^)]+)\))?/.exec(s.detail)).find(Boolean);
  return m ? `${m[1]}${m[2] ? `:${m[2]}` : ""}` : null;
};
const asksQuestion = (text: string | null) => !!text && /\?\s*$/.test(text.trim());

/** Classifica os defeitos a partir dos dados já carregados (puro, testável). */
export function auditFromData(input: {
  agentId: string;
  turns: AuditTurn[];
  allTurns?: AuditTurn[];
  messages: AuditMessage[];
  conversations: AuditConversation[];
  priorHuman?: AuditPriorHuman[];
}): AuditSummary {
  const allTurns = (input.allTurns ?? input.turns).slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const convIds = new Set(input.turns.map((t) => t.conversationId));
  const convById = new Map(input.conversations.map((c) => [c.id, c]));
  const findings = new Map<string, AuditFinding[]>();
  const add = (conversationId: string, flag: AuditFlag, at: Date, detail: string) => {
    const list = findings.get(conversationId) ?? [];
    if (list.some((f) => f.flag === flag && Math.abs(f.at.getTime() - at.getTime()) < 1000)) return;
    list.push({ flag, at, detail });
    findings.set(conversationId, list);
  };

  // Por turno deste agente.
  for (const t of input.turns) {
    const trace = t.trace;
    const reason = noReplyReason(t);
    const skipped = !!t.error && SKIP_ERRORS.some((e) => t.error!.includes(e));
    if (t.error && !skipped) add(t.conversationId, "erro_no_turno", t.createdAt, t.error.slice(0, 160));
    const transferred = hasStep(trace, /^Transferido para /);
    const intentionalSilence = hasStep(trace, /Transferência em cadeia|modo transparente|Uma pessoa assumiu a conversa|não está mais com o agente/);
    if (transferred && !intentionalSilence) {
      const noticeBlocked = hasStep(trace, /NÃO enviada \(near_duplicate\)/) || hasStep(trace, /Aviso de transferência não saiu/);
      if (noticeBlocked || !hasStep(trace, /^Enviada:/)) add(t.conversationId, "transferencia_muda", t.createdAt, noticeBlocked ? "aviso barrado como repetido" : "transferiu sem avisar o cliente");
    }
    if (hasStep(trace, /Conversa recebida de outro agente de IA/) && (hasStep(trace, /boas-vindas configuradas|Confirmo que|confirmação de cadastro →/) || /^Olá!? Sou /i.test(t.reply ?? ""))) {
      add(t.conversationId, "apresentacao_apos_transferencia", t.createdAt, "boas-vindas/confirmação depois de receber a conversa");
    }
    if (hasStep(trace, /a pergunta não sai|a saudação não sai/) && !sentSomething(t)) {
      add(t.conversationId, "resposta_descartada", t.createdAt, "resposta descartada por mensagem nova do cliente");
    }
    if (!t.error && !t.handoff && !t.closed && !sentSomething(t) && !transferred) {
      if (reason !== null && !LEGIT_NO_REPLY.has(reason)) add(t.conversationId, "sem_resposta", t.createdAt, `sem resposta (${reason || "sem motivo"})`);
      else if (reason === null && !hasStep(trace, /Salva como rascunho|modo sugestão|Enviada:|Mensagem pronta|Botões:/) && t.inboundText.trim()) add(t.conversationId, "sem_resposta", t.createdAt, "turno terminou sem resposta");
    }
  }

  // Cadeia / ping-pong: turnos de qualquer agente nas conversas deste agente.
  const byConv = new Map<string, AuditTurn[]>();
  for (const t of allTurns) if (convIds.has(t.conversationId)) byConv.set(t.conversationId, [...(byConv.get(t.conversationId) ?? []), t]);
  for (const [conversationId, list] of byConv) {
    const transfers = list.filter((t) => hasStep(t.trace, /^Transferido para /)).map((t) => ({ t, target: transferTarget(t.trace) }));
    for (let i = 1; i < transfers.length; i += 1) {
      const prev = transfers[i - 1];
      const cur = transfers[i];
      const gapMs = cur.t.createdAt.getTime() - prev.t.createdAt.getTime();
      if (gapMs < 3 * 60_000 && !sentSomething(cur.t)) add(conversationId, "transferencia_em_cadeia", cur.t.createdAt, `${prev.target ?? "?"} → ${cur.target ?? "?"} em ${Math.round(gapMs / 1000)} s`);
      if (cur.target?.startsWith("ai_agent:") && cur.target.slice("ai_agent:".length) === prev.t.agentId && prev.target === `ai_agent:${cur.t.agentId}`) {
        add(conversationId, "ping_pong", cur.t.createdAt, "devolveu a conversa ao agente que acabou de passá-la");
      }
    }
  }

  // Mensagens: duplicadas, perguntas repetidas, fluxo em cima, canal errado.
  const msgsByConv = new Map<string, AuditMessage[]>();
  for (const m of input.messages) if (convIds.has(m.conversationId)) msgsByConv.set(m.conversationId, [...(msgsByConv.get(m.conversationId) ?? []), m]);
  for (const [conversationId, list] of msgsByConv) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const conv = convById.get(conversationId);
    const outs = list.filter((m) => m.direction === "out" && !m.isPrivate && m.messageType !== SUMMARY_MESSAGE_TYPE && !(m.messageType ?? "").startsWith("event:") && (m.content ?? "").trim());
    const agentOuts = outs.filter((m) => m.authorType === "bot" && m.aiAgentUserId);
    for (let i = 1; i < agentOuts.length; i += 1) {
      const a = agentOuts[i - 1];
      const b = agentOuts[i];
      const gapMs = b.createdAt.getTime() - a.createdAt.getTime();
      const inboundBetween = list.some((m) => m.direction === "in" && m.createdAt > a.createdAt && m.createdAt < b.createdAt);
      if (gapMs < 90_000 && !inboundBetween && isNearDuplicateReply(a.content ?? "", b.content ?? "")) add(conversationId, "resposta_duplicada", b.createdAt, `"${(b.content ?? "").slice(0, 60)}…"`);
      if (inboundBetween && asksQuestion(a.content) && asksQuestion(b.content) && isNearDuplicateReply(a.content ?? "", b.content ?? "")) add(conversationId, "pergunta_repetida", b.createdAt, `"${(b.content ?? "").slice(0, 60)}…"`);
    }
    const firstAgentOut = agentOuts[0]?.createdAt;
    for (const m of outs) {
      const automation = m.authorType === "bot" && !m.aiAgentUserId && !/^Campanha:/i.test(m.senderName ?? "");
      if (automation && firstAgentOut && m.createdAt >= firstAgentOut) add(conversationId, "fluxo_em_cima_do_agente", m.createdAt, `${m.senderName ?? "fluxo"}: "${(m.content ?? "").slice(0, 50)}…"`);
      if (conv?.channelId && m.channelId && m.channelId !== conv.channelId) add(conversationId, "canal_errado", m.createdAt, `${m.senderName ?? "?"} por outro canal`);
    }
  }

  // Ticket novo logo depois de atendimento de pessoa, atendido pela IA.
  for (const conv of input.conversations) {
    if (!convIds.has(conv.id) || !conv.contactId) continue;
    const prior = (input.priorHuman ?? []).find((p) => p.contactId === conv.contactId && p.conversationId !== conv.id && conv.createdAt.getTime() - p.closedAt.getTime() >= 0 && conv.createdAt.getTime() - p.closedAt.getTime() <= 60 * 60_000);
    if (prior) add(conv.id, "ia_apos_pessoa", conv.createdAt, `${Math.round((conv.createdAt.getTime() - prior.closedAt.getTime()) / 60_000)} min depois de um atendimento de pessoa`);
  }

  const items: AuditItem[] = [...findings.entries()]
    .map(([conversationId, list]) => {
      const c = convById.get(conversationId);
      return { conversationId, number: c?.number ?? null, contactName: c?.contactName ?? null, findings: list.sort((a, b) => a.at.getTime() - b.at.getTime()) };
    })
    .sort((a, b) => (b.findings[0]?.at.getTime() ?? 0) - (a.findings[0]?.at.getTime() ?? 0));
  const byFlag: Partial<Record<AuditFlag, number>> = {};
  for (const it of items) for (const f of new Set(it.findings.map((f) => f.flag))) byFlag[f] = (byFlag[f] ?? 0) + 1;
  const conversations = convIds.size;
  const withDefects = items.length;
  return { conversations, withDefects, engineIndex: conversations === 0 ? 100 : Math.round(((conversations - withDefects) / conversations) * 1000) / 10, byFlag, items };
}

const db = prismaBase as unknown as { $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T> };
const MAX_TURNS = 20000;

export async function getEngineAudit(args: { organizationId: string; agentId: string; from: Date; to: Date }): Promise<AuditSummary & { from: Date; to: Date; turns: number; truncated: boolean }> {
  await ensureV2AgentSchema().catch(() => undefined);
  const turns = await db.$queryRawUnsafe<AuditTurn[]>(
    `SELECT l."id", l."conversationId", l."agentId", l."createdAt", l."inboundText", l."reply", l."handoff", l."error",
            l."executedActions", l."discardedActions", l."contextSnapshot"->'trace' AS "trace", l."contextSnapshot"->>'closed' AS "closed"
       FROM "ai_simple_turn_logs" l
      WHERE l."organizationId"=$1 AND l."agentId"=$2 AND l."createdAt" >= $3 AND l."createdAt" < $4
      ORDER BY l."createdAt" ASC
      LIMIT ${MAX_TURNS + 1}`,
    args.organizationId, args.agentId, args.from, args.to,
  );
  const truncated = turns.length > MAX_TURNS;
  const own = turns.slice(0, MAX_TURNS);
  const convIds = [...new Set(own.map((t) => t.conversationId))];
  if (convIds.length === 0) return { ...auditFromData({ agentId: args.agentId, turns: [], messages: [], conversations: [] }), from: args.from, to: args.to, turns: 0, truncated };
  const [allTurns, conversations, messages] = await Promise.all([
    db.$queryRawUnsafe<AuditTurn[]>(
      `SELECT l."id", l."conversationId", l."agentId", l."createdAt", l."inboundText", l."reply", l."handoff", l."error",
              l."executedActions", l."discardedActions", l."contextSnapshot"->'trace' AS "trace", l."contextSnapshot"->>'closed' AS "closed"
         FROM "ai_simple_turn_logs" l
        WHERE l."organizationId"=$1 AND l."conversationId" = ANY($2::text[]) AND l."createdAt" >= $3 AND l."createdAt" < $4
        ORDER BY l."createdAt" ASC LIMIT ${MAX_TURNS * 2}`,
      args.organizationId, convIds, new Date(args.from.getTime() - 60 * 60_000), args.to,
    ),
    db.$queryRawUnsafe<AuditConversation[]>(
      `SELECT c."id", c."number", c."contactId", ct."name" AS "contactName", c."channelId", c."createdAt", c."closedAt", c."hasHumanReply"
         FROM "conversations" c LEFT JOIN "contacts" ct ON ct."id" = c."contactId"
        WHERE c."id" = ANY($1::text[])`,
      convIds,
    ),
    db.$queryRawUnsafe<AuditMessage[]>(
      `SELECT m."id", m."conversationId", m."direction", m."authorType"::text AS "authorType", m."senderName", m."messageType", left(m."content", 300) AS "content",
              m."channelId", m."aiAgentUserId", m."isPrivate", m."createdAt"
         FROM "messages" m
        WHERE m."conversationId" = ANY($1::text[]) AND m."createdAt" >= $2 AND m."createdAt" < $3
        ORDER BY m."createdAt" ASC LIMIT ${MAX_TURNS * 4}`,
      convIds, new Date(args.from.getTime() - 60 * 60_000), new Date(args.to.getTime() + 60 * 60_000),
    ),
  ]);
  const contactIds = [...new Set(conversations.map((c) => c.contactId).filter((x): x is string => !!x))];
  const priorHuman = contactIds.length === 0 ? [] : await db.$queryRawUnsafe<AuditPriorHuman[]>(
    `SELECT c."contactId", c."closedAt", c."id" AS "conversationId"
       FROM "conversations" c
      WHERE c."contactId" = ANY($1::text[]) AND c."status" = 'RESOLVED' AND c."hasHumanReply" = true AND c."closedAt" >= $2 AND c."closedAt" < $3`,
    contactIds, new Date(args.from.getTime() - 2 * 60 * 60_000), args.to,
  );
  const summary = auditFromData({ agentId: args.agentId, turns: own, allTurns, messages, conversations, priorHuman });
  return { ...summary, items: summary.items.slice(0, 300), from: args.from, to: args.to, turns: own.length, truncated };
}
