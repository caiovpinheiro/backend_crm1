/**
 * Webchat — atendimento de quem chega identificado
 * (docs/decisoes/webchat-widget.md §9.12). Aplicado só com identidade
 * verificada: identify assinado ou S2S. O mesmo código serve o `routing` do
 * canal e o `destination` das regras do S2S.
 *
 * Precedência, da mais forte para a mais fraca:
 *  1. pessoa que já respondeu nesta conversa (nada a tira);
 *  2. responsável atual, com `keepCurrentOwner` e disponível;
 *  3. destino configurado;
 *  4. alternativa, se o destino estiver indisponível;
 *  5. distribuição convencional (`maybeDistributeNewInboundTicket`), que é onde
 *     vivem a volta ao consultor anterior e o 1º atendimento de IA.
 * A Regra 0 (`resolvePostCloseInbound`) não roda no webchat.
 *
 * Aplica uma vez por ticket (`routedAt`): reaplicar a cada mensagem desfaria
 * transferência e handoff. A exceção é a pessoa escolhida aqui que ficou
 * indisponível antes de responder: o ticket segue para a próxima opção.
 *
 * Nunca lança: qualquer falha cai na distribuição convencional.
 */
import { HUMAN_ROUTE_MODE, WEBCHAT_ROUTING_VIA } from "@/lib/conversation-route";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { publishConversationUpdated } from "@/lib/realtime-events";
import { getOrgIdOrThrow } from "@/lib/request-context";
import type { WebchatRoutingConfig, WebchatRoutingTarget } from "@/lib/webchat/v2-config";
import { isAiAttendanceEnabled } from "@/services/ai/attendance-gate";
import { isContactAllowedForAi } from "@/services/ai/phone-allowlist";
import { pickAgentForConversation } from "@/services/ai-v2/agent-resolver";
import { logConversationAssigneeChanges, propagateOwnerToContactAndChat } from "@/services/deals";
import {
  isAssigneeCurrentlyEligible,
  shouldClearOwnershipOnIneligible,
  clearOwnershipForRedistribution,
} from "@/services/distribution/assignee-eligibility";
import { isDistributionEnabled } from "@/services/distribution/enabled";
import { executeDistribution } from "@/services/distribution/engine";
import { executeLeadsDistribution } from "@/services/distribution/leads/engine";
import { getOrgDistributionModeFresh } from "@/services/distribution/mode";
import { maybeDistributeNewInboundTicket } from "@/services/distribution/pending-inbound";
import { getDistributionResponsibles } from "@/services/distribution/responsibles";
import { hasOrganizationWidget } from "@/services/organization-widgets";

const log = getLogger("webchat-routing");

export type WebchatRoutingInput = {
  conversationId: string;
  contactId: string;
  routing: WebchatRoutingConfig;
  /** Uma regra do S2S mandou um destino nesta entrada: vale mesmo em ticket já roteado. */
  force?: boolean;
};

type ConvRow = {
  id: string;
  status: string;
  assignedToId: string | null;
  assignedVia: string | null;
  hasHumanReply: boolean;
  priorityAt: Date | null;
  routedAt: Date | null;
  departmentId: string | null;
  assignedTo: { type: string; name: string | null } | null;
};

/** Distribuição ligada de verdade: fora disso não há presença nem motor. */
async function isMotorOn(): Promise<boolean> {
  return (await hasOrganizationWidget("smart_distribution")) && (await isDistributionEnabled());
}

/** Fila cheia não conta como indisponível: o teto barra lead novo, não este contato. */
async function isPersonAvailable(userId: string): Promise<boolean> {
  if (!(await isMotorOn())) return true;
  const check = await isAssigneeCurrentlyEligible(userId);
  return check.eligible || !shouldClearOwnershipOnIneligible(check.reason, check.blockedReasons);
}

/** User não é tenant-scoped na extensão do Prisma: a org é explícita. */
async function findPerson(userId: string): Promise<{ id: string; name: string | null } | null> {
  return prisma.user.findFirst({
    where: { id: userId, organizationId: getOrgIdOrThrow(), type: "HUMAN", isErased: false },
    select: { id: true, name: true },
  });
}

async function findAvailableAgent(
  userId: string,
  contactId: string,
): Promise<{ id: string; name: string | null } | null> {
  if (!(await isAiAttendanceEnabled())) return null;
  if (!(await isContactAllowedForAi(contactId))) return null;
  const agent = await prisma.user.findFirst({
    where: {
      id: userId,
      organizationId: getOrgIdOrThrow(),
      type: "AI",
      aiAgentConfig: { is: { active: true, engine: "simple" } },
    },
    select: { id: true, name: true, aiAgentConfig: { select: { simpleConfig: true } } },
  });
  if (!agent) return null;
  const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { phone: true } });
  // Canal nulo: quem configurou escolheu este agente. Vale a lista de números de teste.
  return pickAgentForConversation([agent], null, contact?.phone ?? null);
}

/** Responsável na conversa, no contato e nos negócios abertos. Só neste ticket. */
async function assign(
  conv: ConvRow,
  contactId: string,
  owner: { id: string; name: string | null },
  isAi: boolean,
): Promise<void> {
  const organizationId = getOrgIdOrThrow();
  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: conv.id },
      data: {
        assignedToId: owner.id,
        assignedVia: WEBCHAT_ROUTING_VIA,
        routeMode: null,
        ...(isAi && conv.assignedToId !== owner.id ? { aiGreetedAt: null } : {}),
      },
      select: { id: true },
    });
    await propagateOwnerToContactAndChat(tx, contactId, owner.id, { conversations: false });
    await tx.deal.updateMany({
      where: { contactId, status: "OPEN" },
      data: { ownerId: owner.id, assignedVia: WEBCHAT_ROUTING_VIA },
    });
  });
  // Pendência antiga puxaria o ticket de volta para a fila de pessoas.
  await prisma.distributionPending.updateMany({
    where: { status: "PENDING", conversationId: conv.id },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolvedUserId: owner.id },
  });
  if (conv.assignedToId !== owner.id) {
    await logConversationAssigneeChanges([
      {
        conversationId: conv.id,
        contactId,
        entityLabel: null,
        fromUserId: conv.assignedToId,
        fromName: conv.assignedTo?.name ?? null,
        toUserId: owner.id,
        toName: owner.name,
      },
    ]);
  }
  publish(organizationId, conv.id, contactId);
}

function publish(organizationId: string, conversationId: string, contactId: string): void {
  try {
    publishConversationUpdated({ organizationId, conversationId, contactId });
  } catch (err) {
    log.debug({ err }, "SSE do atendimento falhou (não-fatal)");
  }
}

/** Marca "de pessoa": sem isso a IA assume na próxima mensagem. */
async function markHumanRoute(conv: ConvRow, departmentId: string | null): Promise<void> {
  const data = {
    routeMode: HUMAN_ROUTE_MODE,
    ...(departmentId && departmentId !== conv.departmentId ? { departmentId } : {}),
  };
  await prisma.conversation.update({ where: { id: conv.id }, data, select: { id: true } });
}

/** Pede a distribuição de fato; sem ninguém disponível, o motor põe na fila de espera. */
async function requestDistribution(
  conv: ConvRow,
  contactId: string,
  departmentId: string | null,
  leadsDepartment: boolean,
): Promise<void> {
  const reassign = Boolean(conv.assignedToId);
  if (leadsDepartment || (await getOrgDistributionModeFresh()) === "leads") {
    await executeLeadsDistribution({
      contactId,
      conversationId: conv.id,
      triggerSource: "SYSTEM",
      reassign,
    });
    return;
  }
  await executeDistribution({
    dealId: null,
    contactId,
    conversationId: conv.id,
    distributionType: null,
    triggerSource: "WEBCHAT_ROUTING",
    departmentIds: departmentId ? [departmentId] : null,
    departmentId: departmentId ?? conv.departmentId,
    reassign,
    allowOrgWideFallback: false,
  });
}

type TargetResult = { done: boolean; waitDepartmentId?: string; leadsDepartment?: boolean };

async function tryTarget(
  conv: ConvRow,
  contactId: string,
  target: Exclude<WebchatRoutingTarget, { type: "distribution" }>,
): Promise<TargetResult> {
  if (target.type === "user") {
    const person = await findPerson(target.id);
    if (!person || !(await isPersonAvailable(person.id))) return { done: false };
    await assign(conv, contactId, person, false);
    return { done: true };
  }
  if (target.type === "ai_agent") {
    const agent = await findAvailableAgent(target.id, contactId);
    if (!agent) return { done: false };
    await assign(conv, contactId, agent, true);
    return { done: true };
  }
  const department = await prisma.department.findFirst({
    where: { id: target.id },
    select: { id: true, distributionMode: true },
  });
  if (!department) return { done: false };
  const leadsDepartment = department.distributionMode === "leads";
  // Sem motor, o próprio departamento é o destino: a equipe vê a conversa lá.
  if (!(await isMotorOn())) {
    await markHumanRoute(conv, department.id);
    return { done: true };
  }
  if (!leadsDepartment && (await getOrgDistributionModeFresh()) !== "leads") {
    const views = await getDistributionResponsibles({ departmentIds: [department.id] });
    if (!views.some((v) => v.eligible)) return { done: false, waitDepartmentId: department.id };
  }
  await markHumanRoute(conv, department.id);
  await requestDistribution(conv, contactId, department.id, leadsDepartment);
  return { done: true };
}

/** Último passo: nunca deixa o ticket sem destino. */
async function routeToDistribution(
  conv: ConvRow,
  input: WebchatRoutingInput,
  waitDepartmentId: string | null,
): Promise<void> {
  // Fila normal sem departamento pendente: exatamente as regras de hoje.
  if (input.routing.priority !== "high" && !waitDepartmentId) {
    await maybeDistributeNewInboundTicket({
      conversationId: conv.id,
      contactId: input.contactId,
      assignedToId: conv.assignedToId,
    });
    return;
  }
  await markHumanRoute(conv, waitDepartmentId);
  if (await isMotorOn()) await requestDistribution(conv, input.contactId, waitDepartmentId, false);
}

async function route(input: WebchatRoutingInput): Promise<boolean> {
  const { conversationId, contactId, routing } = input;
  const conv: ConvRow | null = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      status: true,
      assignedToId: true,
      assignedVia: true,
      hasHumanReply: true,
      priorityAt: true,
      routedAt: true,
      departmentId: true,
      assignedTo: { select: { type: true, name: true } },
    },
  });
  if (!conv || conv.status !== "OPEN") return false;
  // Quem já respondeu fica; o resto segue a regra de sempre.
  if (conv.hasHumanReply) return false;

  if (routing.priority === "high" && !conv.priorityAt) {
    await prisma.conversation.updateMany({
      where: { id: conversationId, priorityAt: null, hasHumanReply: false },
      data: { priorityAt: new Date() },
    });
    publish(getOrgIdOrThrow(), conversationId, contactId);
  }

  if (conv.routedAt && !input.force) {
    const routedPerson =
      conv.assignedVia === WEBCHAT_ROUTING_VIA && conv.assignedToId && conv.assignedTo?.type === "HUMAN";
    if (!routedPerson || (await isPersonAvailable(conv.assignedToId!))) return false;
    await clearOwnershipForRedistribution({ conversationId, contactId });
    conv.assignedToId = null;
    conv.assignedVia = null;
    conv.assignedTo = null;
  }

  const finish = async () => {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { routedAt: new Date() },
      select: { id: true },
    });
    publish(getOrgIdOrThrow(), conversationId, contactId);
    return true;
  };

  if (routing.keepCurrentOwner) {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { assignedToId: true },
    });
    const ownerId = conv.assignedToId ?? contact?.assignedToId ?? null;
    if (ownerId) {
      const person = await findPerson(ownerId);
      if (person && (await isPersonAvailable(person.id))) {
        await assign(conv, contactId, person, false);
        return finish();
      }
      const agent = person ? null : await findAvailableAgent(ownerId, contactId);
      if (agent) {
        await assign(conv, contactId, agent, true);
        return finish();
      }
    }
  }

  let waitDepartmentId: string | null = null;
  for (const target of [routing.destination, routing.fallback]) {
    if (target.type === "distribution") break;
    const res = await tryTarget(conv, contactId, target);
    if (res.done) return finish();
    waitDepartmentId ??= res.waitDepartmentId ?? null;
  }
  await routeToDistribution(conv, input, waitDepartmentId);
  return finish();
}

/**
 * Aplica o atendimento. `true`: o atendimento cuidou do ticket. `false`: não
 * havia o que fazer aqui e quem chamou segue o caminho de sempre.
 */
export async function applyWebchatRouting(input: WebchatRoutingInput): Promise<boolean> {
  try {
    return await route(input);
  } catch (err) {
    log.error({ err, conversationId: input.conversationId }, "atendimento do webchat falhou");
    return false;
  }
}
