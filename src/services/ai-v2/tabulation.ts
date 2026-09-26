/**
 * Tabulação do agente v2 ("Começo e fim › Tabulação"), ao encerrar e/ou ao
 * transferir. Dois jeitos de escolher a folha:
 *  - "fixed" (padrão): a do assunto, senão a padrão, senão (ao encerrar) a
 *    de encerramento automático do departamento da conversa;
 *  - "ai": o agente lê o atendimento e escolhe entre as folhas permitidas
 *    (lista da config, ou as do departamento da conversa); sem decisão,
 *    vale a regra fixa.
 * Antes a config existia mas nada a lia: o que o agente encerrava ficava
 * sem tabulação. Nunca sobrescreve folha já aplicada (regra do CRM).
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import type { V2AgentConfig, V2Theme } from "@/lib/ai-v2/types";
import { v2AuxModel } from "@/lib/ai-v2/models";
import { maskEvidenceText } from "./feedback-extract";
import { speaker, type LearnMessage } from "./learn-extract";
import { noteV2Fact, traceStep } from "./trace";

export type V2TabulationMoment = "close" | "transfer";

type LeafOption = { id: string; label: string; departmentId: string };

const MAX_LEAVES_IN_PROMPT = 150;
const MAX_MESSAGES = 40;

/** O momento vale para a config ("Quando"). */
export function tabulationAppliesAt(config: V2AgentConfig, moment: V2TabulationMoment): boolean {
  const t = config.tabulation;
  if (!t?.enabled) return false;
  const when = t.when ?? "on_close";
  if (moment === "close" && when === "on_transfer") return false;
  if (moment === "transfer" && when === "on_close") return false;
  return true;
}

/** Folha configurada para o momento (sem a do departamento), ou null. */
export function pickV2TabulationId(config: V2AgentConfig, theme: V2Theme | null | undefined, moment: V2TabulationMoment): string | null {
  if (!tabulationAppliesAt(config, moment)) return null;
  const t = config.tabulation!;
  return theme?.tabulationId || (theme ? t.byTheme?.[theme.id] : undefined) || t.fallbackId || null;
}

/** Resposta do modelo → folha da lista (id inventado ou fora da lista = null). */
export function parseTabulationChoice(raw: unknown, allowedIds: Set<string>): { id: string | null; reason: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof r.id === "string" && allowedIds.has(r.id.trim()) ? r.id.trim() : null;
  const reason = typeof r.reason === "string" ? r.reason.trim().slice(0, 200) : "";
  return { id, reason };
}

export const TABULATION_CLASSIFY_SYSTEM = [
  "Você classifica um atendimento de WhatsApp em UMA das tabulações da lista: a que melhor descreve o motivo do contato e como ele terminou.",
  "Use só ids da lista. Se nenhuma descrever bem o atendimento, responda id null — não force.",
  'Responda só JSON: {"id": "<id da lista>" | null, "reason": "<uma frase curta>"}',
].join("\n");

function parseJson(text: string): unknown {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function conversationDepartment(conversationId: string): Promise<string | null> {
  const conv = await (prisma as unknown as {
    conversation: { findUnique: (args: unknown) => Promise<{ departmentId: string | null } | null> };
  }).conversation.findUnique({ where: { id: conversationId }, select: { departmentId: true } });
  return conv?.departmentId ?? null;
}

async function candidateLeaves(config: V2AgentConfig, organizationId: string, departmentId: string | null): Promise<LeafOption[]> {
  const { listActiveTabulationLeaves } = await import("@/services/tabulations");
  const allowed = (config.tabulation?.allowedIds ?? []).filter(Boolean);
  // Lista da config: folhas da org inteira filtradas por ela; sem lista, as
  // do departamento da conversa (a própria função cai na org se ele não tem).
  const leaves = await listActiveTabulationLeaves({ organizationId, departmentId: allowed.length ? null : departmentId });
  return leaves
    .filter((l) => allowed.length === 0 || allowed.includes(l.id))
    .map((l) => ({ id: l.id, label: `${l.departmentName} › ${l.path}`, departmentId: l.departmentId }));
}

async function transcript(conversationId: string): Promise<string> {
  const rows = await (prisma as unknown as {
    message: {
      findMany: (args: unknown) => Promise<Array<{ direction: string; authorType: string; content: string | null; createdAt: Date; aiAgentUserId: string | null }>>;
    };
  }).message.findMany({
    where: { conversationId, isPrivate: false, messageType: { not: "note" } },
    orderBy: { createdAt: "desc" },
    take: MAX_MESSAGES,
    select: { direction: true, authorType: true, content: true, createdAt: true, aiAgentUserId: true },
  });
  return rows
    .reverse()
    .filter((m) => (m.content ?? "").trim())
    .map((m) => {
      const msg: LearnMessage = { ...m, isAi: !!m.aiAgentUserId };
      return `${speaker(msg)}: ${maskEvidenceText((m.content ?? "").trim()).slice(0, 600)}`;
    })
    .join("\n");
}

/** Modo "ai": o agente escolhe a folha lendo o atendimento. Null = sem decisão. */
async function chooseWithAgent(args: {
  config: V2AgentConfig;
  agentId: string;
  organizationId: string;
  conversationId: string;
  theme: V2Theme | null | undefined;
  moment: V2TabulationMoment;
}): Promise<string | null> {
  const departmentId = await conversationDepartment(args.conversationId);
  const leaves = (await candidateLeaves(args.config, args.organizationId, departmentId)).slice(0, MAX_LEAVES_IN_PROMPT);
  if (leaves.length === 0) {
    traceStep("tabulação", "Agente escolheria a tabulação, mas não há folhas ativas disponíveis");
    return null;
  }
  const conversation = await transcript(args.conversationId);
  if (!conversation) return null;
  const { getAgentApiKey } = await import("@/services/ai/agent-key");
  const { generateWithTools } = await import("@/services/ai/provider");
  const instructions = args.config.tabulation?.instructions?.trim();
  const user = [
    `Tabulações:\n${leaves.map((l) => `- ${l.id}: ${l.label}`).join("\n")}`,
    instructions ? `Orientações da equipe:\n${instructions}` : "",
    args.theme ? `Assunto identificado pelo agente: ${args.theme.name}` : "",
    `Momento: ${args.moment === "close" ? "encerramento" : "transferência para a equipe"}`,
    `Atendimento:\n${conversation}`,
  ].filter(Boolean).join("\n\n");
  const res = await generateWithTools({
    model: v2AuxModel(args.config.model),
    apiKey: await getAgentApiKey(args.agentId),
    system: TABULATION_CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: user }] as never,
    temperature: 0,
    maxOutputTokens: 200,
    maxSteps: 1,
  });
  const choice = parseTabulationChoice(parseJson(res.text), new Set(leaves.map((l) => l.id)));
  const label = leaves.find((l) => l.id === choice.id)?.label;
  traceStep("tabulação", choice.id
    ? `Agente escolheu "${label}"${choice.reason ? ` — ${choice.reason}` : ""}`
    : `Agente não achou tabulação que sirva${choice.reason ? ` (${choice.reason})` : ""} → regra por assunto/padrão`);
  return choice.id;
}

/** Aplica a tabulação do momento, se configurada. Falha não interrompe o turno. */
export async function applyV2Tabulation(args: {
  config: V2AgentConfig;
  theme: V2Theme | null | undefined;
  moment: V2TabulationMoment;
  organizationId: string;
  conversationId: string;
  contactId?: string | null;
  /** Agente (chave do modelo no modo "ai"). */
  agentId?: string;
}): Promise<void> {
  if (!tabulationAppliesAt(args.config, args.moment)) return;
  try {
    let tabulationId: string | null = null;
    // De onde veio a folha (relatório de ações e passos).
    let by: "agent" | "rule" | "department" = "rule";
    if (args.config.tabulation?.strategy === "ai" && args.agentId) {
      tabulationId = await chooseWithAgent({ ...args, agentId: args.agentId }).catch((err) => {
        traceStep("tabulação", `Escolha pelo agente falhou (${err instanceof Error ? err.message : String(err)}) → regra por assunto/padrão`);
        return null;
      });
      if (tabulationId) by = "agent";
    }
    tabulationId ??= pickV2TabulationId(args.config, args.theme, args.moment);
    if (!tabulationId && args.moment === "close") {
      const departmentId = await conversationDepartment(args.conversationId);
      if (departmentId) {
        const { resolveAutoCloseTabulation } = await import("@/services/tabulations");
        const auto = await resolveAutoCloseTabulation({ organizationId: args.organizationId, departmentId }).catch(() => null);
        tabulationId = auto?.tabulationId ?? null;
        if (tabulationId) by = "department";
      }
    }
    if (!tabulationId) {
      traceStep("tabulação", "Tabulação ligada, mas sem folha para este atendimento");
      return;
    }
    const { applyConversationTabulation } = await import("@/services/ai/tabulation-classify");
    const res = await applyConversationTabulation({
      conversationId: args.conversationId,
      organizationId: args.organizationId,
      tabulationId,
      contactId: args.contactId ?? null,
      source: "AI_AGENT",
      closeIfOpen: false,
    });
    traceStep("tabulação", res.ok ? `Tabulada: "${res.tabulation.name}"` : `Não tabulada: ${res.error}`);
    if (res.ok && !res.alreadyApplied) noteV2Fact("tabulation", { name: res.tabulation.name, by });
  } catch (err) {
    traceStep("tabulação", `Falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
}
