/**
 * Inbound / cleanup da fila de espera (pending).
 */
import { debugInfo, debugWarn } from "@/lib/debug-log";
import { activeInboxQueueGuardWhere } from "@/lib/inbox-queue-membership";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { hasOrganizationWidget } from "@/services/organization-widgets";
import { isAiAttendanceEnabled } from "@/services/ai/attendance-gate";
import { tryAssignFirstAttendanceAi } from "@/services/ai/first-attendance";
import { isHumanAttendanceWindowOpen } from "@/services/ai/human-queue-policy";
import { isRetiredWhatsAppChannel } from "@/lib/channels/retired-whatsapp";
import {
  clearOwnershipForRedistribution,
  isAssigneeCurrentlyEligible,
  shouldClearOwnershipOnIneligible,
  shouldKeepAssigneeInAttendance,
} from "@/services/distribution/assignee-eligibility";
import { humanWasAssignedInThisConversation } from "@/services/distribution/human-assignment-history";
import { keepHumanAfterAutomationClose } from "@/services/distribution/return-after-close";

import { executeDistribution } from "./engine";
import { isDistributionEnabled } from "./enabled";
import { ensureConversationInWaitingQueue } from "./pending-shared";

/**
 * Marca como RESOLVED as pendências cuja conversa NÃO precisa mais ser
 * distribuída. Continua ativa quando:
 *
 *   - OPEN sem responsável (`ABERTA_SEM_RESPONSAVEL` / assignedToId null), OU
 *   - OPEN ainda com **IA** (handoff noturno: `NO_ELIGIBLE_RESPONSIBLE` →
 *     enfileira + IA reassumiu para continuar falando; a fila deve drenar
 *     quando um humano ficar elegível — ver `pendingOwnedByAi` abaixo).
 *
 * Resolve (cleanup) quando:
 *
 *   - Conversa encerrada (status != OPEN)
 *   - Conversa OPEN já com **humano** (distribuída por outro caminho)
 *   - Conversa deletada
 *
 * Bug histórico (ago/2026): tratar qualquer assignee ≠ null como órfã
 * cancelava a fila no mesmo segundo em que a IA reassumia → centenas de
 * alunos ficavam na aba Automação “para sempre” após expediente.
 *
 * `resolvedUserId=null` marca que foi cleanup, não distribuição real.
 */
export async function cancelStalePendingOrphans(orgId: string): Promise<number> {
  const stale = await prisma.distributionPending.findMany({
    where: {
      organizationId: orgId,
      status: "PENDING",
      conversationId: { not: null },
    },
    select: { id: true, conversationId: true, triggerSource: true },
  });
  if (stale.length === 0) return 0;

  const convIds = stale
    .map((p) => p.conversationId)
    .filter((id): id is string => Boolean(id));

  const stillActive = await prisma.conversation.findMany({
    where: {
      id: { in: convIds },
      ...activeInboxQueueGuardWhere(),
      OR: [
        { assignedToId: null },
        // Handoff fora do expediente: IA segura o chat até haver elegível.
        { assignedTo: { type: "AI" } },
      ],
    },
    select: { id: true },
  });
  const activeSet = new Set(stillActive.map((c) => c.id));

  const toResolve = stale
    .filter((p) => {
      if (!p.conversationId || !activeSet.has(p.conversationId)) return true;
      return false;
    })
    .map((p) => p.id);
  if (toResolve.length === 0) return 0;

  const res = await prisma.distributionPending.updateMany({
    where: { id: { in: toResolve } },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });
  return res.count;
}

/**
 * Remove da fila de espera (lista + DistributionPending) conversas OPEN sem
 * responsável em que o aluno nunca respondeu — tipicamente calouros que só
 * receberam template de bem-vindo. Chamada no GET da fila para limpar o
 * dashboard imediatamente, sem depender do cron de drenagem.
 */
export async function purgeUnansweredFromPendingQueue(): Promise<number> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return 0;

  const unanswered = await prisma.conversation.findMany({
    where: {
      ...activeInboxQueueGuardWhere(),
      assignedToId: null,
      lastInboundAt: null,
    },
    select: { id: true, contactId: true },
    take: 2000,
  });
  if (unanswered.length === 0) return 0;

  const convIds = unanswered.map((c) => c.id);
  const contactIds = unanswered
    .map((c) => c.contactId)
    .filter((id): id is string => Boolean(id));

  // Não purga redistribuição MANUAL — operador mandou p/ fila de propósito.
  const res = await prisma.distributionPending.updateMany({
    where: {
      organizationId: orgId,
      status: "PENDING",
      NOT: { triggerSource: "MANUAL" },
      OR: [
        { conversationId: { in: convIds } },
        ...(contactIds.length > 0
          ? [{ contactId: { in: contactIds }, conversationId: null }]
          : []),
      ],
    },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });

  if (res.count > 0) {
    debugInfo(
      "[distribution] purgeUnansweredFromPendingQueue",
      () => JSON.stringify({ orgId, conversations: unanswered.length, resolved: res.count }),
    );
  }
  return res.count;
}

/**
 * Inbound do aluno (ticket novo OU conversa OPEN reusada): tenta
 * atribuir um consultor elegível; sem elegíveis, entra na fila de espera.
 *
 * Com o kill-switch de IA, o 1º atendimento não assume — o card não
 * fica em Agente IA. Remapeia `distribution_pending` órfãs para o
 * conversationId atual.
 *
 * Nunca propaga erro ao webhook — falha só loga.
 */
export async function maybeDistributeNewInboundTicket(input: {
  conversationId: string;
  contactId: string;
  assignedToId?: string | null;
}): Promise<void> {
  const retiredConv = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      channelRef: { select: { name: true, phoneNumber: true, config: true } },
    },
  });
  if (isRetiredWhatsAppChannel(retiredConv?.channelRef)) {
    await prisma.distributionPending.updateMany({
      where: { conversationId: input.conversationId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    return;
  }

  // #region agent log
  debugWarn(
    "[DBG-e46688 maybeDist] entry",
    () => JSON.stringify({
      convId: input.conversationId,
      contactId: input.contactId,
      alreadyAssigned: !!input.assignedToId,
    }),
  );
  // #endregion

  // Automação encerrou e o aluno voltou: o consultor anterior continua.
  // Sem isso o 1º atendimento da IA tira o humano e ninguém responde.
  try {
    const keptHumanId = await keepHumanAfterAutomationClose({
      conversationId: input.conversationId,
      contactId: input.contactId,
    });
    if (keptHumanId) {
      debugWarn(
        "[DBG-e46688 maybeDist] keep_human_after_automation_close",
        () => JSON.stringify({
          convId: input.conversationId,
          humanUserId: keptHumanId,
        }),
      );
      return;
    }
  } catch (e) {
    console.error("[distribution] keepHumanAfterAutomationClose failed", e);
  }

  // Herança de contato/deal NÃO pode burlar elegibilidade: offline /
  // indisponível / fora do expediente devem cair na redistribuição (ou IA).
  let assignee = input.assignedToId ?? null;
  if (assignee) {
    const check = await isAssigneeCurrentlyEligible(assignee);
    // AI owner: keep only while the attendance kill-switch allows it.
    if (check.isAi) {
      if (!(await isAiAttendanceEnabled())) {
        debugWarn(
          "[DBG-e46688 maybeDist] drop_ai_assignee_kill_switch",
          () => JSON.stringify({ convId: input.conversationId, assignee }),
        );
        try {
          await clearOwnershipForRedistribution({
            conversationId: input.conversationId,
            contactId: input.contactId,
          });
        } catch (e) {
          console.error(
            "[distribution] clearOwnershipForRedistribution failed",
            e,
          );
          return;
        }
        assignee = null;
      } else {
        debugWarn(
          "[DBG-e46688 maybeDist] keep_ai_assignee",
          () => JSON.stringify({ convId: input.conversationId, assignee }),
        );
        // Fora do expediente a IA pode falar, mas o lead entra na espera
        // para distribuir quando o primeiro consultor ficar elegível.
        if (!isHumanAttendanceWindowOpen()) {
          await ensureConversationInWaitingQueue({
            conversationId: input.conversationId,
            contactId: input.contactId,
            triggerSource: "SYSTEM",
          }).catch(() => null);
        }
        return;
      }
    }
    // Kill-switch soltou a IA: assignee=null → 1º atendimento (no-op) + fila humana.
    if (assignee) {
    const conv = !check.isAi
      ? await prisma.conversation.findUnique({
          where: { id: input.conversationId },
          select: { hasHumanReply: true },
        })
      : null;
    // Almoço / offline / pausa não roubam conversa já respondida
    // (09/set/26 #359447 — "Ótimo" redistribuía no inbound).
    if (
      shouldKeepAssigneeInAttendance({
        departmentScoped: false,
        eligibleInDepartment: check.eligible,
        eligibleOutsideDepartment: check.eligible,
        hasHumanReply: Boolean(conv?.hasHumanReply),
        isAi: check.isAi,
      })
    ) {
      debugWarn(
        "[DBG-e46688 maybeDist] keep_human_in_attendance",
        () => JSON.stringify({
          convId: input.conversationId,
          assignee,
          reason: check.reason ?? null,
        }),
      );
      return;
    }
    // Fila cheia não solta o responsável: o teto barra lead NOVO, e este
    // contato já é dele. Sem reply, offline / fora do expediente liberam.
    const keepHumanAssignee =
      check.eligible ||
      !shouldClearOwnershipOnIneligible(check.reason, check.blockedReasons);
    if (keepHumanAssignee) {
      // IA herdada: mantém. Humano elegível sem reply nesta conversa:
      // libera p/ 1º atendimento IA (substitui INICIO-PIPE).
      if (!check.isAi) {
        // Herança de ticket antigo pode ir para a IA; quem foi atribuído
        // NESTA conversa fica (a saudação da distribuição sai como bot e
        // não marca `hasHumanReply` — não é sinal de "humano não atendeu").
        if (
          !conv?.hasHumanReply &&
          (await humanWasAssignedInThisConversation(
            input.conversationId,
            assignee,
          ))
        ) {
          debugWarn(
            "[DBG-e46688 maybeDist] keep_assigned_human",
            () => JSON.stringify({ convId: input.conversationId, assignee }),
          );
          return;
        }
        if (!conv?.hasHumanReply) {
          debugWarn(
            "[DBG-e46688 maybeDist] release_human_for_first_attendance",
            () => JSON.stringify({
              convId: input.conversationId,
              assignee,
            }),
          );
          try {
            await clearOwnershipForRedistribution({
              conversationId: input.conversationId,
              contactId: input.contactId,
            });
          } catch (e) {
            console.error(
              "[distribution] clearOwnershipForRedistribution failed",
              e,
            );
            return;
          }
          assignee = null;
        } else {
          debugWarn(
            "[DBG-e46688 maybeDist] keep_eligible_assignee",
            () => JSON.stringify({
              convId: input.conversationId,
              assignee,
              isAi: check.isAi,
            }),
          );
          return;
        }
      } else {
        debugWarn(
          "[DBG-e46688 maybeDist] keep_eligible_assignee",
          () => JSON.stringify({
            convId: input.conversationId,
            assignee,
            isAi: check.isAi,
          }),
        );
        return;
      }
    } else {
      debugWarn(
        "[DBG-e46688 maybeDist] clear_ineligible_assignee",
        () => JSON.stringify({
          convId: input.conversationId,
          assignee,
          reason: check.reason,
        }),
      );
      try {
        await clearOwnershipForRedistribution({
          conversationId: input.conversationId,
          contactId: input.contactId,
        });
      } catch (e) {
        console.error(
          "[distribution] clearOwnershipForRedistribution failed",
          e,
        );
        return;
      }
        assignee = null;
    }
    }
  }

  // 1º atendimento: Agente IA (se houver ativo) assume antes da fila humana.
  try {
    const aiUserId = await tryAssignFirstAttendanceAi({
      conversationId: input.conversationId,
      contactId: input.contactId,
      assignedToId: assignee,
    });
    if (aiUserId) {
      debugWarn(
        "[DBG-e46688 maybeDist] first_attendance_ai",
        () => JSON.stringify({
          convId: input.conversationId,
          aiUserId,
        }),
      );
      if (!isHumanAttendanceWindowOpen()) {
        await ensureConversationInWaitingQueue({
          conversationId: input.conversationId,
          contactId: input.contactId,
          triggerSource: "SYSTEM",
        }).catch(() => null);
      }
      return;
    }
  } catch (e) {
    console.error("[ai] tryAssignFirstAttendanceAi failed", e);
  }

  try {
    const widgetActive = await hasOrganizationWidget("smart_distribution");
    // #region agent log
    debugWarn(
      "[DBG-e46688 maybeDist] widget check",
      () => JSON.stringify({ widgetActive, convId: input.conversationId }),
    );
    // #endregion
    if (!widgetActive) {
      // IA off e sem widget: ainda assim o aluno não pode ficar sem fila.
      if (!(await isAiAttendanceEnabled())) {
        await ensureConversationInWaitingQueue({
          conversationId: input.conversationId,
          contactId: input.contactId,
          triggerSource: "SYSTEM",
        });
      }
      return;
    }

    if (!(await isDistributionEnabled())) {
      debugWarn(
        "[DBG-e46688 maybeDist] distribution_disabled",
        () => JSON.stringify({ convId: input.conversationId }),
      );
      return;
    }

    // Sempre tenta distribuir / enfileirar inbound sem dono. O flag
    // autoOnInbound=false prendia o aluno em Entrada até alguém clicar.

    const remapped = await prisma.distributionPending.updateMany({
      where: { status: "PENDING", contactId: input.contactId },
      data: {
        conversationId: input.conversationId,
        lastAttemptAt: new Date(),
      },
    });

    const convDept = await prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { departmentId: true },
    });

    const result = await executeDistribution({
      dealId: null,
      contactId: input.contactId,
      conversationId: input.conversationId,
      distributionType: null,
      triggerSource: "SYSTEM",
      departmentId: convDept?.departmentId ?? null,
      // Fronteira de departamento ESTRITA: quando o lead foi roteado a um
      // departamento (ex.: handoff acadêmico), ele só é distribuído a quem
      // estiver disponível NAQUELE depto — se ninguém, espera na fila do depto
      // (nunca vai para outro). Leads SEM departamento já nascem org-wide
      // (departmentScoped=false), então não ficam presos.
      allowOrgWideFallback: false,
    });
    // #region agent log
    debugWarn(
      "[DBG-e46688 maybeDist] result",
      () => JSON.stringify({
        convId: input.conversationId,
        remappedPending: remapped.count,
        success: result.success,
        reason: result.reason,
        selectedUserId: result.selectedUserId,
      }),
    );
    // #endregion

    // Sem elegíveis: deixa na fila e NÃO dispara retry em loop.
    // Drena só quando consultor ficar disponível / cron / manual.
  } catch (e) {
    console.error("[distribution] maybeDistributeNewInboundTicket failed", e);
    // #region agent log
    debugWarn(
      "[DBG-e46688 maybeDist] threw",
      () => JSON.stringify({
        convId: input.conversationId,
        err: e instanceof Error ? e.message : String(e),
      }),
    );
    // #endregion
  }
}
