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
 *
 * `#reset total` (mesma regra de quem pode) faz isso e mais: negócios do
 * contato voltam à 1ª etapa do funil padrão (OPEN), os campos do negócio que
 * os agentes gravam são limpos, agenda/régua do agente e mensagens agendadas
 * são canceladas e o resumo do atendimento anterior deixa de entrar no prompt.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { normalizePhoneDigits, phoneMatchesAllowlist } from "@/services/ai/phone-allowlist";
import { getLogger } from "@/lib/logger";
import { noteMessageRowChange } from "@/lib/cache/message-versions";

const log = getLogger("ai-v2.reset");

export const V2_RESET_COMMAND = "#reset";
export const V2_RESET_TOTAL_COMMAND = "#reset total";

function normalizeCommand(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/[.!?,;:]+$/, "").replace(/\s+/g, " ");
}

/** `#reset` ou `#reset total`. */
export function isV2ResetCommand(raw: string | null | undefined): boolean {
  const text = normalizeCommand(raw);
  return text === V2_RESET_COMMAND || text === V2_RESET_TOTAL_COMMAND;
}

export function isV2ResetTotalCommand(raw: string | null | undefined): boolean {
  return normalizeCommand(raw) === V2_RESET_TOTAL_COMMAND;
}

/** Marcador do `#reset total`: o resumo e o trecho do atendimento anterior a ele não entram no prompt. */
export const V2_RESET_MARKER_TYPE = "ai_v2_reset";

type ResetTotalReport = {
  deals: Array<{ id: string; fromStageId: string; toStageId: string; reopened: boolean }>;
  clearedFields: number;
  cancelledSends: number;
  cancelledScheduledMessages: number;
};

/**
 * Campos do negócio que algum agente v2 ativo grava: permissão "write" em
 * O que ele sabe, atualização no encerramento e ação de regra update_field.
 * Colunas nativas (título, valor, dono…) não entram.
 */
function agentWrittenDealFields(configs: unknown[]): string[] {
  const keys = new Set<string>();
  for (const raw of configs) {
    const c = (raw ?? {}) as {
      contextFields?: { deal?: Array<{ key?: string; permissions?: string[] }> };
      closure?: { fieldUpdates?: Array<{ entity?: string; field?: string; key?: string }> };
      rules?: Array<{ actions?: Array<{ type?: string; entity?: string; field?: string; key?: string }> }>;
    };
    for (const f of c.contextFields?.deal ?? []) if (f.key && f.permissions?.includes("write")) keys.add(f.key);
    for (const u of c.closure?.fieldUpdates ?? []) if ((u.entity ?? "deal") === "deal" && (u.field || u.key)) keys.add(String(u.field || u.key));
    for (const r of c.rules ?? []) for (const a of r.actions ?? []) if (a.type === "update_field" && (a.entity ?? "deal") === "deal" && (a.field || a.key)) keys.add(String(a.field || a.key));
  }
  return [...keys];
}

/**
 * Parte "total" do reset, só para número de teste: negócios do contato de
 * volta à 1ª etapa do funil padrão (OPEN), campos que o agente grava
 * limpos, agenda/régua e mensagens agendadas canceladas, e um marcador que
 * corta o resumo do atendimento anterior. Sem automação: o movimento é
 * direto no banco, com evento no histórico do negócio.
 */
async function resetTotal(orgId: string, contactId: string, conversationIds: string[], agentUserId: string): Promise<ResetTotalReport> {
  const db = prisma as unknown as {
    pipeline: { findFirst: (a: unknown) => Promise<{ id: string } | null> };
    stage: { findFirst: (a: unknown) => Promise<{ id: string } | null> };
    deal: {
      findMany: (a: unknown) => Promise<Array<{ id: string; stageId: string; status: string }>>;
      findFirst: (a: unknown) => Promise<{ id: string; stageId: string; status: string } | null>;
      update: (a: unknown) => Promise<unknown>;
    };
    aIAgentConfig: { findMany: (a: unknown) => Promise<Array<{ simpleConfig: unknown; draftConfig: unknown }>> };
    customField: { findMany: (a: unknown) => Promise<Array<{ id: string }>> };
    dealCustomFieldValue: { deleteMany: (a: unknown) => Promise<{ count: number }> };
    aIV2ScheduledSend: { updateMany: (a: unknown) => Promise<{ count: number }> };
    scheduledMessage: { updateMany: (a: unknown) => Promise<{ count: number }> };
  };
  const report: ResetTotalReport = { deals: [], clearedFields: 0, cancelledSends: 0, cancelledScheduledMessages: 0 };

  // 1. Negócios: os abertos; sem nenhum aberto, o mais recente reabre.
  const pipeline = await db.pipeline.findFirst({ where: { isDefault: true }, select: { id: true }, orderBy: { createdAt: "asc" } });
  const firstStage = pipeline
    ? await db.stage.findFirst({ where: { pipelineId: pipeline.id, isWon: false, isLost: false }, orderBy: { position: "asc" }, select: { id: true } })
    : null;
  let deals = await db.deal.findMany({ where: { contactId, status: "OPEN" }, select: { id: true, stageId: true, status: true } });
  if (deals.length === 0) {
    const latest = await db.deal.findFirst({ where: { contactId }, orderBy: { createdAt: "desc" }, select: { id: true, stageId: true, status: true } });
    if (latest) deals = [latest];
  }
  if (firstStage) {
    const { createDealEventsMany } = await import("@/services/deals");
    for (const d of deals) {
      if (d.stageId === firstStage.id && d.status === "OPEN") continue;
      await db.deal.update({ where: { id: d.id }, data: { stageId: firstStage.id, status: "OPEN", lostReason: null, closedAt: null } });
      report.deals.push({ id: d.id, fromStageId: d.stageId, toStageId: firstStage.id, reopened: d.status !== "OPEN" });
    }
    await createDealEventsMany(report.deals.map((d) => ({
      dealId: d.id,
      userId: agentUserId,
      type: "STAGE_CHANGED",
      meta: { from: { id: d.fromStageId }, to: { id: d.toStageId }, reason: "v2_reset_total", ...(d.reopened ? { reopened: true } : {}) },
    }))).catch(() => null);
  }

  // 2. Campos do negócio que os agentes gravam.
  const dealIds = deals.map((d) => d.id);
  if (dealIds.length > 0) {
    const configs = await db.aIAgentConfig.findMany({ where: { engine: "simple", active: true }, select: { simpleConfig: true, draftConfig: true } });
    const keys = agentWrittenDealFields(configs.flatMap((c) => [c.simpleConfig, c.draftConfig].filter(Boolean)));
    if (keys.length > 0) {
      const fields = await db.customField.findMany({
        where: { entity: { equals: "deal", mode: "insensitive" }, OR: [{ id: { in: keys } }, ...keys.map((k) => ({ name: { equals: k, mode: "insensitive" } }))] },
        select: { id: true },
      });
      if (fields.length > 0) {
        const res = await db.dealCustomFieldValue.deleteMany({ where: { dealId: { in: dealIds }, customFieldId: { in: fields.map((f) => f.id) } } });
        report.clearedFields = res.count;
      }
    }
  }

  // 3. Agenda, retomada e régua do agente; mensagens agendadas pela equipe.
  const now = new Date();
  report.cancelledSends = (await db.aIV2ScheduledSend.updateMany({
    where: { contactId, status: { in: ["PENDING", "SENDING"] } },
    data: { status: "CANCELLED", outcome: "v2_reset_total", cancelledAt: now },
  }).catch(() => ({ count: 0 }))).count;
  report.cancelledScheduledMessages = (await db.scheduledMessage.updateMany({
    where: { conversationId: { in: conversationIds }, status: "PENDING" },
    data: { status: "CANCELLED", cancelledAt: now },
  }).catch(() => ({ count: 0 }))).count;

  return report;
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

  // Fora das listas de números de teste dos agentes, o #reset não vale.
  return null;
}

export async function handleV2ResetCommand(input: {
  conversationId: string;
  contactId: string;
  messageId?: string | null;
  channel: "meta" | "baileys" | "messaging";
  /** `#reset total`: também reinicia o negócio, os campos, a agenda e o resumo. */
  total?: boolean;
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
  const total = input.total === true;
  const totalReport = total
    ? await resetTotal(orgId, input.contactId, conversations.map((c) => c.id), agent.userId).catch((err) => {
        log.error({ err, conversationId: input.conversationId }, "[ai-v2] #reset total: parte do negócio falhou");
        return null;
      })
    : null;
  await (prisma as unknown as {
    aISimpleConversationState: { deleteMany: (args: unknown) => Promise<{ count: number }> };
  }).aISimpleConversationState.deleteMany({
    where: { conversationId: { in: conversations.map((c) => c.id) } },
  });

  // Pendência de distribuição de um teste anterior fazia o agente achar que o
  // cliente estava na fila (e a conversa era devolvida à fila).
  try {
    await (prisma as unknown as {
      distributionPending: { updateMany: (args: unknown) => Promise<{ count: number }> };
    }).distributionPending.updateMany({
      where: {
        status: "PENDING",
        OR: [{ conversationId: { in: conversations.map((c) => c.id) } }, { contactId: input.contactId }],
      },
      data: { status: "CANCELLED" },
    });
  } catch {
    /* sem pendência a cancelar não impede o reset */
  }

  const { isAiAttendanceEnabled } = await import("@/services/ai/attendance-gate");
  const gateOn = await isAiAttendanceEnabled();
  const totalLine = totalReport
    ? `Reset total: ${totalReport.deals.length} negócio(s) na 1ª etapa, ${totalReport.clearedFields} campo(s) limpo(s), ${totalReport.cancelledSends + totalReport.cancelledScheduledMessages} envio(s) agendado(s) cancelado(s), resumo anterior desconsiderado.`
    : total ? "⚠️ Reset total incompleto: o negócio não foi reiniciado (veja o log)." : "";
  const confirmation = [
    gateOn ? "🔄 Atendimento reiniciado. Pode mandar a primeira mensagem." : "🔄 Atendimento reiniciado.",
    totalLine,
    gateOn ? "" : "⚠️ O atendimento por IA está desligado nesta organização (configuração ai.newAttendanceEnabled): a próxima mensagem não vai para o agente.",
  ].filter(Boolean).join("\n\n");

  const { sendAgentMessage } = await import("@/services/ai/send-agent-message");
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
    inboundText: total ? V2_RESET_TOTAL_COMMAND : V2_RESET_COMMAND,
    crmContext: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } },
    prompt: totalReport ? `reset total ${JSON.stringify(totalReport)}` : "reset",
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

  // Reset total: o resumo/trecho do atendimento anterior não entra no prompt
  // do ticket novo (loadPriorV2Summary ignora o que veio antes do marcador).
  if (total) {
    const marker = await prisma.message.create({
      data: {
        organizationId: orgId,
        conversationId: input.conversationId,
        content: "Reset total do atendimento (teste)",
        direction: "out",
        messageType: V2_RESET_MARKER_TYPE,
        isPrivate: true,
        authorType: "bot",
        senderName: "#reset total",
      },
    }).catch(() => null);
    if (marker) void noteMessageRowChange(marker, "new");
  }

  // Ticket novo na próxima mensagem: histórico limpo para o agente.
  const { resolveConversationsInline } = await import("@/services/conversations");
  await resolveConversationsInline({
    ids: [input.conversationId],
    keepAgent: false,
    keepDepartment: false,
    tabulation: null,
    skipAutomations: true,
  }).catch(() => null);

  log.info({ conversationId: input.conversationId, agentId: agent.agentConfigId, total, ...(totalReport ? { totalReport } : {}) }, "[ai-v2] reset");
  return true;
}
