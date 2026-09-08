/**
 * Transferência para departamento — capacidade GENÉRICA do CRM.
 *
 * Departamento, distribuição e fila existem para qualquer organização.
 * Mesmo assim, `execute_distribution` e `transfer_to_department`
 * dependiam de ops do pack acadêmico (`resolveDepartmentByName`,
 * `executeAcademicDepartmentHandoff`): agente sem vertical simplesmente
 * NÃO conseguia transferir, e a mensagem de erro citava os departamentos
 * de uma organização só.
 *
 * Aqui a resolução e o handoff são genéricos. O pack, quando existe,
 * REFINA (override de departamento, roster, funil operacional) — nunca é
 * pré-requisito.
 */

import type { InboxPolicy } from "@/lib/ai-agents/steering";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { createConversationEvent } from "@/services/conversation-events";
import { executeDistribution } from "@/services/distribution/engine";
import type { VerticalPackOps } from "@/verticals/types";

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

/** Aliases configurados pelo operador, achatados em uma lista de termos. */
function policyAliasTerms(policy?: InboxPolicy | null): string[] {
  const map = policy?.departmentAliases;
  if (!map) return [];
  return [...map.acolhimento, ...map.retencao, ...map.atendimento];
}

/**
 * Casa `Department.name` da organização do contexto. Exato primeiro,
 * depois alias configurado, depois substring. Empate: departamento com
 * mais membros humanos (o que tem quem atender).
 */
export async function resolveDepartmentByNameGeneric(
  name: string,
  policy?: InboxPolicy | null,
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

  // Alias do operador que casa com o que o modelo pediu → o departamento
  // que contém aquele alias.
  for (const alias of policyAliasTerms(policy)) {
    const a = normalize(alias);
    if (!a || (!a.includes(needle) && !needle.includes(a))) continue;
    const hit = ranked.find((d) => normalize(d.name).includes(a));
    if (hit) return { id: hit.id, name: hit.name };
  }

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
 * organização — o texto antigo mandava usar "Acolhimento, Retenção ou
 * Atendimento", que são de um tenant específico.
 */
export async function departmentNotFoundMessage(name: string): Promise<string> {
  const names = await listDepartmentNames().catch(() => []);
  if (names.length === 0) {
    return `Departamento "${name}" não encontrado nesta organização.`;
  }
  return `Departamento "${name}" não encontrado. Disponíveis: ${names.join(", ")}.`;
}

/** Resolve com refino do pack, se houver; senão, genérico. */
export async function resolveDepartmentForAgent(
  name: string,
  args: { ops?: VerticalPackOps | null; policy?: InboxPolicy | null },
): Promise<ResolvedDepartment | null> {
  const packResolve = args.ops?.resolveDepartmentByName;
  if (packResolve) {
    return (await packResolve(name, args.policy ?? null)) ?? null;
  }
  return resolveDepartmentByNameGeneric(name, args.policy ?? null);
}

export type DepartmentHandoffArgs = {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
  userMessage?: string | null;
  /** Se informado, tem prioridade sobre o departamento já roteado. */
  departmentName?: string | null;
  reason?: string;
  policy?: InboxPolicy | null;
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
    dept = await resolveDepartmentByNameGeneric(
      args.departmentName,
      args.policy,
    );
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

  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: {
      ...(dept ? { departmentId: dept.id } : {}),
      // Solta a IA. `aiGreetedAt` fica: zerar reenvia a saudação se o
      // agente reassumir a conversa depois.
      assignedToId: null,
      updatedAt: new Date(),
    },
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
      console.warn("[department-handoff] align deal owner failed", e);
    }
  }

  return {
    departmentId: dept?.id ?? null,
    departmentName: dept?.name ?? null,
    distribution,
  };
}

/**
 * Ponto único de handoff. Com pack que implementa o refino, delega; sem
 * pack, executa o genérico. Nunca falha por ausência de vertical.
 */
export async function executeDepartmentHandoff(
  args: DepartmentHandoffArgs & { ops?: VerticalPackOps | null },
): Promise<DepartmentHandoffResult> {
  const packHandoff = args.ops?.executeAcademicDepartmentHandoff;
  if (packHandoff) {
    const { ops: _ops, ...rest } = args;
    return packHandoff(rest);
  }
  const { ops: _ops, ...rest } = args;
  return executeGenericDepartmentHandoff(rest);
}
