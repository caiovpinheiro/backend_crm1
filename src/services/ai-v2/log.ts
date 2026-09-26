/**
 * Gravação do trace por turno da v2.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { estimateCost } from "@/lib/ai-agents/pricing";
import type { V2Action, V2CRMContext, V2LLMOutput, V2Owner, V2Stage } from "@/lib/ai-v2/types";
import type { V2ActionResult } from "./actions";
import { takeV2Facts, takeV2TraceForLog } from "./trace";
import { ensureV2AgentSchema } from "./ensure-schema";
import { maskSensitive, maskSensitiveDeep } from "./sensitive";
export async function logV2Turn(args: {
  organizationId: string;
  conversationId: string;
  agentId: string;
  turnId?: string;
  inboundText: string;
  crmContext: V2CRMContext;
  prompt: string;
  llmOutput?: V2LLMOutput;
  executedActions: V2ActionResult[];
  discardedActions: V2Action[];
  reply?: string;
  handoff: boolean;
  closed?: boolean;
  error?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  owner: V2Owner;
  stage: V2Stage;
  themeId?: string;
  appliedRuleId?: string;
  versionId?: string;
  toolCalls?: unknown[];
  governorStats?: Record<string, unknown>;
}): Promise<void> {
  const trace = takeV2TraceForLog();
  const facts = takeV2Facts() ?? {};
  // Causa de transferência só vale no turno que transferiu.
  if (!args.handoff) delete facts.handoffCause;
  const model = typeof facts.model === "string" && facts.model ? facts.model : "gpt-4o-mini";
  const maskIdentity = contactIdentityMasker(args.crmContext);
  // DEV não aplica migrations: a coluna `feedback` pode ainda não existir e
  // o create devolveria (RETURNING) todas as colunas do model.
  await ensureV2AgentSchema().catch(() => undefined);
  const costUsd = estimateCost(model, args.inputTokens, args.outputTokens);
  await (prisma as unknown as {
    aISimpleTurnLog: {
      create: (args: { data: Record<string, unknown>; select: { id: true } }) => Promise<unknown>;
    };
  }).aISimpleTurnLog.create({
    data: {
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      turnId: args.turnId ?? null,
      // Log e telas de teste guardam só a versão mascarada: documento,
      // e-mail, senha e cartão do cliente não ficam gravados aqui.
      inboundText: maskSensitive(args.inboundText).text,
      contextSnapshot: mapStringsDeep(maskSensitiveDeep({
        ...(args.crmContext as unknown as Record<string, unknown>),
        ...(args.toolCalls ? { toolCalls: args.toolCalls } : {}),
        ...(args.governorStats ? { governorStats: args.governorStats } : {}),
        ...(trace ? { trace } : {}),
        stage: args.stage,
        owner: args.owner,
        ...(args.themeId ? { themeId: args.themeId } : {}),
        ...(args.appliedRuleId ? { appliedRuleId: args.appliedRuleId } : {}),
        ...(args.closed ? { closed: true } : {}),
        ...(args.versionId ? { versionId: args.versionId } : {}),
        ...(Object.keys(facts).length > 0 ? { facts } : {}),
      }), maskIdentity),
      prompt: maskIdentity(maskSensitive(args.prompt).text),
      llmOutput: maskSensitiveDeep(args.llmOutput ?? null) as Record<string, unknown> | null,
      executedActions: maskSensitiveDeep(args.executedActions) as unknown as Record<string, unknown>,
      discardedActions: maskSensitiveDeep(args.discardedActions) as unknown as Record<string, unknown>,
      reply: args.reply ? maskSensitive(args.reply).text : null,
      handoff: args.handoff,
      error: args.error ? maskSensitive(args.error).text : null,
      latencyMs: args.latencyMs,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      // Extra fields não colunados; persistidos em JSON no contextSnapshot ou podemos usar coluna adicional.
      // Colocamos metadados em contextSnapshot para manter compatibilidade.
    },
    select: { id: true },
  });
}

/**
 * Nome e telefone do contato saem do contexto e do prompt gravados. O texto
 * da conversa (mensagem e resposta) fica: a tela de testes mostra, e ele já
 * está nas mensagens da conversa.
 */
export function contactIdentityMasker(ctx: V2CRMContext): (s: string) => string {
  const raw = (ctx.contactRaw ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const phone = typeof raw.phone === "string" ? raw.phone.replace(/\D/g, "") : "";
  const names = [...new Set([name, ...name.split(/\s+/)].filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRe = names.length > 0 ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
  const phoneTail = phone.length >= 8 ? phone.slice(-8) : "";
  return (s: string) => {
    let out = nameRe ? s.replace(nameRe, "[nome]") : s;
    if (phoneTail) out = out.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => (m.replace(/\D/g, "").endsWith(phoneTail) ? "[telefone]" : m));
    return out;
  };
}

function mapStringsDeep<T>(value: T, f: (s: string) => string): T {
  if (typeof value === "string") return f(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapStringsDeep(v, f)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStringsDeep(v, f);
    return out as T;
  }
  return value;
}

export async function listV2TurnLogs(args: {
  organizationId: string;
  agentId: string;
  conversationId?: string;
  take?: number;
  skip?: number;
}) {
  return (prisma as unknown as {
    aISimpleTurnLog: {
      findMany: (args: {
        where: Record<string, unknown>;
        orderBy: { createdAt: "desc" };
        take?: number;
        skip?: number;
      }) => Promise<unknown[]>;
    };
  }).aISimpleTurnLog.findMany({
    where: {
      organizationId: args.organizationId,
      agentId: args.agentId,
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: args.take ?? 50,
    skip: args.skip ?? 0,
  });
}
