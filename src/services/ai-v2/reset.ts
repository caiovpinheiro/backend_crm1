/**
 * `#reset` pelo WhatsApp: recomeça o atendimento do zero para quem está
 * testando o agente v2.
 *
 * Quem pode: telefone na lista de números de teste (`allowedPhoneNumbers`)
 * de um agente v2 ativo, ou operador com permissão de editar agente (mesma
 * regra do `#iniciar`). Para qualquer outro número o texto segue como
 * mensagem comum — nunca respondemos nada que revele o comando.
 *
 * O que faz:
 *  1. descarta turnos ainda acumulando mensagens;
 *  2. apaga o estado v2 de TODAS as conversas do contato (sem isso o ticket
 *     novo herdaria a janela pós-encerramento do anterior);
 *  3. confirma no WhatsApp e grava um marcador no log (a tela de conversas
 *     de teste separa as sessões por ele);
 *  4. encerra o ticket atual — a próxima mensagem abre um ticket novo, sem o
 *     histórico antigo no prompt do agente.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { normalizePhoneDigits, phoneMatchesAllowlist } from "@/services/ai/phone-allowlist";

export const V2_RESET_COMMAND = "#reset";

export function isV2ResetCommand(raw: string | null | undefined): boolean {
  const text = (raw ?? "").trim().toLowerCase().replace(/[.!?,;:]+$/, "");
  return text === V2_RESET_COMMAND;
}

type ResetAgent = { agentConfigId: string; userId: string };

function phoneInList(phone: string | null | undefined, list: unknown): boolean {
  const items = Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  if (items.length === 0 || !phone) return false;
  const set = new Set(items.map((p) => normalizePhoneDigits(p)).filter(Boolean));
  return phoneMatchesAllowlist(phone, set);
}

/**
 * Agente v2 com que o teste acontece. Número na lista de teste de um agente
 * → esse agente. Operador autorizado → o primeiro agente v2 ativo.
 */
async function resolveResetAgent(orgId: string, contactId: string, phone: string | null): Promise<ResetAgent | null> {
  const agents = await (prisma as unknown as {
    aIAgentConfig: {
      findMany: (args: unknown) => Promise<Array<{ id: string; userId: string; simpleConfig: unknown }>>;
    };
  }).aIAgentConfig.findMany({
    where: { organizationId: orgId, engine: "simple", active: true },
    select: { id: true, userId: true, simpleConfig: true },
    orderBy: { createdAt: "asc" },
  });
  if (agents.length === 0) return null;

  const byTestList = agents.find((a) =>
    phoneInList(phone, (a.simpleConfig as { allowedPhoneNumbers?: unknown } | null)?.allowedPhoneNumbers),
  );
  if (byTestList) return { agentConfigId: byTestList.id, userId: byTestList.userId };

  const { resolveTestModeOperator } = await import("@/services/ai/test-mode");
  const operator = await resolveTestModeOperator(contactId);
  return operator ? { agentConfigId: agents[0].id, userId: agents[0].userId } : null;
}

export async function handleV2ResetCommand(input: {
  conversationId: string;
  contactId: string;
  messageId?: string | null;
  channel: "meta" | "baileys" | "messaging";
}): Promise<boolean> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return false;

  const contact = await prisma.contact.findUnique({
    where: { id: input.contactId },
    select: { phone: true },
  });
  const agent = await resolveResetAgent(orgId, input.contactId, contact?.phone ?? null);
  if (!agent) return false;

  // Webhook repetido não pode resetar duas vezes nem confirmar duas vezes.
  if (input.messageId) {
    const { cache } = await import("@/lib/cache");
    if (!(await cache.tryClaim(`ai:v2-reset:${input.messageId}`, 600))) return true;
  }

  const { invalidateOpenTurns } = await import("@/services/ai/turn-manager");
  await invalidateOpenTurns(input.conversationId, "v2_reset");

  const conversations = await prisma.conversation.findMany({
    where: { contactId: input.contactId },
    select: { id: true },
  });
  await (prisma as unknown as {
    aISimpleConversationState: { deleteMany: (args: unknown) => Promise<{ count: number }> };
  }).aISimpleConversationState.deleteMany({
    where: { conversationId: { in: conversations.map((c) => c.id) } },
  });

  const { isAiAttendanceEnabled } = await import("@/services/ai/attendance-gate");
  const gateOn = await isAiAttendanceEnabled();
  const confirmation = gateOn
    ? "🔄 Atendimento reiniciado. Pode mandar a primeira mensagem."
    : "🔄 Atendimento reiniciado.\n\n⚠️ O atendimento por IA está desligado nesta organização (configuração ai.newAttendanceEnabled): a próxima mensagem não vai para o agente.";

  const { sendAgentMessage } = await import("@/services/ai/piloting-actions");
  await sendAgentMessage({
    conversationId: input.conversationId,
    contactId: input.contactId,
    agentUserId: agent.userId,
    autonomyMode: "AUTONOMOUS",
    text: confirmation,
    channel: input.channel === "messaging" ? "meta" : input.channel,
    kind: "text",
    bypassAssigneeCheck: true,
    bypassDuplicateGuard: true,
  }).catch(() => null);

  // Marcador de sessão na tela de conversas de teste.
  const { logV2Turn } = await import("./log");
  await logV2Turn({
    organizationId: orgId,
    conversationId: input.conversationId,
    agentId: agent.agentConfigId,
    inboundText: V2_RESET_COMMAND,
    crmContext: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } },
    prompt: "reset",
    reply: confirmation,
    executedActions: [],
    discardedActions: [],
    handoff: false,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    owner: "agente",
    stage: "idle",
  }).catch(() => null);

  // Ticket novo na próxima mensagem: histórico limpo para o agente.
  const { resolveConversationsInline } = await import("@/services/conversations");
  await resolveConversationsInline({
    ids: [input.conversationId],
    keepAgent: false,
    keepDepartment: false,
    tabulation: null,
    skipAutomations: true,
  }).catch(() => null);

  console.info("[ai-v2] reset", JSON.stringify({ conversationId: input.conversationId, agentId: agent.agentConfigId }));
  return true;
}
