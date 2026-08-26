import type { Prisma } from "@prisma/client";

import { enqueueAutomationJob, type AutomationJobContext } from "@/lib/queue";

export type { AutomationJobContext } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { normalizeHoursBeforeExpiry } from "@/services/whatsapp-session-expiry";
import {
  findFirstMessageStepIndex,
  newStepId,
  readTriggerChannelIds,
  readTriggerChannelScope,
  validateFirstMessageChannel,
} from "@/lib/automation-workflow";

export const AUTOMATION_TRIGGER_TYPES = [
  "stage_changed",
  "tag_added",
  "lead_score_reached",
  "deal_created",
  "deal_won",
  "deal_lost",
  "contact_created",
  "conversation_created",
  "lifecycle_changed",
  "agent_changed",
  "message_received",
  "message_sent",
  "call_received",
  "call_made",
  "call_permission_granted",
  "conversation_tabulated",
  "whatsapp_session_expiring",
  "lead_distributed",
] as const;

export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export type AutomationTriggerEvaluationContext = AutomationJobContext;

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function readStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/**
 * Estágios-alvo de um gatilho. Suporta multi-seleção (`stageIds: string[]`)
 * mantendo compatibilidade com o formato antigo de estágio único (`stageId`).
 * Retorna [] quando o operador não restringiu por estágio ("Qualquer estágio").
 */
function readTriggerStageIds(cfg: Record<string, unknown>): string[] {
  const many = readStringArray(cfg, "stageIds");
  if (many.length > 0) return many;
  const one = readString(cfg, "stageId");
  return one ? [one] : [];
}

/** `selected` + lista vazia = não dispara. `all` aceita filtro grosso por tipo. */
function matchTriggerChannelFilter(
  cfg: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  const channelIds = readTriggerChannelIds(cfg);
  const dataChannelId = readString(data, "channelId");
  if (readTriggerChannelScope(cfg) === "selected") {
    if (channelIds.length === 0) return false;
    return Boolean(dataChannelId && channelIds.includes(dataChannelId));
  }
  const channel = readString(cfg, "channel");
  const dataChannel = readString(data, "channel");
  if (channel && dataChannel && dataChannel.toLowerCase() !== channel.toLowerCase()) {
    return false;
  }
  return true;
}

const STEP_ID_REF_KEYS = new Set([
  "nextStepId",
  "elseGotoStepId",
  "timeoutGotoStepId",
  "receivedGotoStepId",
  "failureGotoStepId",
  "targetStepId",
  "gotoStepId",
  "elseStepId",
  "_nextStepId",
  "_trueGotoStepId",
  "_falseGotoStepId",
  "_answeredGotoStepId",
]);

function remapStepRefsInValue(value: unknown, remap: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => remapStepRefsInValue(entry, remap));
  }
  if (!value || typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(obj)) {
    if (typeof raw === "string" && STEP_ID_REF_KEYS.has(key) && remap.has(raw)) {
      next[key] = remap.get(raw);
      continue;
    }
    next[key] = remapStepRefsInValue(raw, remap);
  }

  return next;
}

/**
 * Garante IDs únicos no payload de replace. Remapeia só o que colide com
 * outro step (mesmo payload ou outra automação) — nunca trata os steps
 * que acabamos de apagar desta automação como conflito.
 */
function prepareStepsForReplace(
  steps: CreateAutomationStepInput[],
  takenIds: Set<string>,
): CreateAutomationStepInput[] {
  const remap = new Map<string, string>();
  const seen = new Set<string>();
  const out: CreateAutomationStepInput[] = [];

  for (const step of steps) {
    const oldId = typeof step.id === "string" && step.id.trim() ? step.id.trim() : "";
    let id = oldId;
    if (!id || takenIds.has(id) || seen.has(id)) {
      const generated = newStepId();
      if (oldId) remap.set(oldId, generated);
      id = generated;
    }
    seen.add(id);
    out.push({ ...step, id });
  }

  if (remap.size === 0) return out;
  return out.map((step) => ({
    ...step,
    config: remapStepRefsInValue(step.config, remap) as Prisma.InputJsonValue,
  }));
}

export function evaluateTrigger(
  triggerType: string,
  triggerConfig: unknown,
  context: AutomationTriggerEvaluationContext
): boolean {
  const cfg = asRecord(triggerConfig) ?? {};
  const data = asRecord(context.data) ?? {};

  switch (triggerType) {
    case "stage_changed": {
      // `stageId` é aceito como ALIAS de `toStageId`: algumas telas
      // (funil/pipeline) salvam a etapa-alvo em `stageId`. Sem esse alias,
      // a automação "quando entra na fase X" configurada por essas telas
      // não casava (o matcher só olhava `toStageId`).
      // Multi-seleção: aceita `toStageIds`/`stageIds` (arrays) além do
      // formato antigo de estágio único (`toStageId`/`stageId`).
      const toStages = (() => {
        const arr = [
          ...readStringArray(cfg, "toStageIds"),
          ...readStringArray(cfg, "stageIds"),
        ];
        if (arr.length > 0) return arr;
        const single = readString(cfg, "toStageId") ?? readString(cfg, "stageId");
        return single ? [single] : [];
      })();
      const fromStages = (() => {
        const arr = readStringArray(cfg, "fromStageIds");
        if (arr.length > 0) return arr;
        const single = readString(cfg, "fromStageId");
        return single ? [single] : [];
      })();
      const dataTo = readString(data, "toStageId") ?? readString(data, "stageId");
      const dataFrom = readString(data, "fromStageId");
      if (toStages.length > 0 && dataTo && !toStages.includes(dataTo)) return false;
      if (fromStages.length > 0 && dataFrom && !fromStages.includes(dataFrom)) return false;
      return true;
    }
    case "tag_added": {
      const tagId = readString(cfg, "tagId");
      const tagName = readString(cfg, "tagName");
      const dataTagId = readString(data, "tagId");
      const dataTagName = readString(data, "tagName");
      if (tagId && dataTagId && dataTagId !== tagId) return false;
      if (tagName && dataTagName && dataTagName.toLowerCase() !== tagName.toLowerCase()) return false;
      return true;
    }
    case "lead_score_reached": {
      const threshold = readNumber(cfg, "threshold") ?? readNumber(cfg, "minScore");
      if (threshold === undefined) return true;
      const score =
        readNumber(data, "score") ??
        readNumber(data, "leadScore") ??
        readNumber(data, "newScore");
      if (score === undefined) return false;
      return score >= threshold;
    }
    case "deal_created":
    case "deal_won":
    case "deal_lost": {
      const pipelineId = readString(cfg, "pipelineId");
      const dataPipelineId = readString(data, "pipelineId");
      if (pipelineId && dataPipelineId && dataPipelineId !== pipelineId) return false;
      if (pipelineId && !dataPipelineId) return false;
      // 27/mai/26 — Adicionado filtro por `stageId` (e suporte a `toStageId`
      // como alias, pra alinhar com o payload do auto-deal). Antes só
      // filtrava pipeline; agora o operador consegue criar "automação X
      // quando lead/deal entra no estágio Y".
      const stageIds = readTriggerStageIds(cfg);
      const dataStageId = readString(data, "stageId") ?? readString(data, "toStageId");
      if (stageIds.length > 0 && dataStageId && !stageIds.includes(dataStageId)) return false;
      if (stageIds.length > 0 && !dataStageId) return false;
      return true;
    }
    case "contact_created": {
      // 27/mai/26 — Filtros por pipeline/estágio adicionados. O evento é
      // disparado ANTES do auto-deal ser criado, então `enrichContext`
      // tenta carregar o deal aberto do contato (race best-effort). Se
      // nenhum filtro estiver configurado, segue passando como antes.
      const pipelineId = readString(cfg, "pipelineId");
      const dataPipelineId = readString(data, "pipelineId") ?? readString(data, "dealPipelineId");
      if (pipelineId && dataPipelineId && dataPipelineId !== pipelineId) return false;
      if (pipelineId && !dataPipelineId) return false;
      const stageIds = readTriggerStageIds(cfg);
      const dataStageId =
        readString(data, "stageId") ??
        readString(data, "dealStageId") ??
        readString(data, "toStageId");
      if (stageIds.length > 0 && dataStageId && !stageIds.includes(dataStageId)) return false;
      if (stageIds.length > 0 && !dataStageId) return false;
      return true;
    }
    case "conversation_created": {
      if (!matchTriggerChannelFilter(cfg, data)) return false;
      return true;
    }
    case "lifecycle_changed": {
      const toLifecycle = readString(cfg, "toLifecycle") ?? readString(cfg, "lifecycleStage");
      const dataTo = readString(data, "to") ?? readString(data, "toLifecycle") ?? readString(data, "lifecycleStage");
      if (toLifecycle && dataTo && dataTo !== toLifecycle) return false;
      const fromLifecycle = readString(cfg, "fromLifecycle") ?? readString(cfg, "from");
      const dataFrom = readString(data, "from") ?? readString(data, "fromLifecycle");
      if (fromLifecycle && dataFrom && dataFrom !== fromLifecycle) return false;
      return true;
    }
    case "agent_changed": {
      const toAgentId = readString(cfg, "toAgentId");
      const dataToAgent = readString(data, "toAgentId") ?? readString(data, "assignedToId");
      if (toAgentId && dataToAgent && dataToAgent !== toAgentId) return false;
      return true;
    }
    case "message_received":
    case "message_sent": {
      // 27/mai/26 (v2) — Best-effort: o filtro de estagio/pipeline so
      // descarta o evento quando CONHECEMOS o estagio do contato (via
      // deal aberto enriquecido em `enrichContext`) e ele DIVERGE do
      // filtro. Se nao conhecemos (sem deal aberto, contato novo, etc.)
      // deixamos passar — caso contrario o gatilho "mensagem recebida"
      // nunca dispara pra contatos sem negocio aberto, que e o cenario
      // mais comum em receptivo.
      if (!matchTriggerChannelFilter(cfg, data)) return false;
      const stageIds = readTriggerStageIds(cfg);
      const dataStageId = readString(data, "stageId") ?? readString(data, "dealStageId");
      if (stageIds.length > 0 && dataStageId && !stageIds.includes(dataStageId)) return false;
      const pipelineId = readString(cfg, "pipelineId");
      const dataPipelineId = readString(data, "pipelineId") ?? readString(data, "dealPipelineId");
      if (pipelineId && dataPipelineId && dataPipelineId !== pipelineId) return false;
      // 27/mai/26 (v3) — Filtro por status do negocio (OPEN/WON/LOST).
      // Aceita CSV pra "qualquer um de" (ex.: "WON,LOST") — o front
      // expoe isso como a opcao composta "Ganho ou Perdido", que e o
      // caso pratico de retencao/reengajamento. Ao contrario de
      // stage/pipeline, aqui somos estritos: se o operador filtrou
      // por status e o contato nao tem nenhum deal (data sem
      // `dealStatus`), a automacao NAO dispara — o filtro deixaria de
      // ter sentido se passasse pra contatos sem negocio.
      const dealStatus = readString(cfg, "dealStatus");
      if (dealStatus) {
        const accepted = dealStatus
          .split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
        if (accepted.length > 0) {
          const dataDealStatus = readString(data, "dealStatus");
          if (!dataDealStatus) return false;
          if (!accepted.includes(dataDealStatus.toUpperCase())) return false;
        }
      }
      return true;
    }
    case "call_received":
    case "call_made": {
      // Filtro por resultado da ligação. O payload (services/calls.ts)
      // inclui `answered: boolean`. status "" = qualquer; "answered" =
      // só atendidas; "missed" = só não atendidas.
      const status = readString(cfg, "status");
      if (status === "answered" || status === "missed") {
        const answered = data.answered === true;
        if (status === "answered" && !answered) return false;
        if (status === "missed" && answered) return false;
      }
      return true;
    }
    case "call_permission_granted": {
      // Opt-in de voz WhatsApp (template call_permission), não SIP.
      // consentType "" = qualquer; PERMANENT / TEMPORARY filtram o payload.
      const consentType = readString(cfg, "consentType");
      if (consentType === "PERMANENT" || consentType === "TEMPORARY") {
        const dataType = readString(data, "consentType");
        if (!dataType || dataType !== consentType) return false;
      }
      return true;
    }
    case "whatsapp_session_expiring":
      return normalizeHoursBeforeExpiry(cfg.hoursBeforeExpiry) !== null;
    case "lead_distributed": {
      // Disparado pelo motor quando um HUMAN assume vindo de IA/sem dono
      // (inclui conversas que já tiveram resposta humana). Filtro opcional por depto.
      const cfgDept = readString(cfg, "departmentId");
      const dataDept = readString(data, "departmentId");
      if (cfgDept && dataDept && cfgDept !== dataDept) return false;
      if (cfgDept && !dataDept) return false;
      return true;
    }
    case "manual": {
      // 27/mai/26 — Gatilho imperativo. O operador escolheu rodar a
      // automacao explicitamente pelo botao "Rodar automacao" na
      // conversa (inbox/kanban); nao ha filtro a avaliar. A
      // protecao contra disparo nao-autorizado fica no endpoint
      // POST /api/automations/:id/run, que so enfileira automacoes
      // ativas com triggerType="manual".
      return true;
    }
    case "conversation_tabulated": {
      // Filtro por departamento (opcional): so casa se o encerramento
      // aconteceu no dept configurado. Sem departmentId => any dept.
      const cfgDept = readString(cfg, "departmentId");
      const dataDept = readString(data, "departmentId");
      if (cfgDept && dataDept && cfgDept !== dataDept) return false;
      if (cfgDept && !dataDept) return false;

      const dataTab = readString(data, "tabulationId");

      // Filtro explicito: usuario marcou "Somente quando tiver tabulacao".
      // Encerramentos sem tabulationId sao descartados aqui.
      const requireTab = cfg.requireTabulation === true;
      if (requireTab && !dataTab) return false;

      // Filtro por tabulacao: casa se `config.tabulationId` for a
      // propria tabulacao escolhida OU um ancestral dela. Assim o
      // operador consegue mirar a categoria pai (ex.: "NÃO É ALUNO")
      // e valer pra todas as folhas descendentes.
      const cfgTab = readString(cfg, "tabulationId");
      if (!cfgTab) return true;
      const dataAncestors = Array.isArray(data.ancestorIds)
        ? (data.ancestorIds as unknown[]).filter(
            (v): v is string => typeof v === "string",
          )
        : [];
      if (cfgTab === dataTab) return true;
      if (dataAncestors.includes(cfgTab)) return true;
      return false;
    }
    default:
      return true;
  }
}

export type GetAutomationsParams = {
  active?: boolean;
  search?: string;
  page?: number;
  perPage?: number;
  /**
   * 27/mai/26 — Filtro por `triggerType` (usado pelo botao "Rodar
   * automacao" no inbox/kanban pra listar so as automacoes com
   * gatilho `manual`). Aceita string unica; se necessario no futuro
   * pode virar string[].
   */
  triggerType?: string;
};

const automationListSelect = {
  id: true,
  name: true,
  description: true,
  triggerType: true,
  triggerConfig: true,
  active: true,
  allowManualRun: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { steps: true } },
  // Tipos dos passos (na ordem) para o mini-fluxo do card refletir o
  // workflow real — antes a UI caía num fluxo mock fixo. Só `type` é
  // selecionado (payload mínimo); a config completa fica no detalhe.
  steps: { select: { type: true }, orderBy: { position: "asc" } },
} satisfies Prisma.AutomationSelect;

export async function getAutomations(params: GetAutomationsParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const skip = (page - 1) * perPage;

  const organizationId = getOrgIdOrThrow();
  const where: Prisma.AutomationWhereInput = { organizationId };
  if (params.active !== undefined) {
    where.active = params.active;
  }
  if (params.triggerType) {
    where.triggerType = params.triggerType;
  }
  const search = params.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.automation.findMany({
      where,
      skip,
      take: perPage,
      orderBy: [{ updatedAt: "desc" }],
      select: automationListSelect,
    }),
    prisma.automation.count({ where }),
  ]);

  // Métricas por card: só a janela de hoje (não all-time). O groupBy
  // histórico em automation_logs (stepId IS NULL) saturava o índice
  // (automationId, stepId) e competia com o worker. KPIs da página
  // vêm de GET /api/automations/summary.
  const stats = await buildAutomationListStats(items.map((i) => i.id));

  return {
    items: items.map(({ _count, steps, ...rest }) => ({
      ...rest,
      stepCount: _count.steps,
      stepTypes: steps.map((s) => s.type),
      ...(stats.get(rest.id) ?? EMPTY_AUTOMATION_STATS),
    })),
    total,
    page,
    perPage,
  };
}

type AutomationListStats = {
  runs: number;
  runsToday: number;
  successRate: number;
  lastRunAt: string | null;
};

const EMPTY_AUTOMATION_STATS: AutomationListStats = {
  runs: 0,
  runsToday: 0,
  successRate: 0,
  lastRunAt: null,
};

export type AutomationListSummary = {
  total: number;
  active: number;
  paused: number;
  runsToday: number;
  avgSuccess: number;
};

/**
 * KPIs da listagem: COUNTs na tabela de automações + agregação de logs
 * só de hoje (stepId IS NULL). Sem groupBy all-time e sem carregar N
 * automações só para somar no cliente.
 */
export async function getAutomationListSummary(): Promise<AutomationListSummary> {
  const organizationId = getOrgIdOrThrow();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [counts, todayStatus] = await Promise.all([
    prisma.automation.groupBy({
      by: ["active"],
      where: { organizationId },
      _count: { id: true },
    }),
    prisma.automationLog.groupBy({
      by: ["status"],
      where: {
        organizationId,
        stepId: null,
        executedAt: { gte: startOfToday },
      },
      _count: { id: true },
    }),
  ]);

  let active = 0;
  let paused = 0;
  for (const row of counts) {
    if (row.active) active = row._count.id;
    else paused = row._count.id;
  }

  let started = 0;
  let completed = 0;
  let finishedWithError = 0;
  for (const row of todayStatus) {
    const n = row._count.id;
    if (row.status === "STARTED") started += n;
    else if (row.status === "COMPLETED") completed += n;
    else if (row.status === "COMPLETED_WITH_ERRORS" || row.status === "FAILED") {
      finishedWithError += n;
    }
  }
  const finished = completed + finishedWithError;

  return {
    total: active + paused,
    active,
    paused,
    runsToday: started,
    avgSuccess: finished > 0 ? Math.round((completed / finished) * 100) : 0,
  };
}

async function buildAutomationListStats(
  ids: string[],
): Promise<Map<string, AutomationListStats>> {
  const out = new Map<string, AutomationListStats>();
  if (ids.length === 0) return out;

  const organizationId = getOrgIdOrThrow();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const todayAgg = await prisma.automationLog.groupBy({
    by: ["automationId", "status"],
    where: {
      organizationId,
      automationId: { in: ids },
      stepId: null,
      executedAt: { gte: startOfToday },
    },
    _count: { id: true },
    _max: { executedAt: true },
  });

  const accum = new Map<
    string,
    {
      started: number;
      completed: number;
      finishedWithError: number;
      lastRunAt: Date | null;
    }
  >();
  for (const row of todayAgg) {
    const cur = accum.get(row.automationId) ?? {
      started: 0,
      completed: 0,
      finishedWithError: 0,
      lastRunAt: null as Date | null,
    };
    const n = row._count.id;
    if (row.status === "STARTED") cur.started += n;
    else if (row.status === "COMPLETED") cur.completed += n;
    else if (row.status === "COMPLETED_WITH_ERRORS" || row.status === "FAILED") {
      cur.finishedWithError += n;
    }
    const at = row._max.executedAt;
    if (at && (!cur.lastRunAt || at > cur.lastRunAt)) cur.lastRunAt = at;
    accum.set(row.automationId, cur);
  }

  for (const id of ids) {
    const a = accum.get(id) ?? {
      started: 0,
      completed: 0,
      finishedWithError: 0,
      lastRunAt: null as Date | null,
    };
    const finished = a.completed + a.finishedWithError;
    const runsToday = a.started || finished;
    out.set(id, {
      runs: runsToday,
      runsToday,
      successRate:
        finished > 0 ? Math.round((a.completed / finished) * 100) : 0,
      lastRunAt: a.lastRunAt ? a.lastRunAt.toISOString() : null,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────
// Picker do agente — automações executáveis manualmente pela conversa.
// Retorna as ATIVAS que são `triggerType='manual'` OU `allowManualRun=true`,
// enriquecidas com preview da mensagem e categoria (para agrupar na modal).
// ─────────────────────────────────────────────────────────────────

export type AgentAutomationItem = {
  id: string;
  name: string;
  description: string | null;
  stepCount: number;
  /// Categoria coarse para agrupar na modal (ex.: "message", "product", "flow").
  category: string;
  categoryLabel: string;
  /// Preview do conteúdo enviado (texto da 1ª etapa de mensagem), para o
  /// agente saber o que está disparando.
  messagePreview: string | null;
};

const AGENT_CATEGORY_LABELS: Record<string, string> = {
  message: "Mensagens",
  media: "Mídia",
  template: "Templates",
  interactive: "Botões",
  product: "Produtos",
  email: "E-mail",
  flow: "Fluxos",
};

function pickAgentCategory(stepType: string): string | null {
  switch (stepType) {
    case "send_whatsapp_message":
      return "message";
    case "send_whatsapp_media":
      return "media";
    case "send_whatsapp_template":
      return "template";
    case "send_whatsapp_interactive":
    case "send_whatsapp_list":
      return "interactive";
    case "send_whatsapp_flow":
      return "flow";
    case "send_product":
      return "product";
    case "send_email":
      return "email";
    default:
      return null;
  }
}

function previewForStep(
  stepType: string,
  config: Record<string, unknown>,
): string | null {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  switch (stepType) {
    case "send_whatsapp_message":
      return str(config.content) || null;
    case "send_whatsapp_media":
      return str(config.caption) || AGENT_CATEGORY_LABELS.media;
    case "send_whatsapp_interactive":
    case "send_whatsapp_list":
      return str(config.body) || null;
    case "send_whatsapp_template":
      return str(config.templateLabel) || str(config.templateName) || null;
    case "send_whatsapp_flow":
      return str(config.flowName) || str(config.body) || AGENT_CATEGORY_LABELS.flow;
    case "send_product":
      return str(config.content) || str(config.productName) || null;
    case "send_email":
      return str(config.subject) || null;
    default:
      return null;
  }
}

export async function getAgentAutomations(): Promise<AgentAutomationItem[]> {
  const organizationId = getOrgIdOrThrow();
  const rows = await prisma.automation.findMany({
    where: {
      organizationId,
      active: true,
      OR: [{ triggerType: "manual" }, { allowManualRun: true }],
    },
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      _count: { select: { steps: true } },
      steps: {
        select: { type: true, config: true },
        orderBy: { position: "asc" },
      },
    },
  });

  return rows.map((a) => {
    // Primeira etapa que "envia" algo define categoria + preview; senão,
    // cai em "flow" (automações sem mensagem — ex.: mover estágio, tags).
    let category = "flow";
    let messagePreview: string | null = null;
    for (const s of a.steps) {
      const cat = pickAgentCategory(s.type);
      if (cat) {
        category = cat;
        const cfg =
          s.config && typeof s.config === "object" && !Array.isArray(s.config)
            ? (s.config as Record<string, unknown>)
            : {};
        messagePreview = previewForStep(s.type, cfg);
        break;
      }
    }
    return {
      id: a.id,
      name: a.name,
      description: a.description,
      stepCount: a._count.steps,
      category,
      categoryLabel: AGENT_CATEGORY_LABELS[category] ?? "Outras",
      messagePreview,
    };
  });
}

export async function getAutomationById(id: string) {
  return prisma.automation.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { position: "asc" } },
    },
  });
}

export type CreateAutomationStepInput = {
  id?: string;
  type: string;
  config: Prisma.InputJsonValue;
};

export type CreateAutomationInput = {
  name: string;
  description?: string | null;
  triggerType: string;
  triggerConfig: Prisma.InputJsonValue;
  active?: boolean;
  allowManualRun?: boolean;
  steps?: CreateAutomationStepInput[];
};

export function validateAutomationTriggerConfig(
  triggerType: string,
  triggerConfig: unknown,
): boolean {
  if (triggerType !== "whatsapp_session_expiring") return true;
  const cfg = asRecord(triggerConfig);
  return cfg !== null && normalizeHoursBeforeExpiry(cfg.hoursBeforeExpiry) !== null;
}

export async function createAutomation(
  data: CreateAutomationInput,
): Promise<Prisma.AutomationGetPayload<{ include: { steps: true } }>> {
  const name = data.name?.trim();
  if (!name) {
    throw new Error("INVALID_NAME");
  }
  if (!validateAutomationTriggerConfig(data.triggerType, data.triggerConfig)) {
    throw new Error("INVALID_TRIGGER_CONFIG");
  }

  const organizationId = getOrgIdOrThrow();
  return prisma.automation.create({
    data: {
      name,
      organizationId,
      description: data.description?.trim() || null,
      triggerType: data.triggerType,
      triggerConfig: data.triggerConfig,
      active: data.active ?? false,
      allowManualRun: data.allowManualRun ?? false,
      steps: {
        create: (data.steps ?? []).map((s, index) => ({
          ...(s.id ? { id: s.id } : {}),
          type: s.type,
          config: s.config,
          position: index,
          organizationId,
        })),
      },
    },
    include: { steps: { orderBy: { position: "asc" } } },
  }) as unknown as Prisma.AutomationGetPayload<{ include: { steps: true } }>;
}

/**
 * Conta canais CONECTADOS da org relevantes para seleção de canal em
 * passos de mensagem: WhatsApp (Meta Cloud API) ou e-mail.
 */
async function countConnectedChannels(type: "WHATSAPP" | "EMAIL"): Promise<number> {
  const organizationId = getOrgIdOrThrow();
  return prisma.channel.count({
    where: {
      organizationId,
      type,
      status: "CONNECTED",
      ...(type === "WHATSAPP" ? { provider: "META_CLOUD_API" } : {}),
    },
  });
}

/**
 * Valida que o PRIMEIRO passo de mensagem do fluxo tem `channelId` quando
 * a org tem 2+ canais conectados do tipo relevante (WhatsApp para a
 * maioria dos steps de mensagem; e-mail para `send_email`). Retorna a
 * mensagem de erro (`MISSING_CHANNEL_ON_FIRST_MESSAGE_STEP`) ou `null`.
 */
async function validateFirstMessageChannelForOrg(
  steps: { type: string; config?: unknown }[],
  opts?: { triggerType?: string; triggerConfig?: unknown },
): Promise<string | null> {
  const idx = findFirstMessageStepIndex(steps);
  if (idx < 0) return null;
  const firstType = steps[idx].type;
  const connectedCount = await countConnectedChannels(
    firstType === "send_email" ? "EMAIL" : "WHATSAPP",
  );
  return validateFirstMessageChannel(steps, connectedCount, opts);
}

export type UpdateAutomationInput = {
  name?: string;
  description?: string | null;
  triggerType?: string;
  triggerConfig?: Prisma.InputJsonValue;
  active?: boolean;
  allowManualRun?: boolean;
  steps?: CreateAutomationStepInput[];
};

export async function updateAutomation(id: string, data: UpdateAutomationInput) {
  const existing = await prisma.automation.findUnique({
    where: { id },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  if (!existing) {
    throw new Error("NOT_FOUND");
  }
  const effectiveTriggerType = data.triggerType ?? existing.triggerType;
  const effectiveTriggerConfig = data.triggerConfig ?? existing.triggerConfig;
  if (!validateAutomationTriggerConfig(effectiveTriggerType, effectiveTriggerConfig)) {
    throw new Error("INVALID_TRIGGER_CONFIG");
  }

  // Seleção de canal: só bloqueia quando a automação FICA ativa (já ativa
  // e steps sendo salvos, ou sendo ativada agora) — desativar ou editar
  // sem tocar steps/active nunca é bloqueado por isso.
  const effectiveActive = data.active !== undefined ? data.active : existing.active;
  if (effectiveActive) {
    const effectiveSteps = data.steps ?? existing.steps.map((s) => ({ type: s.type, config: s.config }));
    const channelErr = await validateFirstMessageChannelForOrg(effectiveSteps, {
      triggerType: effectiveTriggerType,
      triggerConfig: effectiveTriggerConfig,
    });
    if (channelErr) throw new Error(channelErr);
  }

  const organizationId = getOrgIdOrThrow();

  return prisma.$transaction(async (tx) => {
    const updateData: Prisma.AutomationUpdateInput = {};
    if (data.name !== undefined) {
      const trimmed = data.name.trim();
      if (!trimmed) throw new Error("INVALID_NAME");
      updateData.name = trimmed;
    }
    if (data.description !== undefined) {
      updateData.description = data.description === null ? null : data.description.trim() || null;
    }
    if (data.triggerType !== undefined) {
      updateData.triggerType = data.triggerType;
    }
    if (data.triggerConfig !== undefined) {
      updateData.triggerConfig = data.triggerConfig;
    }
    if (data.active !== undefined) {
      updateData.active = data.active;
    }
    if (data.allowManualRun !== undefined) {
      updateData.allowManualRun = data.allowManualRun;
    }

    if (Object.keys(updateData).length > 0) {
      await tx.automation.update({ where: { id }, data: updateData });
    }

    // Replace atômico: deleteMany + createMany no step (não nested create
    // no parent). O nested `steps: { create }` depois de um deleteMany
    // separado fazia o Prisma ACUMULAR cópias a cada Salvar.
    if (data.steps) {
      await tx.automationStep.deleteMany({ where: { automationId: id } });

      const providedIds = data.steps
        .map((s) => (typeof s.id === "string" ? s.id.trim() : ""))
        .filter(Boolean);
      const takenIds = new Set<string>();
      if (providedIds.length > 0) {
        const foreign = await tx.automationStep.findMany({
          where: { id: { in: providedIds }, automationId: { not: id } },
          select: { id: true },
        });
        for (const row of foreign) takenIds.add(row.id);
      }

      const prepared = prepareStepsForReplace(data.steps, takenIds);
      if (prepared.length > 0) {
        await tx.automationStep.createMany({
          data: prepared.map((s, index) => ({
            id: s.id!,
            type: s.type,
            config: s.config,
            position: index,
            organizationId,
            automationId: id,
          })),
        });
      }
    }

    const saved = await tx.automation.findUnique({
      where: { id },
      include: { steps: { orderBy: { position: "asc" } } },
    });
    if (!saved) throw new Error("NOT_FOUND");
    return saved;
  });
}

export async function deleteAutomation(id: string) {
  await prisma.automation.delete({ where: { id } });
}

export async function toggleAutomation(id: string) {
  const existing = await prisma.automation.findUnique({
    where: { id },
    select: {
      id: true,
      active: true,
      triggerType: true,
      triggerConfig: true,
      steps: { select: { type: true, config: true }, orderBy: { position: "asc" } },
    },
  });
  if (!existing) {
    throw new Error("NOT_FOUND");
  }
  const activating = !existing.active;
  if (activating) {
    const channelErr = await validateFirstMessageChannelForOrg(existing.steps, {
      triggerType: existing.triggerType,
      triggerConfig: existing.triggerConfig,
    });
    if (channelErr) throw new Error(channelErr);
  }
  return prisma.automation.update({
    where: { id },
    data: { active: activating },
    include: { steps: { orderBy: { position: "asc" } } },
  });
}

export type GetAutomationLogsParams = {
  page?: number;
  perPage?: number;
  stepId?: string | null;
  statuses?: string[] | null;
};

const ALLOWED_LOG_STATUSES = new Set([
  "STARTED",
  "SUCCESS",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "SKIPPED",
  "FAILED",
  "FAILED_HANDLED",
]);

function normalizeLogStatuses(statuses?: string[] | null): string[] | undefined {
  if (!statuses?.length) return undefined;
  const next = [
    ...new Set(
      statuses
        .map((s) => s.trim().toUpperCase())
        .filter((s) => ALLOWED_LOG_STATUSES.has(s)),
    ),
  ];
  return next.length ? next : undefined;
}

export async function getAutomationLogs(automationId: string, params: GetAutomationLogsParams = {}) {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.min(100, Math.max(1, params.perPage ?? 20));
  const skip = (page - 1) * perPage;
  const statuses = normalizeLogStatuses(params.statuses);

  const where: Prisma.AutomationLogWhereInput = { automationId };
  if (params.stepId === "trigger") {
    // STARTED é o eco do disparo; a linha útil do card é o desfecho.
    where.stepId = null;
    where.status = statuses ? { in: statuses } : { not: "STARTED" };
  } else if (params.stepId) {
    where.stepId = params.stepId;
    if (statuses) where.status = { in: statuses };
  } else if (statuses) {
    where.status = { in: statuses };
  }

  const [items, total] = await Promise.all([
    prisma.automationLog.findMany({
      where,
      skip,
      take: perPage,
      orderBy: { executedAt: "desc" },
      include: {
        metaWebhookEvent: {
          select: {
            id: true,
            receivedAt: true,
            eventType: true,
            objectType: true,
            phoneNumberId: true,
            waMessageId: true,
            fromPhone: true,
            signatureValid: true,
            processed: true,
            processingError: true,
          },
        },
      },
    }).then(async (logs) => {
      // Enriquece com nome/telefone/negócio + ad-tracking. O log só
      // guarda IDs; a modal de erros precisa do rótulo para busca.
      const contactIds = Array.from(
        new Set(
          logs
            .map((l) => l.contactId)
            .filter((v): v is string => typeof v === "string"),
        ),
      );
      const dealIds = Array.from(
        new Set(
          logs
            .map((l) => l.dealId)
            .filter((v): v is string => typeof v === "string"),
        ),
      );
      const [contacts, deals] = await Promise.all([
        contactIds.length === 0
          ? Promise.resolve([])
          : prisma.contact.findMany({
              where: { id: { in: contactIds } },
              select: {
                id: true,
                name: true,
                phone: true,
                number: true,
                adSourceId: true,
                adSourceType: true,
                adCtwaClid: true,
                adHeadline: true,
                adResolvedId: true,
                adResolvedName: true,
                adResolvedAdsetId: true,
                adResolvedAdsetName: true,
                adResolvedCampaignId: true,
                adResolvedCampaignName: true,
                adResolvedAt: true,
                adResolveStatus: true,
                adResolveError: true,
                adUtmSource: true,
                adUtmMedium: true,
                adUtmCampaign: true,
                adUtmContent: true,
                adUtmTerm: true,
              },
            }),
        dealIds.length === 0
          ? Promise.resolve([])
          : prisma.deal.findMany({
              where: { id: { in: dealIds } },
              select: { id: true, title: true, number: true },
            }),
      ]);
      const contactById = new Map(contacts.map((c) => [c.id, c]));
      const dealById = new Map(deals.map((d) => [d.id, d]));
      return logs.map((l) => {
        const contact = l.contactId ? contactById.get(l.contactId) : undefined;
        const deal = l.dealId ? dealById.get(l.dealId) : undefined;
        return {
          ...l,
          contactName: contact?.name ?? null,
          contactPhone: contact?.phone ?? null,
          dealName: deal?.title ?? null,
          dealNumber: deal?.number ?? null,
          contactAdTracking: contact ?? null,
        };
      });
    }),
    prisma.automationLog.count({ where }),
  ]);

  return { items, total, page, perPage };
}

export async function enqueueAutomation(automationId: string, context: AutomationJobContext) {
  return enqueueAutomationJob({ automationId, context });
}
