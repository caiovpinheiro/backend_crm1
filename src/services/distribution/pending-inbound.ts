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

  debugWarn(
    "[DBG-e46688 maybeDist] entry",
    () => JSON.stringify({
      convId: input.conversationId,
      contactId: input.contactId,
      alreadyAssigned: !!input.assignedToId,
    }),
  );

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

  let assignee = input.assignedToId ?? null;
  if (assignee) {
    const check = await isAssigneeCurrentlyEligible(assignee);
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
    if (assignee) {
    const conv = !check.isAi
      ? await prisma.conversation.findUnique({
          where: { id: input.conversationId },
          select: { hasHumanReply: true },
        })
      : null;
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
    const keepHumanAssignee =
      check.eligible ||
      !shouldClearOwnershipOnIneligible(check.reason, check.blockedReasons);
    if (keepHumanAssignee) {
      if (!check.isAi) {
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
    debugWarn(
      "[DBG-e46688 maybeDist] widget check",
      () => JSON.stringify({ widgetActive, convId: input.conversationId }),
    );
    if (!widgetActive) {
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
      allowOrgWideFallback: false,
    });
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
  } catch (e) {
    console.error("[distribution] maybeDistributeNewInboundTicket failed", e);
    debugWarn(
      "[DBG-e46688 maybeDist] threw",
      () => JSON.stringify({
        convId: input.conversationId,
        err: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}
