/**
 * Ponto de entrada do motor de Distribuição Inteligente. Centraliza os
 * re-exports e o gate de widget para os consumidores (rotas, automação,
 * fluxo real).
 */

export {
  assertSmartDistributionEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

export {
  evaluateResponsibleEligibility,
  isWithinWorkingHours,
  isInPreLunchOrLunchWindow,
  type DistributionBlockReason,
  type EligibilityContext,
  type EligibilityResult,
  type ResponsibleEligibilityInput,
  type ScheduleLike,
} from "./eligibility";

export { getQueueCounts } from "./queue";

export {
  getDistributionResponsibles,
  type DistributionResponsibleView,
  type GetResponsiblesOptions,
} from "./responsibles";

export {
  executeDistribution,
  simulateDistribution,
  selectResponsible,
  type DistributionResult,
  type DistributionReason,
  type DistributionTriggerSource,
  type EvaluatedResponsibleSummary,
  type ExecuteDistributionInput,
} from "./engine";

export {
  ABERTA_SEM_RESPONSAVEL,
  getPendingDistributions,
  getWaitingQueueWhere,
  isDistributionAutoOnInbound,
  purgeUnansweredFromPendingQueue,
  retryPendingDistributions,
  processPendingDistributionQueue,
  scheduleProcessPendingDistributionQueue,
  maybeDistributeNewInboundTicket,
  type PendingDistributionView,
  type PendingDistributionsPage,
  type RetryResult,
  type PendingQueueTrigger,
} from "./pending";

export {
  getDistributionLogs,
  getDistributionDepartmentStats,
  type DistributionLogView,
  type DepartmentDistributionStat,
} from "./logs";

export {
  redistributeResponsibleQueue,
  type RedistributeInput,
  type RedistributeMode,
  type RedistributeQueueScope,
  type RedistributeResult,
} from "./redistribute";
