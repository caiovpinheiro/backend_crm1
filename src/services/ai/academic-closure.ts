/**
 * Encerramento de conversa feito pelo agente IA (somente atendimento IA).
 * Dispara o mesmo gatilho da ação manual (`conversation_tabulated`) para
 * a automação "Encerramento" devolver o card ao funil acadêmico.
 */

import { getOrgSettingBool } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { sseBus } from "@/lib/sse-bus";
import { logEvent } from "@/services/activity-log";
import { fireTrigger } from "@/services/automation-triggers";
import { updateConversationStatusInDb } from "@/services/conversations";
import { resolveAutoCloseTabulation, tabulationLogMeta } from "@/services/tabulations";

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/** Pedido explícito do aluno para encerrar o atendimento com a IA. */
export function userWantsAiConversationClose(
  userMessage?: string | null,
): boolean {
  const msg = normalize(userMessage ?? "");
  if (!msg) return false;
  if (msg.length > 160) return false;
  if (
    /^(pode |quero |podeis |poderia )?(encerrar|finalizar|concluir)( (a |o )?(conversa|atendimento|chat))?[\s.!?]*$/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /(pode|quero|podeis|poderia).{0,20}(encerrar|finalizar|concluir).{0,30}(conversa|atendimento|chat)?/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /^(era so isso|so isso|e so isso|nao preciso mais|nao preciso de mais nada|pode fechar|pode finalizar)[\s.!?]*$/.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

/** Aluno adia o restante ("deixa à noite", "depois eu mando as dúvidas"). */
export function userDefersUntilLater(userMessage?: string | null): boolean {
  const msg = normalize(userMessage ?? "");
  if (!msg || msg.length > 240) return false;
  if (
    /(deixa|deixo|ficar|fico).{0,24}(pra|para|a)?\s*(noite|tarde|depois|mais tarde)/.test(
      msg,
    )
  ) {
    return true;
  }
  if (/quando (eu )?estiver estudando/.test(msg)) return true;
  if (
    /(envio|mando|te (chamo|falo)|volto).{0,28}(a noite|depois|mais tarde|quando)/.test(
      msg,
    )
  ) {
    return true;
  }
  if (
    /(a noite|depois|mais tarde).{0,28}(envio|mando|te (chamo|falo)|minhas duvidas)/.test(
      msg,
    )
  ) {
    return true;
  }
  return /depois (eu )?(te )?(chamo|falo|volto)/.test(msg);
}

/** Tags retóricas de fim de frase — "tá?", "né?" não são perguntas abertas. */
const RHETORICAL_TAG_RE =
  /\b(ta|tá|né|ne|certo|ok|beleza|combinado|tudo bem|viu)\s*\?/gi;

/** Sobrou pergunta de verdade depois de remover as tags retóricas? */
export function hasOpenQuestion(text?: string | null): boolean {
  const t = (text ?? "").replace(RHETORICAL_TAG_RE, " ");
  return /\?/.test(t);
}

/** Verbo de "voltar a falar" em qualquer flexão usada no WhatsApp. */
const CALL_BACK_VERB = "(cham|fal|procur|avis|volt)(o|ar|arei|arem|amos|a)?";

/**
 * Sinais de que ainda há coisa pendente. Bloqueiam qualquer encerramento
 * automático mesmo que a frase pareça uma despedida
 * (ex.: "se precisar falo com um atendente", "obrigado, mas não consegui").
 */
const PENDING_REQUEST_RE =
  /\b(atendente|consultor|consultora|humano|pessoa real|supervisor|protocolo)\b|nao (consegui|consigo|deu|funciona|funcionou|recebi|recebo|abriu|abre|carrega|aparece|apareceu|chegou|veio|consta|atualizou|liberou|entendi|resolvi|resolveu|resolveram|resolvido|estou|to|esta)|nada (foi )?resolvido|ainda (nao|estou|to|tenho|falta)|continua (dando|com|igual)|\b(erro|problema|bloqueado|bloqueio|pendencia|pendente)\b|me (manda|envia|passa|ajuda|informa)|pode (me )?(mandar|enviar|passar|verificar|conferir|ajudar com)|(?<!nao )\b(preciso|quero|queria|gostaria|solicito)\b/;

function hasPendingRequest(normalized: string): boolean {
  return PENDING_REQUEST_RE.test(normalized);
}

/**
 * Aluno relata que está resolvido, que terceiros já estão tratando ou que
 * não tem dúvida agora. Também é fim de atendimento, mesmo sem
 * agradecimento ("Enviaram já, pediram para aguardar até amanhã").
 */
export function userReportsResolvedOrWaiting(
  userMessage?: string | null,
): boolean {
  const raw = userMessage ?? "";
  if (hasOpenQuestion(raw)) return false;
  const msg = normalize(raw);
  if (!msg || msg.length > 240) return false;
  if (hasPendingRequest(msg)) return false;
  // "Tudo certo!", "tá tudo bem por enquanto" — a frase inteira é isso.
  const bare = msg.replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  if (
    /^(ja )?(esta|ta|to|estou|estamos|tudo|ta tudo|esta tudo) ?(tudo )?(bem|certo|otimo|tranquilo|ok|joia|resolvido)( (por (enquanto|agora)|ate o momento|obrigad[oa]|entao))?$/.test(
      bare,
    )
  ) {
    return true;
  }
  if (/agradec[oe].{0,16}(a )?(aten[cç]ao|ajuda|retorno|resposta)/.test(msg)) {
    return true;
  }
  if (/(estou|to|ja estou|ja to) conseguindo/.test(msg)) return true;
  if (/(ja )?(resolvi|resolvido|resolveram|foi resolvido|estao resolvendo|deu certo|se resolveu)/.test(msg)) {
    return true;
  }
  // Terceiros já estão tratando: "enviaram já, pediram para aguardar até amanhã".
  if (
    /(enviaram|enviei|mandaram|mandei|encaminharam|encaminhei|abriram|abri).{0,48}(aguard|esperar|amanha|prazo|retorno)/.test(
      msg,
    )
  ) {
    return true;
  }
  if (/(pediram|disseram|orientaram|falaram|informaram).{0,24}(aguard|esperar)/.test(msg)) {
    return true;
  }
  if (/(sem|nenhuma|não tenho|nao tenho) (mais )?(duvida|duvidas|questao)/.test(msg)) {
    return true;
  }
  return false;
}

/** Agradecimento que fecha o turno ("muito grata por toda ajuda"). */
export function userThanksAndWrapsUp(userMessage?: string | null): boolean {
  const raw = userMessage ?? "";
  const msg = normalize(raw);
  if (!msg || msg.length > 160) return false;
  if (hasOpenQuestion(raw)) return false;
  if (hasPendingRequest(msg)) return false;
  if (/muito grat[ao]|gratidao/.test(msg)) return true;
  if (/obrigad[oa]s?.{0,24}(por )?(toda|tudo|a ajuda)/.test(msg)) return true;
  if (/valeu.{0,16}(tudo|ajuda|carinho)/.test(msg)) return true;
  // "Tabom! muito obrigada." — agradecimento + interjeição e nada mais.
  // "Obrigado, mas ainda não consegui" NÃO entra: sobra pedido no texto.
  if (msg.length <= 80 && /\b(obrigad[oa]s?|grat[ao]|valeu)\b/.test(msg)) {
    const leftover = msg
      .replace(
        /\b(muito|mto|obrigad[oa]s?|grat[ao]|gratidao|valeu|vlw|ta ?bom|tabom|ok|okay|blz|beleza|certo|show|otimo|perfeito|sim|entendi|mesmo|viu|ta|entao|por (tudo|toda|a) ?(ajuda)?|ajuda|voce|vc|de nada|deus (te )?abencoe|amem|bjs|abraco)\b/g,
        " ",
      )
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .trim();
    if (leftover.length <= 4) return true;
  }
  return false;
}

/** "Se precisar te chamo", "vou seguindo aqui" — aluno fecha por conta. */
export function userSignalsNoFurtherHelp(userMessage?: string | null): boolean {
  const raw = userMessage ?? "";
  const msg = normalize(raw);
  if (!msg || msg.length > 200) return false;
  if (hasOpenQuestion(raw)) return false;
  if (hasPendingRequest(msg)) return false;
  if (new RegExp(`se precisar (eu )?(te )?${CALL_BACK_VERB}`).test(msg)) {
    return true;
  }
  if (
    new RegExp(`qualquer (coisa|duvida).{0,24}(te )?${CALL_BACK_VERB}`).test(msg)
  ) {
    return true;
  }
  // "Pode deixar vou chamar sim", "pode deixar que eu te chamo".
  if (new RegExp(`pode deixar.{0,24}${CALL_BACK_VERB}`).test(msg)) return true;
  if (/(vou|to|estou) (dando continuidade|seguindo|indo)/.test(msg)) return true;
  if (/(consegui|resolvi|deu certo)( tudo| sim)?$/.test(msg)) return true;
  if (/nao precis[oa].{0,24}(mais|nada|no momento|por enquanto)/.test(msg)) {
    return true;
  }
  // "Até o momento está tudo bem", "por enquanto tudo certo".
  if (
    /(ate o momento|por (enquanto|hora)|no momento).{0,20}(tudo (bem|certo|ok)|esta (bem|otimo|tranquilo)|sem duvida)/.test(
      msg,
    )
  ) {
    return true;
  }
  if (/^(ta|esta|tudo) (bem|certo|otimo|tranquilo)( por (enquanto|agora))?$/.test(msg)) {
    return true;
  }
  return false;
}

const AGENT_FAREWELL_RE =
  /(so|só) (chamar|avisar|falar|me chamar)|\b(estou|to|tô|tamo|estarei|sigo) (por )?aqui|conte comigo|pode contar comigo|(a|à) disposi[cç][aã]o|fica (tranquil[ao]|(a|à) vontade)|bons estudos|bom estudo|boa sorte|otim[ao] (dia|tarde|noite)|ótim[ao] (dia|tarde|noite)|(bom dia|boa (tarde|noite)) (pra|para) (voce|você|vc)|tenha (um|uma)|ate (mais|logo|breve)|at[ée] (mais|logo|breve)|sempre que precisar|qualquer (coisa|duvida|dúvida)[,!.\s]/i;

/**
 * A própria resposta do agente é uma despedida (sem pergunta aberta).
 * É o sinal mais confiável de que o atendimento acabou.
 */
export function agentReplyLooksLikeFarewell(replyText?: string | null): boolean {
  const raw = (replyText ?? "").trim();
  if (!raw) return false;
  if (hasOpenQuestion(raw)) return false;
  return AGENT_FAREWELL_RE.test(normalize(raw)) || AGENT_FAREWELL_RE.test(raw);
}

/**
 * Fecha na hora, logo depois de enviar a resposta: exige que o agente
 * tenha se despedido E que o aluno tenha fechado o assunto (agradeceu,
 * adiou, disse que volta a chamar ou relatou que já resolveu).
 *
 * Mais restrito que `attendanceEndedInFarewell` de propósito: aqui a
 * conversa ainda está viva, então não fechamos só porque o aluno mandou
 * uma frase sem pergunta. O worker e a varredura, que só agem após 30 min
 * de silêncio, usam a regra ampla.
 */
export function shouldCloseAfterAgentFarewell(args: {
  userMessage: string;
  replyText: string;
}): boolean {
  if (!agentReplyLooksLikeFarewell(args.replyText)) return false;
  return studentWrappedUp(args.userMessage);
}

export function userThanksOnly(userMessage?: string | null): boolean {
  const msg = normalize(userMessage ?? "")
    .replace(/[!?.…,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!msg || msg.length > 80) return false;
  return /^(muito )?(obrigad[oa]s?|valeu|grat[ao])( (vi|ta|tá|mesmo))?$/.test(
    msg,
  );
}

export function shouldCloseAiAfterStudentMessage(args: {
  userMessage: string;
  recentInbound?: string[];
}): { close: boolean; reason: string } {
  if (userWantsAiConversationClose(args.userMessage)) {
    return { close: true, reason: "explicit" };
  }
  if (userThanksAndWrapsUp(args.userMessage)) {
    return { close: true, reason: "thanks_wrapup" };
  }
  const recent = (args.recentInbound ?? []).join("\n");
  const deferred =
    userDefersUntilLater(args.userMessage) || userDefersUntilLater(recent);
  if (userThanksOnly(args.userMessage) && deferred) {
    return { close: true, reason: "thanks_after_defer" };
  }
  return { close: false, reason: "" };
}

/**
 * Aluno fechou o assunto: agradeceu, adiou, disse que volta a chamar ou
 * pediu para encerrar — e não deixou pergunta aberta.
 */
export function studentWrappedUp(userMessage?: string | null): boolean {
  const text = (userMessage ?? "").trim();
  if (!text || hasOpenQuestion(text)) return false;
  if (hasPendingRequest(normalize(text))) return false;
  return (
    shouldCloseAiAfterStudentMessage({ userMessage: text }).close ||
    userSignalsNoFurtherHelp(text) ||
    userDefersUntilLater(text) ||
    userReportsResolvedOrWaiting(text) ||
    userWantsAiConversationClose(text)
  );
}

/**
 * Atendimento acabou: o agente se despediu / ficou em stand-by e o aluno
 * não deixou nada em aberto. Não exige agradecimento — o aluno pode ter
 * só relatado que resolveu ("Enviaram já, pediram para aguardar amanhã").
 *
 * A pergunta pode estar na fala do AGENTE ("Quer que eu faça isso?"): só
 * olhamos a última mensagem do ALUNO para decidir se sobrou pendência.
 *
 * Usado pelo inbox, pelo worker de inatividade (encerra em vez de mandar
 * "ainda posso te ajudar?") e pela varredura da fila.
 */
export function attendanceEndedInFarewell(args: {
  lastAgentText?: string | null;
  lastStudentText?: string | null;
}): boolean {
  if (!agentReplyLooksLikeFarewell(args.lastAgentText)) return false;
  const student = (args.lastStudentText ?? "").trim();
  // Aluno nunca falou: pode ser disparo de campanha sem resposta.
  if (!student) return false;
  if (hasOpenQuestion(student)) return false;
  return !hasPendingRequest(normalize(student));
}

export async function closeAiOnlyConversation(args: {
  conversationId: string;
  contactId?: string | null;
  reason?: string;
  /** Agradecimento conclusivo com a IA ainda responsável — fecha mesmo se um humano falou antes. */
  allowAfterHumanReply?: boolean;
}): Promise<{ closed: boolean; reason: string }> {
  const conv = await prisma.conversation.findUnique({
    where: { id: args.conversationId },
    select: {
      id: true,
      status: true,
      contactId: true,
      departmentId: true,
      hasHumanReply: true,
      assignedToId: true,
      organizationId: true,
      externalId: true,
      assignedTo: { select: { type: true } },
    },
  });
  if (!conv) return { closed: false, reason: "NOT_FOUND" };
  if (conv.status === "RESOLVED") {
    return { closed: false, reason: "ALREADY_CLOSED" };
  }
  // Somente atendimento da IA — se humano já respondeu, não encerra
  // (salvo wrap-up natural: aluno agradeceu e a IA ainda é a responsável).
  if (conv.hasHumanReply && !args.allowAfterHumanReply) {
    return { closed: false, reason: "HAS_HUMAN_REPLY" };
  }
  if (conv.assignedTo?.type !== "AI") {
    return { closed: false, reason: "NOT_AI_ASSIGNEE" };
  }

  const contactId = args.contactId ?? conv.contactId;

  await prisma.distributionPending
    .updateMany({
      where: {
        status: "PENDING",
        OR: [
          { conversationId: conv.id },
          ...(contactId ? [{ contactId }] : []),
        ],
      },
      data: { status: "CANCELLED" },
    })
    .catch(() => 0);

  const [keepAgent, keepDepartment] = await Promise.all([
    getOrgSettingBool("conversation.keepAgentOnEnd", false),
    getOrgSettingBool("conversation.keepDepartmentOnEnd", false),
  ]);

  // Tabulação padrão do departamento para encerramento automático. Sem ela
  // a IA fecha sem tabular (comportamento anterior) — nunca bloqueia.
  const autoTab = await resolveAutoCloseTabulation({
    organizationId: conv.organizationId,
    departmentId: conv.departmentId,
  }).catch(() => null);

  const updated = await updateConversationStatusInDb(conv.id, "RESOLVED", {
    ...(autoTab ? { tabulationId: autoTab.tabulationId } : {}),
    clearAssignedTo: !keepAgent,
    clearDepartment: !keepDepartment,
  });

  await logEvent({
    type: "CONVERSATION_CLOSED",
    entityType: "CONVERSATION",
    entityId: conv.id,
    entityLabel: updated.externalId ?? null,
    conversationId: conv.id,
    contactId,
    field: "status",
    oldValue: conv.status,
    newValue: "RESOLVED",
    meta: {
      action: "ai_close",
      source: "AI_AGENT",
      reason: args.reason ?? null,
    },
  }).catch(() => null);

  if (autoTab) {
    await logEvent({
      type: "CONVERSATION_TABULATED",
      entityType: "CONVERSATION",
      entityId: conv.id,
      entityLabel: updated.externalId ?? null,
      conversationId: conv.id,
      contactId,
      meta: tabulationLogMeta(
        {
          tabulationId: autoTab.tabulationId,
          ancestorIds: autoTab.ancestorIds,
          departmentId: conv.departmentId,
          name: autoTab.name,
          number: autoTab.number,
        },
        { source: "AI_AGENT", auto: true },
      ),
    }).catch(() => null);
  }

  try {
    sseBus.publish("conversation_timeline_updated", {
      organizationId: conv.organizationId,
      conversationId: conv.id,
      type: "CONVERSATION_CLOSED",
    });
  } catch {
    /* best-effort */
  }

  let dealId: string | undefined;
  if (contactId) {
    const deal = await prisma.deal.findFirst({
      where: { contactId, status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    dealId = deal?.id;
  }

  await fireTrigger("conversation_tabulated", {
    contactId: contactId ?? undefined,
    dealId,
    data: {
      tabulationId: autoTab?.tabulationId ?? null,
      ancestorIds: autoTab?.ancestorIds ?? [],
      departmentId: conv.departmentId,
      conversationId: conv.id,
      source: "AI_AGENT",
      reason: args.reason ?? null,
    },
  }).catch(() => null);

  return { closed: true, reason: "CLOSED" };
}
