/**
 * Handoff do agente IA — um motor, três destinos.
 *
 * Departamento → Distribuição Inteligente (pool humano).
 * Pessoa nomeada → cluster se elegível; senão fila do departamento dela.
 * Agente IA nomeado → cluster naquele user (fora do rodízio humano).
 *
 * Sem `assign_owner` cru: cluster + CAS (humano) iguais ao motor smart.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { createConversationEvent } from "@/services/conversation-events";
import { assignOwnerToContactClusterTx } from "@/services/deals";
import { isAiAttendanceEnabled } from "@/services/ai/attendance-gate";
import {
  executeDepartmentHandoff,
  resolveDepartmentByNameGeneric,
  type DepartmentHandoffResult,
} from "@/services/ai/department-handoff";
import { triggerAgentOpeningForContact } from "@/services/ai/piloting-actions";
import { isAssigneeCurrentlyEligible } from "@/services/distribution/assignee-eligibility";
import { claimConversationAssignmentTx } from "@/services/distribution/claim";
import type { InboxPolicy, ToolPolicy } from "@/lib/ai-agents/steering";
import { listAllows, listBlocks, normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import type { VerticalPackOps } from "@/verticals/types";

export type HandoffTargetKind = "department" | "user" | "ai_agent";

export type OrchestratedHandoffArgs = {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
  fromAgentUserId: string;
  target: HandoffTargetKind;
  /** Nome ou id, conforme o destino. */
  name: string;
  reason?: string;
  userMessage?: string | null;
  policy?: InboxPolicy | null;
  toolPolicy?: ToolPolicy | null;
  ops?: VerticalPackOps | null;
};

export type OrchestratedHandoffResult = {
  target: HandoffTargetKind;
  assigned: boolean;
  assignedTo: string | null;
  assignedUserId: string | null;
  assignedUserType: "HUMAN" | "AI" | null;
  departmentName: string | null;
  queuedWaiting: boolean;
  distributionReason: string | null;
  fallback: "department_queue" | null;
  error?: string;
};

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function looksLikeId(raw: string): boolean {
  return /^c[a-z0-9]{20,}$/i.test(raw.trim());
}

function nameGate(
  list: string[],
  blocked: string[],
  name: string,
  kindLabel: string,
): string | null {
  if (listBlocks(blocked, name)) {
    return `${kindLabel} "${name}" está bloqueado para este agente.`;
  }
  if (!listAllows(list, name)) {
    return `${kindLabel} "${name}" não liberado. Permitidos: ${list.join(", ")}.`;
  }
  return null;
}

type ResolvedUser = {
  id: string;
  name: string;
  type: "HUMAN" | "AI";
};

async function resolveOrgUser(args: {
  name: string;
  type: "HUMAN" | "AI";
}): Promise<{ user: ResolvedUser } | { error: string }> {
  const orgId = getOrgIdOrThrow();
  const needle = args.name.trim();
  if (!needle) return { error: `${args.type === "AI" ? "Agente" : "Pessoa"} sem nome.` };

  const baseWhere = {
    organizationId: orgId,
    type: args.type,
    ...(args.type === "AI"
      ? { aiAgentConfig: { active: true, autonomyMode: "AUTONOMOUS" as const } }
      : {}),
  };

  if (looksLikeId(needle)) {
    const byId = await prisma.user.findFirst({
      where: { ...baseWhere, id: needle },
      select: { id: true, name: true, type: true },
    });
    if (byId && (byId.type === "HUMAN" || byId.type === "AI")) {
      return { user: { id: byId.id, name: byId.name, type: byId.type } };
    }
  }

  const rows = await prisma.user.findMany({
    where: baseWhere,
    select: { id: true, name: true, type: true },
    orderBy: { name: "asc" },
    take: 80,
  });
  const n = fold(needle);
  const exact = rows.filter((r) => fold(r.name) === n);
  if (exact.length === 1 && (exact[0].type === "HUMAN" || exact[0].type === "AI")) {
    return { user: { id: exact[0].id, name: exact[0].name, type: exact[0].type } };
  }
  if (exact.length > 1) {
    return {
      error: `Há mais de um ${args.type === "AI" ? "agente" : "usuário"} chamado "${needle}". Use o nome completo.`,
    };
  }
  const contains = rows.filter(
    (r) => fold(r.name).includes(n) || n.includes(fold(r.name)),
  );
  if (contains.length === 1 && (contains[0].type === "HUMAN" || contains[0].type === "AI")) {
    return {
      user: { id: contains[0].id, name: contains[0].name, type: contains[0].type },
    };
  }
  if (contains.length > 1) {
    return {
      error: `Nome "${needle}" é ambíguo. Opções: ${contains.map((r) => r.name).join(", ")}.`,
    };
  }
  const labels = rows.slice(0, 12).map((r) => r.name);
  const kind = args.type === "AI" ? "Agente IA" : "Pessoa";
  if (labels.length === 0) {
    return { error: `${kind} "${needle}" não encontrado nesta organização.` };
  }
  return {
    error: `${kind} "${needle}" não encontrado. Disponíveis: ${labels.join(", ")}.`,
  };
}

async function firstDepartmentOfUser(
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const row = await prisma.departmentMember.findFirst({
    where: { userId },
    select: { department: { select: { id: true, name: true } } },
    orderBy: { department: { name: "asc" } },
  });
  return row?.department ?? null;
}

function fromDepartmentResult(
  dept: DepartmentHandoffResult,
  fallback: OrchestratedHandoffResult["fallback"],
): OrchestratedHandoffResult {
  const distribution = dept.distribution;
  const queuedWaiting =
    distribution?.reason === "NO_ELIGIBLE_RESPONSIBLE" ||
    distribution?.reason === "NO_DEPARTMENT";
  return {
    target: "department",
    assigned: Boolean(distribution?.success),
    assignedTo: distribution?.selectedUserName ?? null,
    assignedUserId: distribution?.selectedUserId ?? null,
    assignedUserType: distribution?.success ? "HUMAN" : null,
    departmentName: dept.departmentName,
    queuedWaiting,
    distributionReason: distribution?.reason ?? null,
    fallback,
  };
}

async function assignNamedHuman(args: {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
  user: ResolvedUser;
  reason: string;
}): Promise<OrchestratedHandoffResult> {
  const orgId = getOrgIdOrThrow();
  const claimed = await prisma.$transaction(async (tx) => {
    const ok = await claimConversationAssignmentTx(tx, {
      conversationId: args.conversationId,
      userId: args.user.id,
      via: "smart",
    });
    if (!ok) return false;
    await assignOwnerToContactClusterTx(tx, {
      userId: args.user.id,
      via: "smart",
      contactId: args.contactId,
      dealId: args.dealId,
      conversationId: args.conversationId,
    });
    await tx.distributionResponsible.upsert({
      where: {
        organizationId_userId: { organizationId: orgId, userId: args.user.id },
      },
      update: { lastExecutionAt: new Date() },
      create: {
        organizationId: orgId,
        userId: args.user.id,
        lastExecutionAt: new Date(),
      },
    });
    return true;
  });

  if (!claimed) {
    return {
      target: "user",
      assigned: false,
      assignedTo: null,
      assignedUserId: null,
      assignedUserType: null,
      departmentName: null,
      queuedWaiting: false,
      distributionReason: "ASSIGN_RACE",
      fallback: null,
      error: "Outro fluxo atribuiu a conversa no mesmo instante. Tente de novo.",
    };
  }

  await createConversationEvent({
    conversationId: args.conversationId,
    action: "distribuicao",
    text: `Conversa atribuída a ${args.user.name}`,
    actor: "Agente IA",
    authorType: "bot",
    dedupeStartsWith: ["Conversa atribuída a"],
    dedupeWindowMs: 2 * 60 * 1000,
  }).catch(() => null);

  return {
    target: "user",
    assigned: true,
    assignedTo: args.user.name,
    assignedUserId: args.user.id,
    assignedUserType: "HUMAN",
    departmentName: null,
    queuedWaiting: false,
    distributionReason: "ASSIGNED",
    fallback: null,
  };
}

async function assignNamedAi(args: {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
  user: ResolvedUser;
}): Promise<OrchestratedHandoffResult> {
  await prisma.$transaction((tx) =>
    assignOwnerToContactClusterTx(tx, {
      userId: args.user.id,
      via: null,
      contactId: args.contactId,
      dealId: args.dealId,
      conversationId: args.conversationId,
    }),
  );

  await createConversationEvent({
    conversationId: args.conversationId,
    action: "distribuicao",
    text: `Conversa transferida para o agente ${args.user.name}`,
    actor: "Agente IA",
    authorType: "bot",
    dedupeStartsWith: ["Conversa transferida para o agente"],
    dedupeWindowMs: 2 * 60 * 1000,
  }).catch(() => null);

  if (args.contactId) {
    const dest = await prisma.user.findUnique({
      where: { id: args.user.id },
      select: {
        aiAgentConfig: { select: { inboxPolicy: true, verticalPack: true } },
      },
    });
    const destPolicy = dest?.aiAgentConfig
      ? normalizeInboxPolicy(
          dest.aiAgentConfig.inboxPolicy,
          dest.aiAgentConfig.verticalPack,
        )
      : null;
    if (destPolicy?.speakOnAiTransfer) {
      await triggerAgentOpeningForContact({
        contactId: args.contactId,
        agentUserId: args.user.id,
      }).catch(() => null);
    }
  }

  return {
    target: "ai_agent",
    assigned: true,
    assignedTo: args.user.name,
    assignedUserId: args.user.id,
    assignedUserType: "AI",
    departmentName: null,
    queuedWaiting: false,
    distributionReason: "ASSIGNED",
    fallback: null,
  };
}

export async function executeOrchestratedHandoff(
  args: OrchestratedHandoffArgs,
): Promise<OrchestratedHandoffResult> {
  const name = args.name.trim();
  const reason = args.reason?.trim() || "Handoff via agente IA";
  const tool = args.toolPolicy;

  if (args.target === "department") {
    if (tool) {
      const gate = name
        ? nameGate(tool.allowedDepartments, tool.blockedDepartments, name, "Departamento")
        : null;
      if (gate) {
        return {
          target: "department",
          assigned: false,
          assignedTo: null,
          assignedUserId: null,
          assignedUserType: null,
          departmentName: null,
          queuedWaiting: false,
          distributionReason: null,
          fallback: null,
          error: gate,
        };
      }
    }
    if (name) {
      const dept = await resolveDepartmentByNameGeneric(name, args.policy);
      if (!dept) {
        return {
          target: "department",
          assigned: false,
          assignedTo: null,
          assignedUserId: null,
          assignedUserType: null,
          departmentName: null,
          queuedWaiting: false,
          distributionReason: "NO_DEPARTMENT",
          fallback: null,
          error: `Departamento "${name}" não encontrado nesta organização.`,
        };
      }
    }
    const deptResult = await executeDepartmentHandoff({
      conversationId: args.conversationId,
      contactId: args.contactId,
      dealId: args.dealId,
      userMessage: args.userMessage,
      departmentName: name || null,
      reason,
      policy: args.policy,
      ops: args.ops,
    });
    return fromDepartmentResult(deptResult, null);
  }

  if (args.target === "user") {
    if (tool) {
      const gate = nameGate(
        tool.allowedUserNames,
        [],
        name,
        "Pessoa",
      );
      if (gate) {
        return {
          target: "user",
          assigned: false,
          assignedTo: null,
          assignedUserId: null,
          assignedUserType: null,
          departmentName: null,
          queuedWaiting: false,
          distributionReason: null,
          fallback: null,
          error: gate,
        };
      }
    }
    const resolved = await resolveOrgUser({ name, type: "HUMAN" });
    if ("error" in resolved) {
      return {
        target: "user",
        assigned: false,
        assignedTo: null,
        assignedUserId: null,
        assignedUserType: null,
        departmentName: null,
        queuedWaiting: false,
        distributionReason: null,
        fallback: null,
        error: resolved.error,
      };
    }
    const check = await isAssigneeCurrentlyEligible(resolved.user.id);
    if (check.eligible) {
      return assignNamedHuman({
        conversationId: args.conversationId,
        contactId: args.contactId,
        dealId: args.dealId,
        user: resolved.user,
        reason,
      });
    }
    const dept = await firstDepartmentOfUser(resolved.user.id);
    const deptResult = await executeDepartmentHandoff({
      conversationId: args.conversationId,
      contactId: args.contactId,
      dealId: args.dealId,
      userMessage: args.userMessage,
      departmentName: dept?.name ?? null,
      reason: `${reason} (${resolved.user.name} indisponível — fila do departamento)`,
      policy: args.policy,
      ops: args.ops,
    });
    return fromDepartmentResult(deptResult, "department_queue");
  }

  if (!(await isAiAttendanceEnabled())) {
    return {
      target: "ai_agent",
      assigned: false,
      assignedTo: null,
      assignedUserId: null,
      assignedUserType: null,
      departmentName: null,
      queuedWaiting: false,
      distributionReason: null,
      fallback: null,
      error: "Atendimento por IA está desligado nesta organização.",
    };
  }
  if (tool) {
    const gate = nameGate(tool.allowedAgentNames, [], name, "Agente IA");
    if (gate) {
      return {
        target: "ai_agent",
        assigned: false,
        assignedTo: null,
        assignedUserId: null,
        assignedUserType: null,
        departmentName: null,
        queuedWaiting: false,
        distributionReason: null,
        fallback: null,
        error: gate,
      };
    }
  }
  const resolved = await resolveOrgUser({ name, type: "AI" });
  if ("error" in resolved) {
    return {
      target: "ai_agent",
      assigned: false,
      assignedTo: null,
      assignedUserId: null,
      assignedUserType: null,
      departmentName: null,
      queuedWaiting: false,
      distributionReason: null,
      fallback: null,
      error: resolved.error,
    };
  }
  if (resolved.user.id === args.fromAgentUserId) {
    return {
      target: "ai_agent",
      assigned: false,
      assignedTo: null,
      assignedUserId: null,
      assignedUserType: null,
      departmentName: null,
      queuedWaiting: false,
      distributionReason: null,
      fallback: null,
      error: "A conversa já está com este agente.",
    };
  }
  return assignNamedAi({
    conversationId: args.conversationId,
    contactId: args.contactId,
    dealId: args.dealId,
    user: resolved.user,
  });
}

export type { ExecuteDistributionResult };
