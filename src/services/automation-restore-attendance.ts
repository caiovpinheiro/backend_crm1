/**
 * Execução do passo "Devolver atendimento" (`restore_attendance`).
 * Regras puras em `lib/restore-attendance.ts`.
 *
 * Agente: dono do contato, dos negócios abertos e das conversas do contato
 * (mesma cascata do "Atribuir responsável" → Contato). Departamento: só a
 * conversa alvo. Conversa encerrada sem `reopen`: grava na conversa
 * encerrada — o próximo ticket herda responsável e departamento dela
 * (`reopenResolvedAsNewTicket`).
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { getLogger } from "@/lib/logger";
import {
  pickPreviousAttendance,
  readRestoreAttendanceConfig,
  resolveRestoreTarget,
} from "@/lib/restore-attendance";
import { logConversationDepartmentChange } from "@/services/conversation-department-event";
import { logConversationAssigneeChanges, propagateOwnerToContactAndChat } from "@/services/deals";
import { ASSIGN_OWNER_VIA } from "@/services/distribution/mode";
import { publishConversationTimelineUpdated } from "@/lib/realtime-events";

const log = getLogger("automation.restore-attendance");

/** Um ticket não acumula dezenas de trocas; teto só por segurança. */
const MAX_EVENTS = 200;

const EVENT_TYPES = ["CONVERSATION_DEPARTMENT_CHANGED", "ASSIGNEE_CHANGED", "LEAD_DISTRIBUTED"];

export type RestoreAttendanceInput = {
  config: unknown;
  contactId?: string | null;
  /** Conversa do evento (gatilho) — senão a mais recente do contato. */
  conversationId?: string | null;
  /** Departamento que encerrou (payload de `conversation_tabulated`). */
  endedDepartmentId?: string | null;
};

export type RestoreAttendanceResult = {
  conversationId: string | null;
  note: string;
};

/** Agente anterior só vale se for humano e não anonimizado. */
async function usableHuman(userId: string | null | undefined): Promise<string | null | undefined> {
  if (userId === undefined || userId === null) return userId;
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { id: true, type: true, isErased: true },
  });
  if (!user || user.type !== "HUMAN" || user.isErased) return undefined;
  return user.id;
}

async function usableDepartment(departmentId: string | null | undefined): Promise<string | null | undefined> {
  if (departmentId === undefined || departmentId === null) return departmentId;
  const dept = await prisma.department.findFirst({ where: { id: departmentId }, select: { id: true } });
  return dept ? dept.id : undefined;
}

async function setConversationDepartment(
  conv: { id: string; externalId: string | null; contactId: string | null; departmentId: string | null; assignedToId: string | null },
  departmentId: string | null,
): Promise<void> {
  if ((conv.departmentId ?? null) === departmentId) return;
  await prisma.conversation.update({ where: { id: conv.id }, data: { departmentId }, select: { id: true } });
  await logConversationDepartmentChange({
    conversationId: conv.id,
    contactId: conv.contactId,
    externalId: conv.externalId,
    fromDepartmentId: conv.departmentId,
    toDepartmentId: departmentId,
    fromAssigneeId: conv.assignedToId,
    extraMeta: { restoreAttendance: true },
  });
}

async function setAgent(
  conv: { id: string; contactId: string | null },
  userId: string | null,
): Promise<void> {
  const via = userId ? ASSIGN_OWNER_VIA : null;
  if (conv.contactId) {
    const contactId = conv.contactId;
    const changes = await prisma.$transaction(async (tx) => {
      const c = await propagateOwnerToContactAndChat(tx, contactId, userId, { via });
      await tx.deal.updateMany({
        where: { contactId, status: "OPEN" },
        data: { ownerId: userId, assignedVia: via },
      });
      return c;
    });
    if (changes.length > 0) await logConversationAssigneeChanges(changes);
    return;
  }
  await prisma.conversation.update({ where: { id: conv.id }, data: { assignedToId: userId }, select: { id: true } });
}

export async function runRestoreAttendance(input: RestoreAttendanceInput): Promise<RestoreAttendanceResult> {
  const cfg = readRestoreAttendanceConfig(input.config);

  const select = {
    id: true,
    status: true,
    externalId: true,
    contactId: true,
    departmentId: true,
    assignedToId: true,
    organizationId: true,
  } as const;
  const conv = input.conversationId
    ? await prisma.conversation.findFirst({ where: { id: input.conversationId }, select })
    : input.contactId
      ? await prisma.conversation.findFirst({
          where: { contactId: input.contactId },
          orderBy: [{ updatedAt: "desc" }],
          select,
        })
      : null;
  if (!conv) return { conversationId: null, note: "Sem conversa para devolver" };

  const needsHistory = cfg.agentMode === "previous" || cfg.departmentMode === "previous";
  let previous: ReturnType<typeof pickPreviousAttendance> = {
    userId: undefined,
    departmentId: undefined,
    agentSource: "none",
  };
  if (needsHistory) {
    const events = await prisma.activityEvent.findMany({
      where: { conversationId: conv.id, type: { in: EVENT_TYPES } },
      orderBy: { occurredAt: "desc" },
      take: MAX_EVENTS,
      select: { type: true, occurredAt: true, meta: true },
    });
    previous = pickPreviousAttendance(events, {
      endedDepartmentId: input.endedDepartmentId ?? conv.departmentId,
    });
  }

  const agent = resolveRestoreTarget(cfg.agentMode, await usableHuman(previous.userId), cfg.notFound);
  const dept = resolveRestoreTarget(cfg.departmentMode, await usableDepartment(previous.departmentId), cfg.notFound);

  const notes: string[] = [];
  if (cfg.agentMode === "previous" && previous.userId === undefined) notes.push("agente anterior não encontrado");
  if (cfg.departmentMode === "previous" && previous.departmentId === undefined) {
    notes.push("departamento anterior não encontrado");
  }

  // Departamento antes do agente: o evento de departamento grava quem
  // atendia (`fromAssigneeId`) no momento da troca.
  if (dept.change) await setConversationDepartment(conv, dept.value);
  if (agent.change) await setAgent(conv, agent.value);

  let targetId = conv.id;
  if (cfg.reopen && conv.status === "RESOLVED") {
    const { reopenResolvedAsNewTicket } = await import("@/services/conversations");
    const reopened = await reopenResolvedAsNewTicket(conv.id);
    targetId = reopened.id;
    // Reabrir cai no departamento de um ticket irmão quando a origem ficou
    // sem — aqui o pedido foi explícito, então vale o resultado do passo.
    const fresh = await prisma.conversation.findFirst({
      where: { id: reopened.id },
      select: { departmentId: true, assignedToId: true },
    });
    const wantDept = dept.change ? dept.value : conv.departmentId;
    const wantAgent = agent.change ? agent.value : conv.assignedToId;
    if (fresh && ((fresh.departmentId ?? null) !== (wantDept ?? null) || (fresh.assignedToId ?? null) !== (wantAgent ?? null))) {
      await prisma.conversation.update({
        where: { id: reopened.id },
        data: { departmentId: wantDept ?? null, assignedToId: wantAgent ?? null },
        select: { id: true },
      });
    }
    notes.push(reopened.created ? "conversa reaberta" : "já havia conversa aberta");
  }

  const orgId = conv.organizationId ?? getOrgIdOrNull();
  if (orgId) {
    const { publishConversationAssignmentUpdate } = await import("@/services/conversations");
    for (const id of new Set([conv.id, targetId])) {
      // Lista do Inbox (aba/responsável/departamento) e chatter sem F5.
      await publishConversationAssignmentUpdate({
        organizationId: orgId,
        conversationId: id,
        previousAssignedToId: id === conv.id ? conv.assignedToId : null,
      });
      try {
        publishConversationTimelineUpdated({
          organizationId: orgId,
          conversationId: id,
          type: "CONVERSATION_DEPARTMENT_CHANGED",
        });
      } catch (err) {
        log.warn({ err }, "publish falhou (best-effort)");
      }
    }
  }

  const describe = (t: typeof agent, label: string) =>
    !t.change ? `${label} mantido` : t.value ? `${label} devolvido` : `${label} removido`;
  const note = [describe(agent, "agente"), describe(dept, "departamento"), ...notes].join(" · ");
  return { conversationId: targetId, note };
}
