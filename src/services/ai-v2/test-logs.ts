/**
 * Conversas de teste do agente v2: turnos dos números da lista de teste
 * (`allowedPhoneNumbers`), agrupados por contato e divididos em sessões pelo
 * `#reset`. Cada turno leva o rastro de decisões e o feedback marcado.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import { normalizePhoneDigits, phoneMatchesAllowlist } from "@/services/ai/phone-allowlist";
import { ensureV2AgentSchema } from "./ensure-schema";
import type { V2TraceStep } from "./trace";
import type { V2TurnFeedback } from "./diagnose";

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
  discardedActions: string[];
  latencyMs: number | null;
  tokens: number;
  feedback: V2TurnFeedback | null;
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

function testPhonesOf(configs: unknown[]): string[] {
  const out = new Set<string>();
  for (const raw of configs) {
    if (!raw) continue;
    try {
      for (const p of normalizeV2Config(raw).allowedPhoneNumbers ?? []) {
        if (p.trim()) out.add(p.trim());
      }
    } catch {
      /* config inválida não derruba a tela */
    }
  }
  return [...out];
}

export async function listV2TestConversations(args: {
  organizationId: string;
  agentId: string;
  days?: number;
}): Promise<{ testNumbers: string[]; contacts: V2TestContact[] }> {
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
  if (testNumbers.length === 0) return { testNumbers, contacts: [] };
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
    take: 500,
  });
  const conversations = await db.conversation.findMany({
    where: { id: { in: recent.map((r) => r.conversationId) } },
    select: { id: true, contact: { select: { id: true, name: true, phone: true } } },
  });
  const testConversations = conversations.filter((c) => phoneMatchesAllowlist(c.contact?.phone ?? null, allow));
  if (testConversations.length === 0) return { testNumbers, contacts: [] };

  const logs = await db.aISimpleTurnLog.findMany({
    where: {
      organizationId: args.organizationId,
      agentId: args.agentId,
      createdAt: { gte: since },
      conversationId: { in: testConversations.map((c) => c.id) },
    },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });

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
      discardedActions: Array.isArray(row.discardedActions)
        ? (row.discardedActions as Array<{ type?: string }>).map((a) => a.type ?? "?")
        : [],
      latencyMs: row.latencyMs,
      tokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      feedback: (row.feedback as V2TurnFeedback | null) ?? null,
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
  return { testNumbers, contacts };
}
