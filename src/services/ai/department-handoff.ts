/**
 * Transferência para departamento — capacidade genérica do CRM.
 *
 * Resolve o departamento pelo nome (exato, depois por conter o nome),
 * solta a conversa do agente e aciona a distribuição; sem departamento
 * resolvido, ainda enfileira na fila de espera. Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { releaseConversationForHandoff } from "@/services/ai/handoff-release";
import { createConversationEvent } from "@/services/conversation-events";
import { executeDistribution } from "@/services/distribution/engine";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai.department-handoff");

export type ResolvedDepartment = { id: string; name: string };

export type DepartmentHandoffResult = {
  departmentId: string | null;
  departmentName: string | null;
  distribution: Awaited<ReturnType<typeof executeDistribution>> | null;
};

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}


/**
 * Casa `Department.name` da organização do contexto. Exato primeiro,
 * depois alias configurado, depois substring. Empate: departamento com
 * mais membros humanos (o que tem quem atender).
 */
export async function resolveDepartmentByNameGeneric(
  name: string,
): Promise<ResolvedDepartment | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const orgId = getOrgIdOrThrow();

  const all = await prisma.department.findMany({
    where: { organizationId: orgId },
    select: {
      id: true,
      name: true,
      _count: {
        select: { members: { where: { user: { type: "HUMAN" } } } },
      },
    },
    orderBy: { name: "asc" },
  });

  const ranked = [...all].sort(
    (a, b) => (b._count.members ?? 0) - (a._count.members ?? 0),
  );
  const needle = normalize(trimmed);

  const exact = ranked.find((d) => normalize(d.name) === needle);
  if (exact) return { id: exact.id, name: exact.name };


  const contains = ranked.find(
    (d) => normalize(d.name).includes(needle) || needle.includes(normalize(d.name)),
  );
  return contains ? { id: contains.id, name: contains.name } : null;
}

/** Departamentos da org, para a mensagem de erro citar os REAIS. */
export async function listDepartmentNames(limit = 12): Promise<string[]> {
  const orgId = getOrgIdOrThrow();
  const rows = await prisma.department.findMany({
    where: { organizationId: orgId },
    select: { name: true },
    orderBy: { name: "asc" },
    take: limit,
  });
  return rows.map((r) => r.name);
}

/**
 * Erro de departamento não encontrado. Cita os departamentos DESTA
 * organização — o texto antigo mandava usar "Onboarding, Retention ou
 * Atendimento", que são de um tenant específico.
 */
export async function departmentNotFoundMessage(name: string): Promise<string> {
  const names = await listDepartmentNames().catch(() => []);
  if (names.length === 0) {
    return `Departamento "${name}" não encontrado nesta organização.`;
  }
  return `Departamento "${name}" não encontrado. Disponíveis: ${names.join(", ")}.`;
}

export const SELF_DEPARTMENT_ROUTE_ERROR =
  "Esse departamento é o seu. Rotear para ele não muda nada e não conecta ninguém: siga o atendimento ou, se precisar de gente, chame a transferência para humano.";

/**
 * O agente está roteando para o departamento do qual ele próprio é
 * membro? `transfer_to_department` não tira a conversa da IA — só fixa o
 * departamento responsável. Apontando para o próprio escopo vira no-op, e
 * o modelo lê o `ok` como transferência feita: anuncia ao contato que
 * encaminhou "para o setor X" sendo o setor X, e no turno seguinte pede o
 * mesmo dado de novo.
 *
 * Escalar para humano do próprio departamento continua valendo — isso
 * passa por `transfer_to_human` / `execute_distribution`, não por aqui.
 */
export async function selfDepartmentRouteError(args: {
  agentUserId?: string | null;
  departmentId: string;
}): Promise<string | null> {
  if (!args.agentUserId) return null;
  const member = await prisma.departmentMember.findFirst({
    where: { userId: args.agentUserId, departmentId: args.departmentId },
    select: { id: true },
  });
  return member ? SELF_DEPARTMENT_ROUTE_ERROR : null;
}

export type DepartmentHandoffArgs = {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
  userMessage?: string | null;
  /** Se informado, tem prioridade sobre o departamento já roteado. */
  departmentName?: string | null;
  reason?: string;
};

/**
 * Handoff genérico: define o departamento, solta a conversa da IA e
 * aciona a Distribuição Inteligente. Sem departamento resolvido, o motor
 * ainda enfileira em `DistributionPending` (fila de espera) — o caso 3 do
 * critério de aceite.
 */
export async function executeGenericDepartmentHandoff(
  args: DepartmentHandoffArgs,
): Promise<DepartmentHandoffResult> {
  let dept: ResolvedDepartment | null = null;

  if (args.departmentName?.trim()) {
    dept = await resolveDepartmentByNameGeneric(args.departmentName);
  }

  // Respeita o departamento já fixado na conversa (ex.: via
  // `transfer_to_department` no turno anterior).
  if (!dept) {
    const conv = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: { departmentId: true },
    });
    if (conv?.departmentId) {
      dept = await prisma.department.findUnique({
        where: { id: conv.departmentId },
        select: { id: true, name: true },
      });
    }
  }

  let contactId = args.contactId;
  if (!contactId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: { contactId: true },
    });
    contactId = conv?.contactId ?? null;
  }

  // Solta a IA e fixa o departamento — só grava se algo muda (a varredura
  // de segurança repete o handoff; ver `handoff-release.ts`).
  await releaseConversationForHandoff({
    conversationId: args.conversationId,
    departmentId: dept?.id ?? null,
  });

  const distribution = await executeDistribution({
    dealId: args.dealId ?? null,
    contactId,
    conversationId: args.conversationId,
    triggerSource: "AI_AGENT",
    departmentId: dept?.id ?? null,
    reassign: true,
  });

  const selectedUserId =
    distribution?.success && distribution.selectedUserId
      ? distribution.selectedUserId
      : null;
  const selectedUser = selectedUserId
    ? await prisma.user.findUnique({
        where: { id: selectedUserId },
        select: { type: true, name: true },
      })
    : null;
  const selectedIsHuman = selectedUser?.type === "HUMAN";

  // Evento de timeline só na atribuição. Fila sem elegível não gera
  // evento — o sweeper reprocessa e spamava o chat.
  if (selectedIsHuman) {
    await createConversationEvent({
      conversationId: args.conversationId,
      action: "distribuicao",
      text:
        `Conversa distribuída para ${dept?.name ?? "atendimento"}` +
        (selectedUser?.name ? ` → ${selectedUser.name}` : ""),
      actor: "Agente IA",
      authorType: "bot",
      dedupeStartsWith: ["Conversa distribuída para"],
      dedupeWindowMs: 2 * 60 * 1000,
    }).catch(() => null);
  }

  // Alinha `Deal.owner` com o assignee da conversa: header do negócio e
  // automação de saudação (`lead_distributed`) na mesma pessoa.
  if (selectedIsHuman && selectedUserId && contactId) {
    try {
      const { assignDealOwner } = await import("@/services/deals");
      let dealId = args.dealId ?? null;
      if (!dealId) {
        const latest = await prisma.deal.findFirst({
          where: { contactId },
          orderBy: { updatedAt: "desc" },
          select: { id: true },
        });
        dealId = latest?.id ?? null;
      }
      if (dealId) await assignDealOwner(dealId, selectedUserId);
    } catch (e) {
      log.warn({ err: e }, "[department-handoff] align deal owner failed");
    }
  }

  return {
    departmentId: dept?.id ?? null,
    departmentName: dept?.name ?? null,
    distribution,
  };
}

