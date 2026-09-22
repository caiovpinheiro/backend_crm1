/**
 * Métricas Prometheus do CRM (PR 2.2).
 *
 * Registry singleton centralizado pra evitar duplicação de Counter/Histogram
 * por hot-reload do Next.js (que recarrega módulos no dev).
 *
 * Métricas expostas em `GET /api/metrics` (autenticado por `METRICS_TOKEN`)
 * no formato text/plain Prometheus 0.0.4. Promtail/scraper Prometheus puxa
 * a cada 15s. Cardinalidade controlada — `route` é o template (`/api/conversations/:id`),
 * NÃO o path concreto, pra não explodir séries por id.
 *
 * Uso típico nos call-sites:
 *   import { metrics } from "@/lib/metrics";
 *   metrics.http.requests.inc({ route, method, status, organization });
 *   metrics.http.duration.observe({ route, method, status }, durationSec);
 *   const end = metrics.http.duration.startTimer({ route, method });
 *   // ... handler ...
 *   end({ status: "200" });
 *
 * Para métricas custom novas, registre aqui (não no call-site) — assim a doc
 * fica concentrada e quem opera o Grafana sabe exatamente onde olhar.
 */

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";

const globalKey = Symbol.for("crm-eduit.metrics-registry");
type GlobalWithRegistry = typeof globalThis & {
  [K in typeof globalKey]?: {
    registry: Registry;
    metrics: AppMetrics;
  };
};

const g = globalThis as GlobalWithRegistry;

function buildMetrics(registry: Registry): AppMetrics {
  collectDefaultMetrics({ register: registry, prefix: "crm_" });

  const httpRequests = new Counter({
    name: "crm_http_requests_total",
    help: "Total HTTP requests recebidas pelo Next handler.",
    labelNames: ["route", "method", "status", "organization"] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: "crm_http_request_duration_seconds",
    help: "Latência ponta-a-ponta do handler HTTP (segundos).",
    labelNames: ["route", "method", "status"] as const,
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
    registers: [registry],
  });

  const sseSubscribers = new Gauge({
    name: "crm_sse_subscribers",
    help: "Clientes SSE conectados no momento (por organização).",
    labelNames: ["organization", "channel"] as const,
    registers: [registry],
  });

  const sseMessages = new Counter({
    name: "crm_sse_messages_total",
    help: "Eventos SSE publicados (após filtro tenant).",
    labelNames: ["event", "organization"] as const,
    registers: [registry],
  });

  // `new_message` de entrada que chegou ao cliente sem `card`. `budget` é
  // por evento (snapshot estourou/falhou no bus); `hidden` é por conexão
  // (o gate de visibilidade tirou o card daquele usuário).
  const sseInboundWithoutCard = new Counter({
    name: "crm_sse_inbound_without_card_total",
    help: "new_message de entrada sem card no SSE, por motivo.",
    labelNames: ["reason"] as const,
    registers: [registry],
  });

  const bullmqJobs = new Counter({
    name: "crm_bullmq_jobs_total",
    help: "Jobs BullMQ por status terminal.",
    labelNames: ["queue", "status"] as const,
    registers: [registry],
  });

  const bullmqDuration = new Histogram({
    name: "crm_bullmq_job_duration_seconds",
    help: "Tempo de execução de jobs BullMQ (segundos).",
    labelNames: ["queue", "status"] as const,
    buckets: [0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
    registers: [registry],
  });

  const metaApi = new Counter({
    name: "crm_meta_api_calls_total",
    help: "Chamadas à API da Meta (Graph) — por endpoint e status.",
    labelNames: ["endpoint", "status", "organization"] as const,
    registers: [registry],
  });

  const metaApiDuration = new Histogram({
    name: "crm_meta_api_duration_seconds",
    help: "Latência de chamadas à API da Meta (segundos).",
    labelNames: ["endpoint", "status"] as const,
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });

  const inboundMessages = new Counter({
    name: "crm_inbound_messages_total",
    help: "Mensagens inbound processadas (webhook Meta + Baileys).",
    labelNames: ["channel_provider", "organization"] as const,
    registers: [registry],
  });

  const outboundMessages = new Counter({
    name: "crm_outbound_messages_total",
    help: "Mensagens outbound entregues à API.",
    labelNames: ["channel_provider", "status", "organization"] as const,
    registers: [registry],
  });

  const aiTokens = new Counter({
    name: "crm_ai_tokens_total",
    help: "Tokens consumidos por modelo AI (in/out).",
    labelNames: ["provider", "model", "kind", "organization"] as const,
    registers: [registry],
  });

  const dbQueries = new Histogram({
    name: "crm_db_query_duration_seconds",
    help: "Duração de queries Prisma (segundos).",
    labelNames: ["model", "action"] as const,
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    registers: [registry],
  });

  const errors = new Counter({
    name: "crm_errors_total",
    help: "Erros nominados por escopo (logger.error).",
    labelNames: ["scope", "kind"] as const,
    registers: [registry],
  });

  // Profundidade das filas BullMQ (waiting/active/delayed/failed) — usado
  // para dimensionar concurrency de workers e detectar back-pressure.
  // Populado sob demanda via `updateQueueDepth()` chamado por scraping ou
  // por um ticker leve (ver call-site opcional em src/lib/queue.ts).
  const bullmqQueueDepth = new Gauge({
    name: "crm_bullmq_queue_depth",
    help: "Jobs na fila BullMQ por estado (snapshot no scrape).",
    labelNames: ["queue", "state"] as const,
    registers: [registry],
  });

  // Pool de conexoes Postgres (Prisma adapter-pg). Populado por
  // `updateDbPool()`. Se o pool nao estiver acessivel, permanece zerado
  // (nao explode).
  const dbPool = new Gauge({
    name: "crm_db_pool_connections",
    help: "Conexoes do pool pg (total/idle/waiting).",
    labelNames: ["state"] as const,
    registers: [registry],
  });

  // Cache (PR 5.1) — hits/misses por namespace (channel, ai_agent, org).
  // Usado pra decidir se o TTL atual e bom ou se hot-keys merecem
  // pre-warming.
  const cacheHits = new Counter({
    name: "crm_cache_hits_total",
    help: "Cache hits por namespace de chave.",
    labelNames: ["key"] as const,
    registers: [registry],
  });

  const cacheMisses = new Counter({
    name: "crm_cache_misses_total",
    help: "Cache misses por namespace de chave (forcou loader).",
    labelNames: ["key"] as const,
    registers: [registry],
  });

  const activityOutboxProcessed = new Counter({
    name: "crm_activity_outbox_processed_total",
    help: "Itens da activity_outbox projetados, em retry ou dead letter.",
    labelNames: ["organization", "status"] as const,
    registers: [registry],
  });
  const activityOutboxDepth = new Gauge({
    name: "crm_activity_outbox_depth",
    help: "Itens pendentes na activity_outbox por organização.",
    labelNames: ["organization"] as const,
    registers: [registry],
  });
  const activityOutboxDead = new Gauge({
    name: "crm_activity_outbox_dead",
    help: "Itens em dead letter na activity_outbox por organização.",
    labelNames: ["organization"] as const,
    registers: [registry],
  });
  const activityOutboxAge = new Gauge({
    name: "crm_activity_outbox_oldest_seconds",
    help: "Idade em segundos do item pendente mais antigo da outbox.",
    labelNames: ["organization"] as const,
    registers: [registry],
  });

  return {
    http: { requests: httpRequests, duration: httpDuration },
    sse: {
      subscribers: sseSubscribers,
      messages: sseMessages,
      inboundWithoutCard: sseInboundWithoutCard,
    },
    bullmq: { jobs: bullmqJobs, duration: bullmqDuration, queueDepth: bullmqQueueDepth },
    meta: { calls: metaApi, duration: metaApiDuration },
    messages: { inbound: inboundMessages, outbound: outboundMessages },
    ai: { tokens: aiTokens },
    db: { queries: dbQueries, pool: dbPool },
    errors,
    cacheHits,
    cacheMisses,
    activityOutbox: {
      processed: activityOutboxProcessed,
      depth: activityOutboxDepth,
      dead: activityOutboxDead,
      age: activityOutboxAge,
    },
  };
}

export type AppMetrics = {
  http: {
    requests: Counter<"route" | "method" | "status" | "organization">;
    duration: Histogram<"route" | "method" | "status">;
  };
  sse: {
    subscribers: Gauge<"organization" | "channel">;
    messages: Counter<"event" | "organization">;
    inboundWithoutCard: Counter<"reason">;
  };
  bullmq: {
    jobs: Counter<"queue" | "status">;
    duration: Histogram<"queue" | "status">;
    queueDepth: Gauge<"queue" | "state">;
  };
  meta: {
    calls: Counter<"endpoint" | "status" | "organization">;
    duration: Histogram<"endpoint" | "status">;
  };
  messages: {
    inbound: Counter<"channel_provider" | "organization">;
    outbound: Counter<"channel_provider" | "status" | "organization">;
  };
  ai: {
    tokens: Counter<"provider" | "model" | "kind" | "organization">;
  };
  db: {
    queries: Histogram<"model" | "action">;
    pool: Gauge<"state">;
  };
  errors: Counter<"scope" | "kind">;
  cacheHits: Counter<"key">;
  cacheMisses: Counter<"key">;
  activityOutbox: {
    processed: Counter<"organization" | "status">;
    depth: Gauge<"organization">;
    dead: Gauge<"organization">;
    age: Gauge<"organization">;
  };
};

function ensureRegistry(): { registry: Registry; metrics: AppMetrics } {
  if (g[globalKey]) return g[globalKey]!;
  const registry = new Registry();
  registry.setDefaultLabels({ app: "crm-eduit" });
  const metrics = buildMetrics(registry);
  g[globalKey] = { registry, metrics };
  return g[globalKey]!;
}

export const registry: Registry = ensureRegistry().registry;
export const metrics: AppMetrics = ensureRegistry().metrics;

/**
 * Renderiza o snapshot atual no formato Prometheus exposition (text/plain).
 * Usado pelo endpoint `/api/metrics`.
 *
 * Antes de serializar, coleta snapshots de gauges "puxados" (queue depth
 * BullMQ e pool pg) — assim o valor exposto reflete o instante do scrape.
 * Falhas silenciosas (Redis fora, adapter sem pool) mantem gauge zerado.
 */
export async function renderMetrics(): Promise<{
  body: string;
  contentType: string;
}> {
  await Promise.allSettled([snapshotQueueDepth(), snapshotDbPool()]);
  const body = await registry.metrics();
  return { body, contentType: registry.contentType };
}

async function snapshotQueueDepth(): Promise<void> {
  try {
    const mod = await import("@/lib/queue-metrics");
    await mod.collectQueueDepth();
  } catch {
    // modulo opcional / redis indisponivel — ok.
  }
}

async function snapshotDbPool(): Promise<void> {
  try {
    const mod = await import("@/lib/db-pool-metrics");
    await mod.collectDbPool();
  } catch {
    // pool nao exposto — ok.
  }
}

/**
 * Helper resiliente para usar nas paths quentes — evita quebrar o handler
 * caso a label tenha valor null/undefined inesperado.
 */
export function safeLabel(v: unknown, fallback = "unknown"): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return v.length > 0 ? v : fallback;
  return String(v);
}

/**
 * Reduz um pathname concreto ao TEMPLATE da rota, trocando segmentos que
 * parecem id (numérico, cuid, uuid) por `:id`. Sem isso, cada request com
 * id diferente viraria uma série nova em `crm_http_requests_total` e
 * explodiria a cardinalidade do Prometheus (o comentário do topo do arquivo
 * exige `route` = template, não path concreto).
 */
const ID_SEGMENT =
  /^(?:\d+|c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function templatizeRoute(path: string): string {
  if (!path) return "unknown";
  const clean = path.split("?")[0];
  const out = clean
    .split("/")
    .map((seg) => (ID_SEGMENT.test(seg) ? ":id" : seg))
    .join("/");
  return out || "/";
}

/**
 * Emite as métricas HTTP (contador + histograma de latência) para uma request
 * concluída. Chamado pelos wrappers de entrada (`withOrgContext`,
 * `withApiAuthContext`) que já calculam método/path/status/duração.
 *
 * `route` é templatizado (cardinalidade controlada). NÃO quebramos por
 * organização aqui — o relatório agrega por `env` (label injetada pelo scrape
 * do Prometheus), e quebrar por org multiplicaria as séries sem necessidade.
 * A label `organization` fica fixa em "all" só para satisfazer o schema.
 *
 * Totalmente resiliente: qualquer erro na emissão é engolido — métrica nunca
 * pode derrubar um handler.
 */
export function observeHttpRequest(args: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}): void {
  try {
    const route = templatizeRoute(args.path);
    const method = (args.method || "GET").toUpperCase();
    const status = String(args.status || 0);
    metrics.http.requests.inc({ route, method, status, organization: "all" });
    metrics.http.duration.observe(
      { route, method, status },
      Math.max(0, args.durationMs) / 1000,
    );
  } catch {
    // métricas nunca devem quebrar o request
  }
}
