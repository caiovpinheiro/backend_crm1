/**
 * Resolve Department por nome amigável (Acolhimento / Retenção / Atendimento),
 * com match flexível no banco (ex.: "Atendimento - SAC").
 */

import { executeDistribution } from "@/services/distribution";
import { createConversationEvent } from "@/services/conversation-events";
import { prisma } from "@/lib/prisma";
import { ACADEMIC_DEPARTMENT_ALIASES } from "@/lib/ai-agents/academic-atendimento-prompt";
import { userWantsHumanDistribution } from "@/services/ai/human-queue-policy";

export type AcademicDeptKey = keyof typeof ACADEMIC_DEPARTMENT_ALIASES;

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/** Classifica texto livre / alias em chave canônica. */
export function classifyAcademicDepartmentKey(
  raw: string,
): AcademicDeptKey | null {
  const n = normalize(raw);
  if (!n) return null;
  if (n.includes("acolh")) return "acolhimento";
  if (n.includes("reten")) return "retencao";
  if (n.includes("atend") || n.includes("sac")) return "atendimento";
  return null;
}

/**
 * Inferência de departamento a partir da mensagem do aluno + funil atual.
 * Usado no handoff automático (baixa confiança) e como hint nas tools.
 */
/** Rematrícula / prazo de rematrícula → Atendimento (nunca Acolhimento). */
export function messageImpliesRematricula(userMessage?: string | null): boolean {
  const msg = normalize(userMessage ?? "");
  return (
    /rematr/.test(msg) ||
    /re[\s-]?matricula/.test(msg) ||
    (/prazo/.test(msg) && /matricula/.test(msg))
  );
}

/**
 * Casos operacionais de aluno já matriculado → Atendimento (SAC).
 * Sobrescreve escolha errada de Acolhimento pelo LLM (ex.: disciplina
 * pendente / último semestre).
 */
export function messageImpliesOperationalAtendimento(
  userMessage?: string | null,
): boolean {
  const msg = normalize(userMessage ?? "");
  if (!msg) return false;
  if (messageImpliesRematricula(msg)) return true;
  if (
    /ultim[oa]\s+semestre|semestre\s+final|formand|conclusao\s+de\s+curso|concluir\s+o\s+curso/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /disciplina/.test(msg) &&
    /(pendente|nao\s+(esta|aparece)|faltando|liberar|acrescent)/.test(msg)
  ) {
    return true;
  }
  if (
    /(nao\s+(esta|aparece)|faltando).{0,40}(plataforma|blackboard|ava|ambiente)/.test(
      msg,
    ) ||
    /(plataforma|blackboard|ava).{0,40}(nao\s+(esta|aparece)|faltando|sem\s+a\s+disciplina)/.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

const ACOLHIMENTO_MATRICULA_MAX_AGE_DAYS = 60;

/**
 * Bloqueia Acolhimento quando o relatório de matriculados indica aluno
 * veterano/rematriculado (não calouro). Sem registro → não bloqueia.
 */
export async function shouldBlockAcolhimentoFromMatricula(
  contactId: string | null | undefined,
): Promise<{
  block: boolean;
  reason?: "REMATRICULA" | "DATA_MATRICULA_OLD";
}> {
  if (!contactId) return { block: false };
  try {
    const { getOrgIdOrThrow } = await import("@/lib/request-context");
    const orgId = getOrgIdOrThrow();
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { phone: true, email: true },
    });
    if (!contact) return { block: false };

    const { lookupStudent } = await import("@/services/academic-records");
    const records = await lookupStudent(orgId, {
      phone: contact.phone,
      email: contact.email,
    });
    if (!records.length) return { block: false };

    // lookupStudent já ordena: ativo + matrícula mais recente primeiro.
    const top = records[0];
    const tipo = normalize(top.tipoMatricula ?? "");
    if (tipo.includes("rematric")) {
      return { block: true, reason: "REMATRICULA" };
    }

    const data = top.dataMatricula;
    if (data instanceof Date && !Number.isNaN(data.getTime())) {
      const ageMs = Date.now() - data.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > ACOLHIMENTO_MATRICULA_MAX_AGE_DAYS) {
        return { block: true, reason: "DATA_MATRICULA_OLD" };
      }
    }
    return { block: false };
  } catch (e) {
    console.warn(
      "[academic-handoff] shouldBlockAcolhimentoFromMatricula failed",
      e,
    );
    return { block: false };
  }
}

/**
 * Se o dept atual for Acolhimento e o relatório bloquear, força Atendimento.
 */
export async function enforceAtendimentoIfAcolhimentoBlocked(args: {
  contactId: string | null | undefined;
  dept: { id: string; name: string } | null;
}): Promise<{ id: string; name: string } | null> {
  if (!args.dept) return null;
  if (classifyAcademicDepartmentKey(args.dept.name) !== "acolhimento") {
    return args.dept;
  }
  const gate = await shouldBlockAcolhimentoFromMatricula(args.contactId);
  if (!gate.block) return args.dept;
  const atendimento = await resolveDepartmentByKey("atendimento");
  return atendimento ?? args.dept;
}

export function inferDepartmentFromContext(args: {
  userMessage?: string | null;
  pipelineName?: string | null;
  stageName?: string | null;
}): AcademicDeptKey {
  const msg = normalize(args.userMessage ?? "");
  if (
    /cancel|tranc|desist/.test(msg) ||
    /transferenc\w*\s+(de\s+)?(curso|polo)/.test(msg) ||
    /mudar\s+(de\s+)?(curso|polo)/.test(msg) ||
    /trocar\s+(de\s+)?(curso|polo)/.test(msg)
  ) {
    return "retencao";
  }

  // Antes do funil Acolhimento: rematrícula / operacional (SAC).
  if (
    messageImpliesRematricula(args.userMessage) ||
    messageImpliesOperationalAtendimento(args.userMessage)
  ) {
    return "atendimento";
  }

  const funnel = normalize(
    `${args.pipelineName ?? ""} ${args.stageName ?? ""}`,
  );
  if (funnel.includes("acolh")) return "acolhimento";

  // Início de aulas / calouros / novo ingresso → Acolhimento.
  if (
    /inici[oa]\s*(d[ae]s?\s+)?aulas?/.test(msg) ||
    /comec[oa]\s*(d[ae]s?\s+)?aulas?/.test(msg) ||
    /quando\s+(comec|inic)/.test(msg) ||
    /calouro/.test(msg) ||
    /novo\s+ingresso/.test(msg) ||
    /matricula\s+recente/.test(msg)
  ) {
    return "acolhimento";
  }

  return "atendimento";
}

export async function resolveDepartmentByName(
  name: string,
): Promise<{ id: string; name: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const { getOrgIdOrThrow } = await import("@/lib/request-context");
  const orgId = getOrgIdOrThrow();

  const key =
    classifyAcademicDepartmentKey(trimmed) ??
    (normalize(trimmed).includes("acolh")
      ? "acolhimento"
      : normalize(trimmed).includes("reten")
        ? "retencao"
        : normalize(trimmed).includes("atend")
          ? "atendimento"
          : null);

  // SEMPRE escopado à org do contexto — evita pegar "Atendimento" de
  // outra organização (bug cross-tenant EduIT → Cruzeiro).
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

  const score = (d: (typeof all)[number]) => {
    const dn = normalize(d.name);
    let s = (d._count.members ?? 0) * 10;
    // Prefere "Atendimento - SAC" a um "Atendimento" genérico.
    if (key === "atendimento" && dn.includes("sac")) s += 100;
    if (key === "atendimento" && dn === "atendimento") s -= 20;
    return s;
  };
  const ranked = [...all].sort((a, b) => score(b) - score(a));

  const exact = ranked.find(
    (d) => normalize(d.name) === normalize(trimmed),
  );
  if (exact) return { id: exact.id, name: exact.name };

  if (key) {
    const patterns = ACADEMIC_DEPARTMENT_ALIASES[key];
    const hit = ranked.find((d) => {
      const dn = normalize(d.name);
      return patterns.some((p) => dn.includes(normalize(p)));
    });
    if (hit) return { id: hit.id, name: hit.name };
  }

  const needle = normalize(trimmed);
  const contains = ranked.find((d) => normalize(d.name).includes(needle));
  return contains ? { id: contains.id, name: contains.name } : null;
}

export async function resolveDepartmentByKey(
  key: AcademicDeptKey,
): Promise<{ id: string; name: string } | null> {
  const labels: Record<AcademicDeptKey, string> = {
    acolhimento: "Acolhimento",
    retencao: "Retenção",
    atendimento: "Atendimento",
  };
  return resolveDepartmentByName(labels[key]);
}

/**
 * Após atribuir consultor humano, o negócio vai para o estágio
 * "Em Atendimento" do funil ATENDIMENTO (Kanban operacional).
 */
export async function moveOpenDealToEmAtendimento(args: {
  dealId?: string | null;
  contactId?: string | null;
}): Promise<{ moved: boolean; stageId?: string; dealId?: string }> {
  let dealId = args.dealId ?? null;
  if (!dealId && args.contactId) {
    const open = await prisma.deal.findFirst({
      where: { contactId: args.contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    dealId = open?.id ?? null;
  }
  if (!dealId) return { moved: false };

  const preferred = await prisma.stage.findFirst({
    where: {
      name: { equals: "Em Atendimento", mode: "insensitive" },
      pipeline: { name: { equals: "ATENDIMENTO", mode: "insensitive" } },
    },
    select: { id: true },
  });
  const stage =
    preferred ??
    (await prisma.stage.findFirst({
      where: { name: { equals: "Em Atendimento", mode: "insensitive" } },
      select: { id: true },
      orderBy: { position: "asc" },
    }));
  if (!stage) return { moved: false, dealId };

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      stageId: true,
      stage: {
        select: {
          id: true,
          name: true,
          pipelineId: true,
          pipeline: { select: { name: true } },
        },
      },
    },
  });
  if (!deal) return { moved: false, dealId };
  if (deal.stageId === stage.id) {
    return { moved: true, stageId: stage.id, dealId };
  }

  const origin = deal.stage;
  try {
    const { moveDeal, createDealEvent } = await import("@/services/deals");
    await moveDeal(dealId, stage.id, 0);
    // Marca de onde o card veio: ao encerrar o atendimento a IA devolve o
    // aluno para ESTE estágio (o funil acadêmico de origem), não para um
    // palpite. Também é o único registro do move na timeline — `moveDeal`
    // não grava `STAGE_CHANGED` por conta própria.
    await createDealEvent(
      dealId,
      null,
      "STAGE_CHANGED",
      {
        from: {
          id: origin.id,
          name: origin.name,
          pipelineId: origin.pipelineId,
          pipelineName: origin.pipeline?.name ?? null,
        },
        to: { id: stage.id, name: "Em Atendimento" },
        aiAttendanceHandoff: true,
      },
      { type: "AI", label: "Agente IA" },
    ).catch(() => {});
    return { moved: true, stageId: stage.id, dealId };
  } catch (e) {
    console.error("[academic-handoff] moveOpenDealToEmAtendimento failed", e);
    return { moved: false, stageId: stage.id, dealId };
  }
}

/** Funil de atendimento (fila humana) — de onde o card deve sair ao encerrar. */
function isAtendimentoPipelineName(name?: string | null): boolean {
  const n = normalize(name ?? "");
  return !!n && (n.includes("atendimento") || n === "sac");
}

/**
 * Encerrou o atendimento: devolve o card ao estágio do funil acadêmico em que
 * ele estava ANTES de ir para o funil de Atendimento.
 *
 * Se o deal não está no funil de Atendimento, não mexe — o aluno fica no
 * funil em que já está (regra pedida pela operação).
 */
export async function restoreDealToAcademicOrigin(args: {
  dealId?: string | null;
  contactId?: string | null;
}): Promise<{ moved: boolean; reason: string; dealId?: string; stageId?: string }> {
  let dealId = args.dealId ?? null;
  if (!dealId && args.contactId) {
    const open = await prisma.deal.findFirst({
      where: { contactId: args.contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    dealId = open?.id ?? null;
  }
  if (!dealId) return { moved: false, reason: "NO_DEAL" };

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      stageId: true,
      stage: {
        select: {
          id: true,
          name: true,
          pipelineId: true,
          pipeline: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!deal) return { moved: false, reason: "NO_DEAL" };
  // Fora do funil de Atendimento: mantém onde está.
  if (!isAtendimentoPipelineName(deal.stage?.pipeline?.name)) {
    return { moved: false, reason: "NOT_IN_ATENDIMENTO", dealId };
  }

  const events = await prisma.dealEvent.findMany({
    where: { dealId, type: "STAGE_CHANGED" },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { meta: true },
  });

  type StageRef = { id?: string; pipelineName?: string | null };
  const readRef = (v: unknown): StageRef | null =>
    typeof v === "object" && v !== null ? (v as StageRef) : null;

  let originStageId: string | null = null;
  for (const ev of events) {
    const meta = (ev.meta as Record<string, unknown> | null) ?? {};
    const from = readRef(meta.from);
    const to = readRef(meta.to);
    if (!from?.id) continue;
    const enteredAtendimento =
      meta.aiAttendanceHandoff === true ||
      to?.id === deal.stageId ||
      isAtendimentoPipelineName(to?.pipelineName);
    if (!enteredAtendimento) continue;
    if (isAtendimentoPipelineName(from.pipelineName)) continue;
    originStageId = from.id;
    break;
  }

  if (!originStageId) return { moved: false, reason: "NO_ORIGIN", dealId };

  const originStage = await prisma.stage.findUnique({
    where: { id: originStageId },
    select: {
      id: true,
      name: true,
      pipelineId: true,
      pipeline: { select: { name: true } },
    },
  });
  // Estágio apagado ou que virou parte do próprio Atendimento: não arrisca.
  if (!originStage || isAtendimentoPipelineName(originStage.pipeline?.name)) {
    return { moved: false, reason: "ORIGIN_GONE", dealId };
  }
  if (originStage.id === deal.stageId) {
    return { moved: false, reason: "ALREADY_THERE", dealId };
  }

  try {
    const { moveDeal, createDealEvent } = await import("@/services/deals");
    await moveDeal(dealId, originStage.id, 0);
    await createDealEvent(
      dealId,
      null,
      "STAGE_CHANGED",
      {
        from: {
          id: deal.stageId,
          name: deal.stage?.name ?? deal.stageId,
          pipelineId: deal.stage?.pipelineId ?? null,
          pipelineName: deal.stage?.pipeline?.name ?? null,
        },
        to: {
          id: originStage.id,
          name: originStage.name,
          pipelineId: originStage.pipelineId,
          pipelineName: originStage.pipeline?.name ?? null,
        },
        aiAttendanceReturn: true,
      },
      { type: "AI", label: "Agente IA" },
    ).catch(() => {});
    return { moved: true, reason: "MOVED", dealId, stageId: originStage.id };
  } catch (e) {
    console.error("[academic-closure] restoreDealToAcademicOrigin failed", e);
    return { moved: false, reason: "ERROR", dealId };
  }
}

/**
 * Dúvida comercial sobre valor/grade/info de curso (em geral outro curso
 * que não o da matrícula) — NUNCA site institucional; sempre humano.
 */
export function isCourseShoppingInquiry(userMessage: string): boolean {
  const msg = normalize(userMessage);
  if (!msg) return false;
  if (
    /(valor|preco|mensalidade|investimento|quanto\s+custa).{0,50}(curso|graduacao|pos[\s-]?graduacao|mba)/.test(
      msg,
    ) ||
    /(curso|graduacao|pos[\s-]?graduacao|mba).{0,50}(valor|preco|mensalidade|investimento|quanto\s+custa)/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /grade\s+curricular|matriz\s+curricular|disciplinas\s+(do|de)\s+curso|grade\s+do\s+curso/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /quais\s+cursos|cursos\s+disponiveis|quero\s+saber\s+(do|sobre)\s+(o\s+)?curso|informac(ao|oes)\s+(do|sobre)\s+(o\s+)?curso|outro\s+curso/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /cruzeiro\.(edu|com)|portal\.cruzeiro|site\s+(da\s+)?cruzeiro|www\.cruzeiro/.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Handoff imediato justificado pelo TEXTO do aluno (sem esperar confiança).
 * Pedido explícito de humano, retenção, ou dúvida comercial de curso/valor.
 * Dúvidas operacionais (ex.: início das aulas) NÃO justificam — a IA atende.
 */
export function isImmediateAcademicHandoffJustified(
  userMessage?: string | null,
): boolean {
  const msg = (userMessage ?? "").trim();
  if (!msg) return false;
  if (userWantsHumanDistribution(msg)) return true;
  if (isCourseShoppingInquiry(msg)) return true;
  if (inferDepartmentFromContext({ userMessage: msg }) === "retencao") {
    return true;
  }
  return false;
}

/** Texto do agente implica handoff (mesmo sem tool). */
export function textImpliesAcademicHandoff(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  return (
    t.includes("vou te conectar") ||
    t.includes("vou conectar voce") ||
    t.includes("conectar com um") ||
    t.includes("conectar com uma") ||
    t.includes("consultor(a) fala") ||
    t.includes("consultor fala com voce") ||
    t.includes("consultora fala com voce") ||
    t.includes("setor de retenc") ||
    t.includes("ja esta na fila")
  );
}

/**
 * Handoff acadêmico: define departamento + Distribuição Inteligente.
 * Substitui o “só limpar assignee” do transfer_to_human genérico.
 */
export async function executeAcademicDepartmentHandoff(args: {
  conversationId: string;
  contactId: string | null;
  dealId?: string | null;
  userMessage?: string | null;
  /** Se informado, tem prioridade sobre a inferência. */
  departmentName?: string | null;
  reason?: string;
}): Promise<{
  departmentId: string | null;
  departmentName: string | null;
  distribution: Awaited<ReturnType<typeof executeDistribution>> | null;
}> {
  try {
    const { ensureAcademicDepartmentRoster } = await import(
      "@/services/ai/ensure-academic-dept-roster"
    );
    await ensureAcademicDepartmentRoster({ force: true });
  } catch {
    /* ignore */
  }

  let pipelineName: string | null = null;
  let stageName: string | null = null;
  if (args.dealId) {
    const deal = await prisma.deal.findUnique({
      where: { id: args.dealId },
      select: {
        stage: {
          select: {
            name: true,
            pipeline: { select: { name: true } },
          },
        },
      },
    });
    stageName = deal?.stage?.name ?? null;
    pipelineName = deal?.stage?.pipeline?.name ?? null;
  } else if (args.contactId) {
    const deal = await prisma.deal.findFirst({
      where: { contactId: args.contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: {
        stage: {
          select: {
            name: true,
            pipeline: { select: { name: true } },
          },
        },
      },
    });
    stageName = deal?.stage?.name ?? null;
    pipelineName = deal?.stage?.pipeline?.name ?? null;
  }

  let userMessage = args.userMessage ?? null;
  // Junta as últimas inbound: o LLM às vezes chama a tool só com o
  // nome da disciplina, e o motivo ("pendente na plataforma") ficou
  // na mensagem anterior — sem isso o override de Atendimento falha.
  let recentInboundBlob = userMessage ?? "";
  if (args.conversationId) {
    const recentIn = await prisma.message.findMany({
      where: {
        conversationId: args.conversationId,
        direction: "in",
        isPrivate: false,
      },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { content: true },
    });
    if (!userMessage) {
      userMessage = recentIn[0]?.content ?? null;
    }
    recentInboundBlob = [userMessage, ...recentIn.map((m) => m.content ?? "")]
      .filter(Boolean)
      .join("\n");
  }

  let dept: { id: string; name: string } | null = null;

  // Rematrícula / operacional (disciplina pendente, último semestre…)
  // prevalece sobre o departmentName que a IA escolher (ex.: Acolhimento).
  if (
    messageImpliesRematricula(recentInboundBlob) ||
    messageImpliesOperationalAtendimento(recentInboundBlob)
  ) {
    dept = await resolveDepartmentByKey("atendimento");
  }

  if (!dept && args.departmentName?.trim()) {
    dept = await resolveDepartmentByName(args.departmentName);
  }

  // Antes de re-inferir pelo texto do aluno, respeita o departamento que
  // já foi fixado na conversa (ex.: via transfer_to_department).
  if (!dept) {
    const convRow = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: { departmentId: true },
    });
    if (convRow?.departmentId) {
      dept = await prisma.department.findUnique({
        where: { id: convRow.departmentId },
        select: { id: true, name: true },
      });
    }
  }

  if (!dept) {
    const key = inferDepartmentFromContext({
      userMessage,
      pipelineName,
      stageName,
    });
    dept = await resolveDepartmentByKey(key);
  }

  // Garante contactId cedo: gate de Acolhimento + DistributionPending.
  let contactId = args.contactId;
  if (!contactId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: args.conversationId },
      select: { contactId: true },
    });
    contactId = conv?.contactId ?? null;
  }

  // Relatório de matriculados: rematrícula / data > 60d → nunca Acolhimento.
  dept = await enforceAtendimentoIfAcolhimentoBlocked({
    contactId,
    dept,
  });

  if (dept) {
    await prisma.conversation.update({
      where: { id: args.conversationId },
      data: {
        departmentId: dept.id,
        assignedToId: null,
        // Mantém aiGreetedAt: se zerar, o próximo inbound reassumido
        // pela IA reenvia a openingMessage (bug Thabata).
        updatedAt: new Date(),
      },
    });
  } else {
    await prisma.conversation.update({
      where: { id: args.conversationId },
      data: {
        assignedToId: null,
        updatedAt: new Date(),
      },
    });
  }

  // AI_AGENT: se ninguém elegível (offline / fila cheia / fora do dept),
  // o motor enfileira em DistributionPending e a conversa fica sem
  // assignedToId → aparece em "Aguardando distribuição".
  const distribution = await executeDistribution({
    dealId: args.dealId ?? null,
    contactId,
    conversationId: args.conversationId,
    triggerSource: "AI_AGENT",
    departmentId: dept?.id ?? null,
    reassign: true,
  });

  // Evento de timeline só na atribuição. Fila sem elegível não gera
  // evento — o sweeper reprocessa e spamava o chat.
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
  const deptLabel = dept?.name ?? "atendimento";
  if (selectedIsHuman) {
    await createConversationEvent({
      conversationId: args.conversationId,
      action: "distribuicao",
      text:
        `Conversa distribuída para ${deptLabel}` +
        (selectedUser?.name ? ` → ${selectedUser.name}` : ""),
      actor: "Agente IA",
      authorType: "bot",
      dedupeStartsWith: ["Conversa distribuída para"],
      dedupeWindowMs: 2 * 60 * 1000,
    }).catch(() => null);
  }

  // Consultor humano atribuído → funil operacional "Em Atendimento".
  if (selectedIsHuman) {
    await moveOpenDealToEmAtendimento({
      dealId: args.dealId ?? null,
      contactId,
    }).catch(() => null);
  }

  // Alinha Deal.owner (incl. LOST/WON) com o assignee da conversa — o header
  // do negócio e a automação de saudação (lead_distributed) ficam na mesma pessoa.
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
      if (dealId) {
        await assignDealOwner(dealId, selectedUserId);
      }
    } catch (e) {
      console.warn("[academic-handoff] align deal owner failed", e);
    }
  }

  return {
    departmentId: dept?.id ?? null,
    departmentName: dept?.name ?? null,
    distribution,
  };
}
