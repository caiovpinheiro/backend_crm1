/**
 * Fila de espera da Distribuição.
 *
 * A fila reflete os ATENDIMENTOS da aba "Entrada" que ainda estão SEM
 * responsável (conversa aberta, sem `assignedToId`). Deriva do mesmo
 * critério da aba Entrada do inbox. A drenagem automática passa por
 * `processPendingDistributionQueue` (gatilhos: novo item, agente online,
 * elegibilidade, capacidade liberada, botão manual; cron só se a última
 * passagem não foi vazia).
 */
export {
  ABERTA_SEM_RESPONSAVEL,
  getPendingDistributions,
  getWaitingQueueWhere,
  isDistributionAutoOnInbound,
  isFruitlessCooldownActive,
  isFruitlessCooldownActiveAsync,
  type PendingDistributionView,
  type PendingDistributionsPage,
  type PendingQueueTrigger,
  type RetryResult,
} from "./pending-shared";
export {
  maybeDistributeNewInboundTicket,
  purgeUnansweredFromPendingQueue,
} from "./pending-inbound";
export {
  enqueueProcessPendingOrRun,
  processPendingDistributionQueue,
  retryPendingDistributions,
  scheduleProcessPendingDistributionQueue,
} from "./pending-drain";
