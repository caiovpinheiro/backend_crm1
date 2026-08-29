import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";

import { debugInfo } from "@/lib/debug-log";

export const AUTOMATION_JOBS_QUEUE_NAME = "automation-jobs" as const;
export const BAILEYS_OUTBOUND_QUEUE_NAME = "baileys-outbound" as const;
export const BAILEYS_CONTROL_QUEUE_NAME = "baileys-control" as const;
export const CAMPAIGN_DISPATCH_QUEUE_NAME = "campaign-dispatch" as const;
export const CAMPAIGN_SEND_QUEUE_NAME = "campaign-send" as const;
/**
 * Fila de processamento de webhooks Meta (WhatsApp Cloud API).
 * A API valida assinatura + persiste `MetaWebhookEvent` + enfileira;
 * o `worker-meta-webhook` consome e executa o handler pesado fora do
 * processo HTTP do inbox (evita storm de status de campanha na API).
 */
export const META_WEBHOOK_QUEUE_NAME = "meta-webhook-events" as const;
/**
 * Remux WebM/Opus → Ogg/Opus + envio Cloud API de áudio do inbox.
 * A API (`APP_MODE=api`) só persiste o arquivo original e cria a
 * mensagem `pending`; o `worker-whatsapp` (campaign-worker) consome.
 */
export const META_ATTACH_QUEUE_NAME = "meta-attach" as const;
/**
 * Fila de operações em massa sobre Deals (bulk update de custom fields,
 * bulk move de stage). Foi nomeada `leads-bulk` (não `deals-bulk`) por
 * convenção de produto — no falar do usuário do CRM "lead" e "deal" se
 * misturam — mas o escopo atual é estritamente Deals/cards do funil.
 *
 * Worker que consome: `src/workers/leads-worker.ts`.
 */
export const LEADS_BULK_QUEUE_NAME = "leads-bulk" as const;

/**
 * Fila de ETL de importação (arquivos CSV/XLSX). O produtor (rota
 * /api/contacts/import) salva o arquivo no bucket `imports` do storage
 * compartilhado e enfileira o job; o `etl-worker` lê o arquivo via
 * `readStoredFile` e processa linha a linha, atualizando o `BulkOperation`.
 */
export const IMPORT_ETL_QUEUE_NAME = "import-etl" as const;

/** Nomes de job da fila `import-etl`. */
export const IMPORT_ETL_JOB_NAMES = {
  contactImport: "contact-import",
  dealImport: "deal-import",
} as const;
export type ImportEtlJobName =
  (typeof IMPORT_ETL_JOB_NAMES)[keyof typeof IMPORT_ETL_JOB_NAMES];

const AUTOMATION_JOB_NAME = "run" as const;

/** Nomes de job da fila `leads-bulk`. */
export const LEADS_BULK_JOB_NAMES = {
  bulkUpdateFields: "bulk-update-fields",
  bulkMoveStage: "bulk-move-stage",
  bulkResolveConversations: "bulk-resolve-conversations",
  bulkAssignConversations: "bulk-assign-conversations",
} as const;
export type LeadsBulkJobName =
  (typeof LEADS_BULK_JOB_NAMES)[keyof typeof LEADS_BULK_JOB_NAMES];

export type AutomationJobContext = {
  contactId?: string;
  dealId?: string;
  event: string;
  data?: unknown;
  /**
   * Profundidade de encadeamento (anti-loop). 0 = disparo de origem
   * (kanban, rota, botão, IA). Cada vez que uma automação, ao rodar,
   * dispara outro gatilho como efeito (ex.: passo "mover etapa" →
   * stage_changed), o novo job herda `depth+1`. `notifyDealStageChanged`
   * corta o encadeamento acima de um teto pra evitar loops A→B→A.
   */
  depth?: number;
};

export type AutomationJobPayload = {
  automationId: string;
  context: AutomationJobContext;
  /** Tentativas já feitas no BullMQ (0 = primeira). Usado pra não reenviar WhatsApp no retry. */
  attemptsMade?: number;
  /**
   * Tenant do job. Opcional no produtor: o admission control de justiça
   * (`lib/automation-fairness.ts`) resolve e carimba via lookup cacheado por
   * automationId quando ausente. O worker usa para liberar o slot da org.
   */
  organizationId?: string;
};

export type BaileysOutboundPayload = {
  channelId: string;
  to: string;
  content: string;
  mediaUrl?: string;
  replyTo?: string;
  messageType: string;
  conversationId: string;
  messageId: string;
};

export type BaileysControlPayload = {
  channelId: string;
  action: "connect" | "disconnect" | "logout";
};

export type CampaignDispatchPayload = {
  campaignId: string;
  // Cursor keyset (contact.id) da última fatia processada. Ausente = primeira
  // fatia. Permite ao dispatch fatiar a campanha e se re-enfileirar, cedendo o
  // slot para outras campanhas intercalarem em vez de enfileirar tudo de uma vez.
  cursor?: string;
};

export type CampaignSendPayload = {
  campaignId: string;
  recipientId: string;
  contactId: string;
  contactPhone: string;
  contactBsuid?: string;
  /** ISO do último inbound do contato no canal da campanha, lido no claim do
   * rodízio (prefetch da janela 24h). Ausente/null no caminho FIFO ou sem
   * inbound no claim — o check de janela então consulta ao vivo. */
  lastInboundAt?: string | null;
};

export type MetaWebhookJobPayload = {
  /** ID do registro MetaWebhookEvent (fonte da verdade do payload). */
  metaWebhookEventId: string;
  /** Tenant — evita query extra no worker antes de withSystemContext. */
  organizationId: string;
};

/** Job de remux + envio Meta de anexo de áudio (inbox). */
export type MetaAttachPayload = {
  conversationId: string;
  /** Message.id persistido pela API (anexo = mensagem com mediaUrl). */
  messageId: string;
  organizationId: string;
  /** Nome original do arquivo (extensão / fallback de documento). */
  originalName: string;
  mime: string;
  caption: string;
};

// ── Leads bulk payloads ──────────────────────────────────
//
// Todos os jobs da fila `leads-bulk` referenciam um `BulkOperation` no
// Postgres pelo `operationId`. O Postgres é a fonte da verdade do progresso;
// o payload do BullMQ carrega apenas o que o handler precisa para processar
// (organizationId para multi-tenant, IDs dos deals, parâmetros da ação).
//
// A duplicação `organizationId` (também presente no BulkOperation) é
// proposital: evita uma query extra no worker antes de chamar
// `withSystemContext`, e funciona como defesa em profundidade caso o
// registro do BulkOperation desapareça (cascade delete da Organization).

type LeadsBulkBasePayload = {
  /** ID do registro `BulkOperation` que rastreia esse job no Postgres. */
  operationId: string;
  /** Tenant — também usado pelo worker para `withSystemContext`. */
  organizationId: string;
  /** User que iniciou a operação (audit). Null = origem sistema/automação. */
  initiatedByUserId: string | null;
};

/** Par (customFieldId, value) aplicado via upsert. */
export type BulkFieldValue = { fieldId: string; value: string };

/**
 * Campos NATIVOS do Deal a sobrescrever em massa. Apenas chaves presentes
 * são aplicadas (skip-empty já resolvido no produtor/rota). `value` é string
 * numérica (Decimal); `expectedClose` é ISO date ou null para limpar.
 */
export type BulkDealNativePatch = {
  title?: string;
  value?: string;
  expectedClose?: string | null;
};

/**
 * Campos NATIVOS do Contato vinculado a sobrescrever em massa. Aplicados ao
 * `contactId` de cada deal (contatos compartilhados recebem o mesmo valor —
 * idempotente). Nenhum desses é `@unique` no schema atual, então bulk-set do
 * mesmo valor não viola constraint.
 */
export type BulkContactNativePatch = {
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
};

export type BulkUpdateFieldsPayload = LeadsBulkBasePayload & {
  /** IDs dos deals a atualizar (validados como pertencentes à org no handler). */
  dealIds: string[];
  /** Custom fields de DEAL a aplicar via upsert em cada deal (compat histórico). */
  updates: BulkFieldValue[];
  /** Custom fields de CONTATO a aplicar no contato vinculado de cada deal. */
  contactCustom?: BulkFieldValue[];
  /** Campos nativos do Deal a sobrescrever (opcional). */
  dealNative?: BulkDealNativePatch;
  /** Campos nativos do Contato vinculado a sobrescrever (opcional). */
  contactNative?: BulkContactNativePatch;
  /** Tags a adicionar no Deal (idempotente). IDs já resolvidos/criados na rota. */
  tagIds?: string[];
};

export type BulkMoveStagePayload = LeadsBulkBasePayload & {
  /** IDs dos deals a mover. */
  dealIds: string[];
  /** Stage de destino (validada no handler como pertencente à org). */
  targetStageId: string;
  /** Motivo da perda — usado quando o destino é o estágio Perdido. */
  lostReason?: string | null;
};

/**
 * Encerramento (resolve) em massa de conversas do inbox.
 *
 * A rota `POST /api/conversations/bulk` já aplicou o filtro de visibilidade,
 * removeu os ids de departamentos que exigem tabulação ao encerrar (`skipped`)
 * quando o operador não é ADMIN, e leu as org settings — o handler recebe
 * apenas ids efetivos + flags saneadas e roda o `updateMany` em chunks
 * (sem reler settings fora de RequestContext).
 */
export type BulkResolveConversationsPayload = LeadsBulkBasePayload & {
  /** IDs das conversas a encerrar (já filtradas por visibilidade + tabulação). */
  conversationIds: string[];
  /** Manter atendente vinculado ao encerrar (org setting `conversation.keepAgentOnEnd`). */
  keepAgent: boolean;
  /** Manter departamento vinculado ao encerrar (`conversation.keepDepartmentOnEnd`). */
  keepDepartment: boolean;
};

export type BulkAssignConversationsPayload = LeadsBulkBasePayload & {
  conversationIds: string[];
  /** null = remover responsável. */
  assignedToId: string | null;
  actorRole: "ADMIN" | "MANAGER" | "MEMBER";
  canReassignOthers: boolean;
  canTransfer: boolean;
};

export type LeadsBulkPayload =
  | BulkUpdateFieldsPayload
  | BulkMoveStagePayload
  | BulkResolveConversationsPayload
  | BulkAssignConversationsPayload;

// ── Import ETL payloads ──────────────────────────────────
//
// Mesma convenção dos leads-bulk: o `BulkOperation` no Postgres é a fonte da
// verdade do progresso; o payload carrega apenas a referência ao arquivo no
// storage (bucket + fileName) e os parâmetros de parsing/upsert.

export type ContactImportPayload = {
  /** ID do `BulkOperation` que rastreia este job. */
  operationId: string;
  /** Tenant — usado para `withSystemContext` e para resolver o storage path. */
  organizationId: string;
  /** User que iniciou a importação (audit). */
  initiatedByUserId: string | null;
  /** Nome do arquivo salvo no bucket `imports`. */
  fileName: string;
  /** Nome original (para detectar CSV vs XLSX pela extensão). */
  originalName: string;
  /** Delimitador forçado (CSV). Se ausente, é detectado. */
  delimiter?: "," | ";" | "\t";
  /** Atualizar contatos existentes (default true). */
  updateExisting: boolean;
  /**
   * Modo de importação escolhido no wizard (apenas deals por ora):
   *   - `"create"`  → só cria; linhas que casam com um deal existente são skipped.
   *   - `"update"`  → só atualiza; linhas sem match são skipped (NÃO cria).
   *   - `"upsert"`  → cria e atualiza (comportamento histórico).
   * Ausente = fallback derivado de `updateExisting` (compat com clientes antigos).
   * Sync com `ImportMode` em `@/lib/import-helpers`.
   */
  importMode?: "create" | "update" | "upsert";
  /** Tag opcional a aplicar em todos os contatos importados. */
  tagName?: string;
  /**
   * Fatia do import (justiça entre tenants): linha inicial (0-based, sem o
   * cabeçalho) que este sub-job processa. Ausente = primeira fatia. Cada fatia
   * re-enfileira a próxima no FIM da fila, cedendo o slot à próxima org — sem
   * isso um import grande monopoliza o worker por minutos.
   */
  offset?: number;
};

/**
 * Payload do import de NEGÓCIOS (job `deal-import` da fila `import-etl`).
 * Mesma forma do ContactImportPayload — reutilizado para não duplicar o
 * shape (arquivo no storage/base64 + flags de parsing/upsert + tag opcional).
 */
export type DealImportPayload = ContactImportPayload;

const redisUrl = process.env.REDIS_URL;

const globalForQueue = globalThis as unknown as {
  automationQueueRedis?: IORedis;
  automationQueue?: Queue<AutomationJobPayload>;
  baileysOutboundQueue?: Queue<BaileysOutboundPayload>;
  baileysControlQueue?: Queue<BaileysControlPayload>;
  campaignDispatchQueue?: Queue<CampaignDispatchPayload>;
  campaignSendQueue?: Queue<CampaignSendPayload>;
  leadsBulkQueue?: Queue<LeadsBulkPayload>;
  importEtlQueue?: Queue<ContactImportPayload>;
  metaWebhookQueue?: Queue<MetaWebhookJobPayload>;
  metaAttachQueue?: Queue<MetaAttachPayload>;
};

function getQueueRedis(): IORedis | null {
  if (!redisUrl) return null;
  if (!globalForQueue.automationQueueRedis) {
    globalForQueue.automationQueueRedis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  return globalForQueue.automationQueueRedis;
}

function getQueue(): Queue<AutomationJobPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.automationQueue) {
    globalForQueue.automationQueue = new Queue<AutomationJobPayload>(AUTOMATION_JOBS_QUEUE_NAME, {
      connection: redis,
    });
  }
  return globalForQueue.automationQueue;
}

/**
 * Enqueue direto no BullMQ com as opções padrão de automação. Usado pelo
 * admission control de justiça (`lib/automation-fairness.ts`) — o `jobId`
 * determinístico do envelope permite re-add idempotente após crash no pump
 * (BullMQ deduplica por jobId, mesmo padrão do `enqueueMetaWebhookEvent`).
 */
export async function addAutomationJobNow(
  payload: AutomationJobPayload,
  jobId?: string,
) {
  const queue = getQueue();
  if (!queue) {
    throw new Error(
      `[queue] fila ${AUTOMATION_JOBS_QUEUE_NAME} indisponível (Redis) — automationId=${payload.automationId}`,
    );
  }
  const attempts = readPositiveInt(process.env.AUTOMATION_MAX_ATTEMPTS, 3);
  const backoffDelay = readPositiveInt(process.env.AUTOMATION_BACKOFF_DELAY, 3000);
  return queue.add(AUTOMATION_JOB_NAME, payload, {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
    ...(jobId ? { jobId } : {}),
  });
}

/** Fila de automações no processo corrente — usada pelo sweeper do worker. */
export function getAutomationQueue(): Queue<AutomationJobPayload> | null {
  return getQueue();
}

export async function enqueueAutomationJob(payload: AutomationJobPayload) {
  const workerMode = process.env.AUTOMATION_WORKER_MODE?.trim().toLowerCase();
  debugInfo(`[queue] enqueueAutomationJob — automationId=${payload.automationId} workerMode=${workerMode ?? "(não definido)"} contactId=${payload.context.contactId ?? "—"} event=${payload.context.event}`);

  if (workerMode === "external") {
    const queue = getQueue();
    if (!queue) {
      // Em modo external a API NÃO deve executar automações pesadas inline
      // (evita sobrecarregar o processo HTTP). Falhar de forma controlada.
      const err = new Error(
        `[queue] AUTOMATION_WORKER_MODE=external mas Redis/fila indisponível — não executando inline (automationId=${payload.automationId})`,
      );
      console.error(err.message);
      throw err;
    }

    // Justiça por org (default ligado; AUTOMATION_FAIRNESS=0 = rollback pro
    // FIFO global): admission control com backlog por org no Redis — ver
    // lib/automation-fairness.ts. Fallbacks preservam o comportamento
    // histórico: org não resolvida ou Redis do backlog fora → enqueue direto.
    const { isAutomationFairnessEnabled, enqueueAutomationJobFair } =
      await import("@/lib/automation-fairness");
    if (isAutomationFairnessEnabled()) {
      const fair = await enqueueAutomationJobFair(payload, (p, jobId) =>
        addAutomationJobNow(p, jobId),
      );
      if (fair === "fair") return null;
      if (fair === "unavailable") {
        const err = new Error(
          `[queue] Redis do admission control indisponível — não enfileirando automação ${payload.automationId}`,
        );
        console.error(err.message);
        throw err;
      }
      // "fallback" → segue pro enqueue direto abaixo.
    }

    console.info(`[queue] Enfileirando automação ${payload.automationId} no BullMQ`);
    return addAutomationJobNow(payload);
  }

  debugInfo(`[queue] Executando automação ${payload.automationId} inline (sem worker externo)...`);
  const startMs = Date.now();
  try {
    await executeAutomationDirect(payload);
    debugInfo(`[queue] Automação ${payload.automationId} executada inline OK (${Date.now() - startMs}ms)`);
  } catch (err) {
    console.error(`[queue] ✗ Automação ${payload.automationId} FALHOU inline (${Date.now() - startMs}ms):`, err);
  }
  return null;
}

async function executeAutomationDirect(payload: AutomationJobPayload) {
  const { runAutomationInline } = await import("@/services/automation-executor");
  await runAutomationInline(payload);
}

// ── Baileys queues ──────────────────────────────────────

function getBaileysOutboundQueue(): Queue<BaileysOutboundPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.baileysOutboundQueue) {
    globalForQueue.baileysOutboundQueue = new Queue<BaileysOutboundPayload>(
      BAILEYS_OUTBOUND_QUEUE_NAME,
      { connection: redis },
    );
  }
  return globalForQueue.baileysOutboundQueue;
}

function getBaileysControlQueue(): Queue<BaileysControlPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.baileysControlQueue) {
    globalForQueue.baileysControlQueue = new Queue<BaileysControlPayload>(
      BAILEYS_CONTROL_QUEUE_NAME,
      { connection: redis },
    );
  }
  return globalForQueue.baileysControlQueue;
}

export async function enqueueBaileysOutbound(payload: BaileysOutboundPayload) {
  const queue = getBaileysOutboundQueue();
  if (!queue) {
    console.warn("[queue] Redis indisponível — não é possível enviar via Baileys");
    return null;
  }
  return queue.add("send", payload, {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
  });
}

export async function enqueueBaileysControl(payload: BaileysControlPayload) {
  const queue = getBaileysControlQueue();
  if (!queue) {
    console.warn("[queue] Redis indisponível — não é possível controlar sessão Baileys");
    return null;
  }
  return queue.add(payload.action, payload, {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
  });
}

// ── Campaign queues ──────────────────────────────────────

function getCampaignDispatchQueue(): Queue<CampaignDispatchPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.campaignDispatchQueue) {
    globalForQueue.campaignDispatchQueue = new Queue<CampaignDispatchPayload>(
      CAMPAIGN_DISPATCH_QUEUE_NAME,
      { connection: redis },
    );
  }
  return globalForQueue.campaignDispatchQueue;
}

function getCampaignSendQueue(): Queue<CampaignSendPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.campaignSendQueue) {
    globalForQueue.campaignSendQueue = new Queue<CampaignSendPayload>(
      CAMPAIGN_SEND_QUEUE_NAME,
      { connection: redis },
    );
  }
  return globalForQueue.campaignSendQueue;
}

export async function enqueueCampaignDispatch(payload: CampaignDispatchPayload, delay?: number) {
  const queue = getCampaignDispatchQueue();
  if (!queue) {
    console.warn("[queue] Redis indisponível — não é possível disparar campanha");
    return null;
  }
  return queue.add("dispatch", payload, {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
    ...(delay ? { delay } : {}),
  });
}

function campaignSendJobOptions(): JobsOptions {
  // Retries/backoff configuráveis via env para permitir afinar comportamento
  // sem rebuild. Defaults preservam o comportamento histórico (6 tentativas,
  // backoff exponencial iniciando em 3s).
  const attempts = readPositiveInt(process.env.WHATSAPP_MAX_ATTEMPTS, 6);
  const backoffDelay = readPositiveInt(process.env.WHATSAPP_BACKOFF_DELAY, 3000);
  return {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
  };
}

export async function enqueueCampaignSend(payload: CampaignSendPayload) {
  const queue = getCampaignSendQueue();
  if (!queue) {
    console.warn("[queue] Redis indisponível — não é possível enviar mensagem de campanha");
    return null;
  }
  return queue.add("send", payload, campaignSendJobOptions());
}

/** Enfileira um lote de envios (evita N round-trips Redis no dispatch). */
export async function enqueueCampaignSendBulk(payloads: CampaignSendPayload[]) {
  const queue = getCampaignSendQueue();
  if (!queue) {
    console.warn("[queue] Redis indisponível — não é possível enviar mensagem de campanha");
    return null;
  }
  if (payloads.length === 0) return [];
  const opts = campaignSendJobOptions();
  return queue.addBulk(
    payloads.map((data) => ({
      name: "send",
      data,
      opts,
    })),
  );
}

// ── Leads bulk queue ─────────────────────────────────────

function getLeadsBulkQueue(): Queue<LeadsBulkPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.leadsBulkQueue) {
    globalForQueue.leadsBulkQueue = new Queue<LeadsBulkPayload>(
      LEADS_BULK_QUEUE_NAME,
      { connection: redis },
    );
  }
  return globalForQueue.leadsBulkQueue;
}

/**
 * Enfileira um job na fila `leads-bulk`.
 *
 * Os retries são pensados para erros transientes (DB indisponível, conflito
 * de stage por concorrência etc.). Falhas por-item (deal específico) são
 * registradas em `BulkOperation.errors` pelo próprio handler e NÃO causam
 * retry do job inteiro — o worker continua processando os demais itens.
 *
 * Defaults: 5 tentativas com backoff exponencial iniciando em 5s.
 * Override via `LEADS_BULK_MAX_ATTEMPTS` / `LEADS_BULK_BACKOFF_DELAY`.
 *
 * Retorna `null` se Redis estiver indisponível — o caller deve marcar o
 * `BulkOperation` como `FAILED` e responder 503 ao cliente (não deixar
 * o registro em PENDING para sempre).
 */
export async function enqueueLeadsBulk<P extends LeadsBulkPayload>(
  jobName: LeadsBulkJobName,
  payload: P,
  overrides?: JobsOptions,
) {
  const queue = getLeadsBulkQueue();
  if (!queue) {
    console.warn(
      "[queue] Redis indisponível — não é possível enfileirar leads-bulk",
    );
    return null;
  }
  const attempts = readPositiveInt(process.env.LEADS_BULK_MAX_ATTEMPTS, 5);
  const backoffDelay = readPositiveInt(
    process.env.LEADS_BULK_BACKOFF_DELAY,
    5000,
  );
  const opts: JobsOptions = {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
    ...overrides,
  };
  return queue.add(jobName, payload, opts);
}

// ── Import ETL queue ─────────────────────────────────────

function getImportEtlQueue(): Queue<ContactImportPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.importEtlQueue) {
    globalForQueue.importEtlQueue = new Queue<ContactImportPayload>(
      IMPORT_ETL_QUEUE_NAME,
      { connection: redis },
    );
  }
  return globalForQueue.importEtlQueue;
}

/**
 * Enfileira um job de importação ETL.
 *
 * Retorna `null` se Redis estiver indisponível — o caller deve marcar o
 * `BulkOperation` como FAILED e responder 503 (não deixar PENDING órfão).
 *
 * Defaults: 3 tentativas com backoff exponencial iniciando em 10s. Falhas
 * por-linha são registradas em `BulkOperation.errors` e NÃO causam retry do
 * job inteiro — o handler continua processando as demais linhas.
 */
export async function enqueueImportEtl(
  jobName: ImportEtlJobName,
  payload: ContactImportPayload,
  overrides?: JobsOptions,
) {
  const queue = getImportEtlQueue();
  if (!queue) {
    console.warn("[queue] Redis indisponível — não é possível enfileirar import-etl");
    return null;
  }
  const attempts = readPositiveInt(process.env.IMPORT_ETL_MAX_ATTEMPTS, 3);
  const backoffDelay = readPositiveInt(process.env.IMPORT_ETL_BACKOFF_DELAY, 10000);
  const opts: JobsOptions = {
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
    ...overrides,
  };
  return queue.add(jobName, payload, opts);
}

// ── Meta webhook queue ───────────────────────────────────

function getMetaWebhookQueue(): Queue<MetaWebhookJobPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.metaWebhookQueue) {
    globalForQueue.metaWebhookQueue = new Queue<MetaWebhookJobPayload>(
      META_WEBHOOK_QUEUE_NAME,
      { connection: redis },
    );
  }
  return globalForQueue.metaWebhookQueue;
}

/**
 * Enfileira um MetaWebhookEvent para processamento assíncrono pelo
 * `worker-meta-webhook`. `jobId = metaWebhookEventId` deduplica retries
 * da Meta (mesmo evento não vira dois jobs).
 *
 * Retorna `null` se Redis indisponível — o caller decide o fallback
 * (processar síncrono para não perder o evento).
 */
export async function enqueueMetaWebhookEvent(payload: MetaWebhookJobPayload) {
  const queue = getMetaWebhookQueue();
  if (!queue) {
    console.warn("[queue] Redis indisponível — não é possível enfileirar meta-webhook");
    return null;
  }
  const attempts = readPositiveInt(process.env.META_WEBHOOK_MAX_ATTEMPTS, 5);
  const backoffDelay = readPositiveInt(process.env.META_WEBHOOK_BACKOFF_DELAY, 2000);
  return queue.add("process", payload, {
    jobId: payload.metaWebhookEventId,
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
  });
}

function getMetaAttachQueue(): Queue<MetaAttachPayload> | null {
  const redis = getQueueRedis();
  if (!redis) return null;
  if (!globalForQueue.metaAttachQueue) {
    globalForQueue.metaAttachQueue = new Queue<MetaAttachPayload>(
      META_ATTACH_QUEUE_NAME,
      { connection: redis },
    );
  }
  return globalForQueue.metaAttachQueue;
}

/**
 * Enfileira remux + envio Cloud API de um áudio já persistido.
 * `jobId = meta-attach:${messageId}` deduplica retries do produtor.
 * Retorna `null` se Redis indisponível — o caller faz fallback síncrono.
 */
export async function enqueueMetaAttach(payload: MetaAttachPayload) {
  const queue = getMetaAttachQueue();
  if (!queue) {
    console.warn("[queue] Redis indisponível — não é possível enfileirar meta-attach");
    return null;
  }
  const attempts = readPositiveInt(process.env.META_ATTACH_MAX_ATTEMPTS, 3);
  const backoffDelay = readPositiveInt(process.env.META_ATTACH_BACKOFF_DELAY, 2000);
  return queue.add("process", payload, {
    jobId: `meta-attach:${payload.messageId}`,
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
    attempts,
    backoff: { type: "exponential", delay: backoffDelay },
  });
}

// ── Helpers privados ─────────────────────────────────────

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
