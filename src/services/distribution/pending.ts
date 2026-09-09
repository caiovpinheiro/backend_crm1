/**
 * Fila de espera da Distribuição.
 *
 * A fila reflete os ATENDIMENTOS da aba "Entrada" que ainda estão SEM
 * responsável (conversa aberta, sem `assignedToId`). Deriva do mesmo
 * critério da aba Entrada do inbox. A drenagem automática passa por
 * `processPendingDistributionQueue` (gatilhos: novo item, agente online,
 * elegibilidade, capacidade liberada, botão manual; cron só se a última
 * passagem não foi vazia).
 * Na API o scan não roda in-process: `enqueueProcessPendingOrRun`
 * só empurra `distribution-drain` (sem COUNT / queueLimit). O worker
 * confere o teto em `capacity_released` e drena. Fallback síncrono
 * só em test/dev se Redis estiver down.
 * A drenagem é **por departamento** (FIFO + capacidade). Quem fica
 * elegível abre a fila dos seus depts; o reprocesso manual/cron também
 * tenta os depts que já têm gente na espera — o motor decide se o
 * pool é o depto ou org-wide (`respectDepartment`).
 *
 * Import unidirecional: pending → engine (evita ciclo de import).
 * O engine agenda drenagem via import dinâmico.
 */

import { Prisma } from "@prisma/client";

import {
  allowInlineDistributionFallback,
  enqueueDistributionDrain,
  isFreshDrainEnqueue,
} from "@/lib/distribution-drain-queue";
import { metrics } from "@/lib/metrics";
import { debugInfo, debugWarn } from "@/lib/debug-log";
import { getOrgSettingBool } from "@/lib/org-settings";
import { activeInboxQueueGuardWhere } from "@/lib/inbox-queue-membership";
import { prisma } from "@/lib/prisma";
import {
  getOrgIdOrNull,
  runWithContext,
} from "@/lib/request-context";
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
import { evaluateCapacityReleasedDrain } from "./capacity-released-gate";
import {
  CAPACITY_RELEASED_COOLDOWN_MS,
  fruitlessCooldownIsArmed,
  fruitlessPassNeedsCooldown,
  shouldScheduleRetryOnCooldownSkip,
  shouldSkipCapacityReleasedCooldown,
  shouldSkipCapacityReleasedFruitlessCooldown,
  shouldSkipScheduledFruitlessCooldown,
  triggerClearsFruitlessCooldown,
} from "./pending-drain-guard";
import {
  clearPublishedFruitlessCooldown,
  peekPublishedFruitlessCooldown,
  publishFruitlessCooldown,
} from "./pending-drain-store";
import {
  getDistributionResponsibles,
  type DistributionResponsibleView,
} from "./responsibles";
