/**
 * Conversas de teste do agente v2: turnos dos números da lista de teste
 * (`allowedPhoneNumbers`), agrupados por contato e divididos em sessões pelo
 * `#reset`. Sem números de teste (o agente atende todo mundo), as últimas
 * conversas dele, para a tela não ficar vazia com o agente atendendo. Cada turno leva o rastro de decisões e o feedback marcado.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import { normalizePhoneDigits, phoneMatchesAllowlist } from "@/services/ai/phone-allowlist";
import { ensureV2AgentSchema } from "./ensure-schema";
import type { V2TraceStep } from "./trace";
import type { V2TurnFeedback } from "./diagnose";
import { sourcesFromToolCalls, type V2TurnSource } from "./sources";

export type V2TestTurn = {
  id: string;
  createdAt: string;
  conversationId: string;
  isReset: boolean;
  inbound: string;
  reply: string | null;
  handoff: boolean;
  closed: boolean;
  error: string | null;
  stage: string | null;
  theme: string | null;
  rule: string | null;
  llmReason: string | null;
  trace: V2TraceStep[];
  /** Texto dos trechos da base que o modelo leu no turno. */
  sources: V2TurnSource[];
  discardedActions: string[];
  latencyMs: number | null;
  tokens: number;
  feedback: V2TurnFeedback | null;
  /** O que saiu de fato para o WhatsApp neste turno (texto e anexos). */
  deliveries: V2TestDelivery[];
};

/** Mensagem que o turno mandou ao cliente e o que aconteceu com ela no envio. */
export type V2TestDelivery = {
  at: string;
  type: string;
  preview: string;
  /** Situação gravada pelo envio: pending, sent, delivered, read, failed (ou vazio). */
  status: string | null;
  error: string | null;
};

export type V2TestSession = { startedAt: string; turns: V2TestTurn[] };

export type V2TestContact = {
  contactId: string;
  name: string | null;
  phone: string | null;
  sessions: V2TestSession[];
};

type LogRow = {
  id: string;
  createdAt: Date;
  conversationId: string;
  inboundText: string;
  prompt: string;
  reply: string | null;
  handoff: boolean;
  error: string | null;
  llmOutput: unknown;
  discardedActions: unknown;
  contextSnapshot: unknown;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  feedback: unknown;
};

/**
 * Números de teste lidos direto do JSON, como o roteador do motor
 * (agent-resolver): uma configuração que não passasse na validação completa
 * escondia os números aqui e a tela dizia "nenhum".
 */
/** Sem números de teste: quantas conversas recentes mostrar. */
const RECENT_CONVERSATIONS = 30;

function testPhonesOf(configs: unknown[]): string[] {
  const out = new Set<string>();
  for (const raw of configs) {
    const list = (raw as { allowedPhoneNumbers?: unknown } | null)?.allowedPhoneNumbers;
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      const phone = typeof p === "number" ? String(p) : typeof p === "string" ? p.trim() : "";
      if (phone) out.add(phone);
    }
  }
  return [...out];
}

export async function listV2TestConversations(args: {
  organizationId: string;
  agentId: string;
  days?: number;
}): Promise<{ testNumbers: string[]; scope: "test" | "all"; contacts: V2TestContact[] }> {
  await ensureV2AgentSchema().catch(() => undefined);

  const agent = await (prisma as unknown as {
    aIAgentConfig: { findFirst: (a: unknown) => Promise<{ simpleConfig: unknown; draftConfig: unknown } | null> };
  }).aIAgentConfig.findFirst({
    where: { id: args.agentId, organizationId: args.organizationId },
    select: { simpleConfig: true, draftConfig: true },
  });
  if (!agent) throw new Error("Agente não encontrado.");

  let config: ReturnType<typeof normalizeV2Config> | null = null;
  try {
    config = agent.simpleConfig ? normalizeV2Config(agent.simpleConfig) : null;
  } catch {
    // Config inválida: a tela ainda mostra os turnos, só sem nome de assunto/regra.
  }
  const testNumbers = testPhonesOf([agent.simpleConfig, agent.draftConfig]);
  const scope: "test" | "all" = testNumbers.length > 0 ? "test" : "all";
  const allow = new Set(testNumbers.map((p) => normalizePhoneDigits(p)).filter(Boolean));

  const since = new Date(Date.now() - (args.days ?? 7) * 24 * 60 * 60 * 1000);
  const db = prisma as unknown as {
    aISimpleTurnLog: { findMany: (a: unknown) => Promise<LogRow[]> };
    conversation: {
      findMany: (a: unknown) => Promise<Array<{ id: string; contact: { id: string; name: string | null; phone: string | null } | null }>>;
    };
  };

  const recent = await db.aISimpleTurnLog.findMany({
    where: { organizationId: args.organizationId, agentId: args.agentId, createdAt: { gte: since } },
    select: { conversationId: true },
    distinct: ["conversationId"],
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const conversations = await db.conversation.findMany({
    where: { id: { in: recent.map((r) => r.conversationId) } },
    select: { id: true, contact: { select: { id: true, name: true, phone: true } } },
  });
  const order = new Map(recent.map((r, i) => [r.conversationId, i]));
  const testConversations = scope === "test"
    ? conversations.filter((c) => phoneMatchesAllowlist(c.contact?.phone ?? null, allow))
    : conversations.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).slice(0, RECENT_CONVERSATIONS);
  if (testConversations.length === 0) return { testNumbers, scope, contacts: [] };

  const logs = await db.aISimpleTurnLog.findMany({
    where: {
      organizationId: args.organizationId,
      agentId: args.agentId,
      createdAt: { gte: since },
      conversationId: { in: testConversations.map((c) => c.id) },
    },
    orderBy: { createdAt: "asc" },
    take: 2000,
  });

  // Mensagens que saíram para o cliente, com a situação do envio: o rastro
  // diz o que o agente pediu; aqui aparece o que o WhatsApp recebeu ou não.
  type OutRow = { conversationId: string; createdAt: Date; content: string | null; messageType: string; sendStatus: string | null; sendError: string | null };
  const outbound = await Promise.resolve()
    .then(() =>
      (prisma as unknown as { message: { findMany: (a: unknown) => Promise<OutRow[]> } }).message.findMany({
        where: { conversationId: { in: testConversations.map((c) => c.id) }, direction: "out", isPrivate: false, createdAt: { gte: since } },
        select: { conversationId: true, createdAt: true, content: true, messageType: true, sendStatus: true, sendError: true },
        orderBy: { createdAt: "asc" },
        take: 3000,
      }),
    )
    .then((rows) => rows ?? [])
    .catch(() => [] as OutRow[]);
  const logTimes = new Map<string, number[]>();
  for (const l of logs) logTimes.set(l.conversationId, [...(logTimes.get(l.conversationId) ?? []), new Date(l.createdAt).getTime()]);
  const deliveriesByLog = new Map<string, V2TestDelivery[]>();
  for (const m of outbound) {
    const times = logTimes.get(m.conversationId) ?? [];
    const at = new Date(m.createdAt).getTime();
    // O log do turno é gravado no fim: a mensagem é do primeiro turno que terminou depois dela.
    const idx = times.findIndex((t) => t >= at - 1000);
    if (idx < 0) continue;
    const log = logs.filter((l) => l.conversationId === m.conversationId)[idx];
    if (!log) continue;
    const list = deliveriesByLog.get(log.id) ?? [];
    list.push({
      at: new Date(m.createdAt).toISOString(),
      type: m.messageType,
      preview: (m.content ?? "").slice(0, 120),
      status: m.sendStatus ?? null,
      error: m.sendError ?? null,
    });
    deliveriesByLog.set(log.id, list);
  }

  const themeNames = new Map((config?.themes ?? []).map((t) => [t.id, t.name]));
  const ruleNames = new Map((config?.rules ?? []).map((r) => [r.id, r.name ?? r.id]));
  const contactOf = new Map(testConversations.map((c) => [c.id, c.contact]));

  const byContact = new Map<string, V2TestContact>();
  for (const row of logs) {
    const contact = contactOf.get(row.conversationId);
    if (!contact) continue;
    let entry = byContact.get(contact.id);
    if (!entry) {
      entry = { contactId: contact.id, name: contact.name, phone: contact.phone, sessions: [] };
      byContact.set(contact.id, entry);
    }
    const snap = (row.contextSnapshot ?? {}) as Record<string, unknown>;
    const out = (row.llmOutput ?? null) as { reason?: string } | null;
    const isReset = row.prompt === "reset";
    const turn: V2TestTurn = {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      conversationId: row.conversationId,
      isReset,
      inbound: row.inboundText,
      reply: row.reply,
      handoff: row.handoff,
      closed: Boolean(snap.closed),
      error: row.error,
      stage: typeof snap.stage === "string" ? snap.stage : null,
      theme: typeof snap.themeId === "string" ? themeNames.get(snap.themeId) ?? snap.themeId : null,
      rule: typeof snap.appliedRuleId === "string" ? ruleNames.get(snap.appliedRuleId) ?? snap.appliedRuleId : null,
      llmReason: out?.reason?.trim() || null,
      trace: Array.isArray(snap.trace) ? (snap.trace as V2TraceStep[]) : [],
      sources: sourcesFromToolCalls(snap.toolCalls),
      discardedActions: Array.isArray(row.discardedActions)
        ? (row.discardedActions as Array<{ type?: string }>).map((a) => a.type ?? "?")
        : [],
      latencyMs: row.latencyMs,
      tokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      feedback: (row.feedback as V2TurnFeedback | null) ?? null,
      deliveries: deliveriesByLog.get(row.id) ?? [],
    };
    // `#reset` abre uma sessão nova; o primeiro turno também.
    if (isReset || entry.sessions.length === 0) {
      entry.sessions.push({ startedAt: turn.createdAt, turns: [] });
    }
    entry.sessions[entry.sessions.length - 1].turns.push(turn);
  }

  const contacts = [...byContact.values()]
    .map((c) => ({ ...c, sessions: c.sessions.reverse() }))
    .sort((a, b) => (b.sessions[0]?.startedAt ?? "").localeCompare(a.sessions[0]?.startedAt ?? ""));
  return { testNumbers, scope, contacts };
}
