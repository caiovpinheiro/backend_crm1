/**
 * Worker da agenda do agente v2 (retomada agendada e follow-up por etapa).
 * Roda no mesmo tick da inatividade (`ai-agent-inactivity-worker.ts`):
 *
 * 1. SENDING parado além do lease → FAILED ("interrupted"). Nunca volta a
 *    PENDING: antes perder um envio do que mandar duas vezes.
 * 2. Planeja o próximo passo das réguas (uma linha por passo, chave única).
 * 3. Envia o que venceu: trava PENDING→SENDING, confere tudo de novo
 *    (`decideAgendaSend`) e manda texto (24 h / Baileys) ou modelo da Meta.
 *
 * Cross-tenant: as consultas usam `prismaBase` com `organizationId`
 * explícito, como o worker de inatividade; o envio roda dentro do contexto
 * da org (`withSystemContext`). Nenhum domínio de cliente.
 */

import { randomUUID } from "node:crypto";
import { normalizeV2Config } from "@/lib/ai-v2/config";
import { buildVariableMap, defaultFormatter, renderMessage } from "@/lib/ai-v2/message-render";
import type { V2AgentConfig, V2FollowUpSequence } from "@/lib/ai-v2/types";
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import {
  AGENDA_SENDING_LEASE_MS,
  AGENT_CLOSE_REASONS,
  FOLLOWUP_STEP_FALLBACK_MESSAGE,
  SCHEDULE_FALLBACK_MESSAGE,
  agendaTimezone,
  decideAgendaSend,
  followUpKey,
  isOptOut,
  matchSequence,
  planFollowUp,
  rankTemplates,
  sortedSteps,
  templateCandidates,
  type AgendaOutcome,
  type AgendaRowLite,
  type AgentTemplateRow,
  type TemplateCandidate,
} from "./agenda";

const log = getLogger("ai-v2.agenda");

const DAY_MS = 24 * 60 * 60 * 1000;
/** Âncora mais velha que isto não entra no planejamento (passos ≤ 30 dias + "no fim" ≤ 30 dias). */
const PLAN_LOOKBACK_DAYS = 62;

// prismaBase: worker cross-tenant (todas as orgs num tick), como a inatividade.
const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

let tableCheck: { at: number; ok: boolean } | null = null;

/**
 * A tabela já existe? Código no ar antes da migration (operador roda o
 * `migrate deploy` depois) não pode derrubar a inatividade nem o tick:
 * sem tabela, a agenda fica parada. Conferido a cada 5 min.
 */
export async function agendaTableReady(now = Date.now()): Promise<boolean> {
  if (tableCheck && now - tableCheck.at < 5 * 60_000) return tableCheck.ok;
  try {
    const [r] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT to_regclass('public.ai_v2_scheduled_sends') IS NOT NULL AS ok`,
    );
    tableCheck = { at: now, ok: r?.ok === true };
  } catch {
    tableCheck = { at: now, ok: false };
  }
  return tableCheck.ok;
}

export function resetAgendaTableCheckForTest(): void {
  tableCheck = null;
}

export type AgendaRow = {
  id: string;
  organizationId: string;
  conversationId: string;
  contactId: string;
  agentId: string;
  agentUserId: string;
  kind: "scheduled" | "followup";
  sequenceId: string | null;
  stepIndex: number | null;
  anchorMessageId: string | null;
  dealId: string | null;
  dealStageIdAtCreate: string | null;
  dueAt: Date;
  reason: string | null;
  resumeContext: string | null;
  createdAt: Date;
};

// ───────────────────────── estado das linhas ─────────────────────────

/** Só a dona do SENDING muda a linha. */
async function finish(id: string, status: "SENT" | "CANCELLED" | "SKIPPED" | "FAILED", fields: {
  outcome?: AgendaOutcome | null;
  sentVia?: string;
  templateName?: string | null;
  sentMessageId?: string | null;
  lastError?: string | null;
} = {}): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_scheduled_sends"
        SET "status" = $2, "outcome" = $3, "sentVia" = $4, "templateName" = $5, "sentMessageId" = $6,
            "lastError" = $7,
            "sentAt" = CASE WHEN $2 = 'SENT' THEN now() ELSE "sentAt" END,
            "cancelledAt" = CASE WHEN $2 IN ('CANCELLED','SKIPPED') THEN now() ELSE "cancelledAt" END,
            "updatedAt" = now()
      WHERE "id" = $1 AND "status" = 'SENDING'`,
    id,
    status,
    fields.outcome ?? null,
    fields.sentVia ?? null,
    fields.templateName ?? null,
    fields.sentMessageId ?? null,
    fields.lastError ? fields.lastError.slice(0, 500) : null,
  );
}

async function reschedule(id: string, at: Date): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_scheduled_sends" SET "status" = 'PENDING', "dueAt" = $2, "updatedAt" = now()
      WHERE "id" = $1 AND "status" = 'SENDING'`,
    id,
    at,
  );
}

/** PENDING → SENDING: só uma passada recebe 1. */
export async function claimAgendaRow(id: string): Promise<boolean> {
  const n = await db.$executeRawUnsafe(
    `UPDATE "ai_v2_scheduled_sends" SET "status" = 'SENDING', "updatedAt" = now()
      WHERE "id" = $1 AND "status" = 'PENDING'`,
    id,
  );
  return n === 1;
}

/** SENDING parado (processo caiu no meio) → FAILED. Não reenvia. */
export async function failStaleSending(now: Date): Promise<number> {
  return db.$executeRawUnsafe(
    `UPDATE "ai_v2_scheduled_sends"
        SET "status" = 'FAILED', "outcome" = 'interrupted', "lastError" = 'envio interrompido; não reenviado', "updatedAt" = now()
      WHERE "status" = 'SENDING' AND "updatedAt" < $1`,
    new Date(now.getTime() - AGENDA_SENDING_LEASE_MS),
  );
}

// ───────────────────────── planejamento da régua ─────────────────────────

type PlanCandidate = {
  conversation_id: string;
  organization_id: string;
  contact_id: string;
  agent_user_id: string;
  agent_config_id: string;
  simple_config: unknown;
  last_inbound_at: Date | null;
  last_out_id: string;
  last_out_at: Date;
  deal_id: string | null;
  deal_stage_id: string | null;
  stage_name: string | null;
  pipeline_name: string | null;
};

/**
 * Conversas em que a régua pode andar: agente v2 com régua configurada, a
 * última mensagem é do agente, o cliente não respondeu depois, o ticket
 * está com o agente (aberto, ou encerrado pelo próprio agente) e é o ticket
 * mais recente do contato. Sem passo aberto (PENDING/SENDING).
 */
async function listPlanCandidates(now: Date): Promise<PlanCandidate[]> {
  return db.$queryRawUnsafe<PlanCandidate[]>(
    `SELECT c."id" AS conversation_id, c."organizationId" AS organization_id, c."contactId" AS contact_id,
            c."assignedToId" AS agent_user_id, a."id" AS agent_config_id, a."simpleConfig" AS simple_config,
            c."lastInboundAt" AS last_inbound_at, last_out."id" AS last_out_id, last_out."createdAt" AS last_out_at,
            d."id" AS deal_id, d."stageId" AS deal_stage_id, st."name" AS stage_name, p."name" AS pipeline_name
       FROM "conversations" c
       JOIN "users" u ON u."id" = c."assignedToId" AND u."type" = 'AI'
       JOIN "ai_agent_configs" a ON a."userId" = u."id" AND a."active" = true AND a."engine" = 'simple'
       LEFT JOIN "ai_simple_conversation_states" s ON s."conversationId" = c."id"
       JOIN LATERAL (
         SELECT m."id", m."createdAt", m."aiAgentUserId" FROM "messages" m
          WHERE m."conversationId" = c."id" AND m."direction" = 'out'
            AND COALESCE(m."isPrivate", false) = false AND m."messageType" <> 'note'
          ORDER BY m."createdAt" DESC LIMIT 1
       ) last_out ON true
       JOIN LATERAL (
         SELECT dd."id", dd."stageId" FROM "deals" dd
          WHERE dd."status" = 'OPEN' AND dd."organizationId" = c."organizationId"
            AND (dd."id" = s."selectedDealId" OR dd."contactId" = c."contactId")
          ORDER BY COALESCE(dd."id" = s."selectedDealId", false) DESC, dd."updatedAt" DESC
          LIMIT 1
       ) d ON true
       LEFT JOIN "stages" st ON st."id" = d."stageId"
       LEFT JOIN "pipelines" p ON p."id" = st."pipelineId"
      WHERE jsonb_typeof(a."simpleConfig"->'followUpSequences') = 'array'
        AND jsonb_array_length(a."simpleConfig"->'followUpSequences') > 0
        AND c."updatedAt" > $1::timestamptz - make_interval(days => ${PLAN_LOOKBACK_DAYS})
        AND last_out."aiAgentUserId" = c."assignedToId"
        AND (c."lastInboundAt" IS NULL OR c."lastInboundAt" <= last_out."createdAt")
        AND ((c."status" <> 'RESOLVED' AND (s."id" IS NULL OR s."owner" <> 'pessoa'))
          OR (c."status" = 'RESOLVED' AND s."stage" = 'closed' AND s."closeReason" = ANY($2::text[])))
        AND NOT EXISTS (
          SELECT 1 FROM "ai_v2_scheduled_sends" x
           WHERE x."conversationId" = c."id" AND x."kind" = 'followup' AND x."status" IN ('PENDING','SENDING'))
        AND NOT EXISTS (
          SELECT 1 FROM "conversations" c2
           WHERE c2."contactId" = c."contactId" AND c2."id" <> c."id" AND c2."createdAt" > c."createdAt")
      ORDER BY last_out."createdAt" DESC
      LIMIT 300`,
    now,
    [...AGENT_CLOSE_REASONS],
  );
}

type FollowUpRowDb = AgendaRowLite & { anchorAt: Date | null; sentMessageId: string | null };

async function followUpRowsSince(conversationId: string, since: Date | null): Promise<FollowUpRowDb[]> {
  return db.$queryRawUnsafe<FollowUpRowDb[]>(
    `SELECT "stepIndex", "status", "outcome", "anchorMessageId", "anchorAt", "sentAt", "sentMessageId", "sequenceId", "sentVia"
       FROM "ai_v2_scheduled_sends"
      WHERE "conversationId" = $1 AND "kind" = 'followup' AND "createdAt" > $2
      ORDER BY "createdAt" ASC`,
    conversationId,
    since ?? new Date(0),
  );
}

/**
 * De onde a régua conta: a última mensagem do agente que não saiu da
 * própria régua. Se a última é um passo (reconhecido pelo id gravado), a
 * âncora é a desse passo.
 */
export function followUpAnchor(
  lastOut: { id: string; at: Date },
  rows: Array<Pick<FollowUpRowDb, "sentMessageId" | "anchorMessageId" | "anchorAt">>,
): { id: string; at: Date } {
  const own = rows.find((r) => r.sentMessageId && r.sentMessageId === lastOut.id);
  if (own?.anchorMessageId && own.anchorAt) return { id: own.anchorMessageId, at: new Date(own.anchorAt) };
  return lastOut;
}

async function insertFollowUpRow(c: PlanCandidate, seq: V2FollowUpSequence, anchor: { id: string; at: Date }, stepIndex: number, dueAt: Date, skipped: boolean): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_v2_scheduled_sends"
       ("id","organizationId","conversationId","contactId","agentId","agentUserId","kind","sequenceId","stepIndex",
        "anchorMessageId","anchorAt","dealId","dealStageIdAtCreate","dueAt","status","outcome","cancelledAt","idempotencyKey","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,'followup',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now())
     ON CONFLICT DO NOTHING`,
    randomUUID(),
    c.organization_id,
    c.conversation_id,
    c.contact_id,
    c.agent_config_id,
    c.agent_user_id,
    seq.id,
    stepIndex,
    anchor.id,
    anchor.at,
    c.deal_id,
    c.deal_stage_id,
    dueAt,
    skipped ? "SKIPPED" : "PENDING",
    skipped ? "late" : null,
    skipped ? new Date() : null,
    followUpKey(c.conversation_id, seq.id, anchor.id, stepIndex),
  );
}

export async function planFollowUpsV2(now: Date): Promise<number> {
  const candidates = await listPlanCandidates(now);
  let planned = 0;
  for (const c of candidates) {
    let config: V2AgentConfig;
    try {
      config = normalizeV2Config(c.simple_config);
    } catch {
      continue;
    }
    const seq = matchSequence(config, { stageId: c.deal_stage_id, stageName: c.stage_name, pipelineName: c.pipeline_name });
    if (!seq) continue;
    try {
      const rows = await followUpRowsSince(c.conversation_id, c.last_inbound_at ? new Date(c.last_inbound_at) : null);
      const anchor = followUpAnchor({ id: c.last_out_id, at: new Date(c.last_out_at) }, rows);
      const plan = planFollowUp({
        sequence: seq,
        anchorMessageId: anchor.id,
        anchorAt: anchor.at,
        rows,
        now,
        window: config.autoSend?.sendWindow,
        timeZone: agendaTimezone(config),
      });
      if (plan.action === "none") continue;
      await insertFollowUpRow(c, seq, anchor, plan.stepIndex, plan.action === "plan" ? plan.dueAt : now, plan.action === "skip");
      if (plan.action === "plan") planned++;
    } catch (err) {
      log.warn({ conv: c.conversation_id, err: err instanceof Error ? err.message : err }, "[ai-v2 agenda] planejamento falhou");
    }
  }
  return planned;
}

// ───────────────────────── envio ─────────────────────────

async function listDue(now: Date): Promise<AgendaRow[]> {
  return db.$queryRawUnsafe<AgendaRow[]>(
    `SELECT "id","organizationId","conversationId","contactId","agentId","agentUserId","kind","sequenceId","stepIndex",
            "anchorMessageId","dealId","dealStageIdAtCreate","dueAt","reason","resumeContext","createdAt"
       FROM "ai_v2_scheduled_sends"
      WHERE "status" = 'PENDING' AND "dueAt" <= $1
      ORDER BY "dueAt" ASC
      LIMIT 50`,
    now,
  );
}

type ConvRow = {
  status: string;
  assigned_to_id: string | null;
  assigned_to_type?: string | null;
  last_inbound_at: Date | null;
  channel: string | null;
  provider: string | null;
  contact_name: string | null;
  contact_phone: string | null;
};

const META_CHANNELS = new Set(["whatsapp", "whatsapp_meta", "meta_whatsapp"]);

function channelKindOf(conv: Pick<ConvRow, "channel" | "provider">): "meta" | "baileys" | "other" {
  if (conv.provider === "BAILEYS_MD") return "baileys";
  return META_CHANNELS.has((conv.channel ?? "").toLowerCase()) ? "meta" : "other";
}

async function loadSnapshotData(row: AgendaRow, optOutDays: number) {
  const [conv] = await db.$queryRawUnsafe<ConvRow[]>(
    `SELECT c."status", c."assignedToId" AS assigned_to_id, u."type"::text AS assigned_to_type, c."lastInboundAt" AS last_inbound_at, c."channel",
            ch."provider", ct."name" AS contact_name, ct."phone" AS contact_phone
       FROM "conversations" c
       LEFT JOIN "channels" ch ON ch."id" = c."channelId"
       LEFT JOIN "contacts" ct ON ct."id" = c."contactId"
       LEFT JOIN "users" u ON u."id" = c."assignedToId"
      WHERE c."id" = $1 AND c."organizationId" = $2`,
    row.conversationId,
    row.organizationId,
  );
  const [state] = await db.$queryRawUnsafe<Array<{ owner: string | null; stage: string | null; closeReason: string | null }>>(
    `SELECT "owner", "stage", "closeReason" FROM "ai_simple_conversation_states" WHERE "conversationId" = $1`,
    row.conversationId,
  );
  // Mensagens do cliente em qualquer ticket do contato: depois da linha (voltou
  // a falar) e nos últimos dias (pediu para parar).
  const since = new Date(Math.min(new Date(row.createdAt).getTime(), Date.now() - optOutDays * DAY_MS));
  const inbound = await db.$queryRawUnsafe<Array<{ content: string | null; createdAt: Date }>>(
    `SELECT m."content", m."createdAt" FROM "messages" m
       JOIN "conversations" c2 ON c2."id" = m."conversationId"
      WHERE c2."contactId" = $1 AND c2."organizationId" = $2 AND m."direction" = 'in' AND m."createdAt" > $3
      ORDER BY m."createdAt" DESC LIMIT 200`,
    row.contactId,
    row.organizationId,
    since,
  );
  // Pessoa da equipe que escreveu depois da última mensagem do agente (sem
  // mensagem do agente, depois da criação da linha).
  const [human] = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM "messages"
      WHERE "conversationId" = $1 AND "direction" = 'out' AND "authorType" = 'human'
        AND COALESCE("isPrivate", false) = false
        AND "createdAt" > COALESCE(
          (SELECT MAX(a."createdAt") FROM "messages" a
            WHERE a."conversationId" = $1 AND a."direction" = 'out' AND a."authorType" = 'bot' AND a."aiAgentUserId" = $3),
          $2)`,
    row.conversationId,
    row.createdAt,
    row.agentUserId,
  );
  // Automações e campanhas (robô sem agente de IA) também contam no teto do dia.
  const [automation] = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM "messages"
      WHERE "conversationId" = $1 AND "direction" = 'out' AND "authorType" = 'bot' AND "aiAgentUserId" IS NULL
        AND COALESCE("isPrivate", false) = false AND "messageType" <> 'note' AND "createdAt" > $2`,
    row.conversationId,
    new Date(Date.now() - DAY_MS),
  );
  const [deal] = row.dealId
    ? await db.$queryRawUnsafe<Array<{ status: string | null; stageId: string | null }>>(
        `SELECT "status"::text AS status, "stageId" FROM "deals" WHERE "id" = $1 AND "organizationId" = $2`,
        row.dealId,
        row.organizationId,
      )
    : [];
  const [sent] = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM "ai_v2_scheduled_sends"
      WHERE "conversationId" = $1 AND "status" = 'SENT' AND "sentVia" IN ('text','template') AND "sentAt" > $2`,
    row.conversationId,
    new Date(Date.now() - DAY_MS),
  );
  const [agent] = await db.$queryRawUnsafe<Array<{ active: boolean; simpleConfig: unknown; userId: string }>>(
    `SELECT "active", "simpleConfig", "userId" FROM "ai_agent_configs" WHERE "id" = $1 AND "organizationId" = $2`,
    row.agentId,
    row.organizationId,
  );
  return { conv: conv ?? null, state: state ?? null, inbound, humanCount: human?.n ?? 0, automationLast24h: automation?.n ?? 0, deal: deal ?? null, sentLast24h: sent?.n ?? 0, agent: agent ?? null };
}

/** Número dentro da lista de teste do agente (vazia = qualquer um). */
async function agentPhoneAllowed(config: V2AgentConfig, phone: string | null): Promise<boolean> {
  const allowed = config.allowedPhoneNumbers ?? [];
  if (allowed.length === 0) return true;
  if (!phone) return false;
  const { normalizePhoneDigits, phoneMatchesAllowlist } = await import("@/services/ai/phone-allowlist");
  return phoneMatchesAllowlist(phone, new Set(allowed.map((a) => normalizePhoneDigits(a)).filter(Boolean)));
}

const WRITER_SYSTEM = [
  "Você escreve UMA mensagem curta para retomar um atendimento por mensagem com um cliente.",
  "Até 2 frases, no tom do atendente. Retome o ponto combinado ou em que a conversa parou e convide o cliente a continuar.",
  "Não traga informação nova, não cite números, datas, valores, prazos ou links, não prometa nada e não se despeça.",
  "Responda só com o texto da mensagem.",
].join(" ");

/** Texto escrito pelo agente com as últimas mensagens e o motivo; null = usa o texto fixo. */
async function writeAgendaMessage(config: V2AgentConfig, agentConfigId: string, conversationId: string, purpose: string): Promise<string | null> {
  try {
    const { tryGetAgentApiKey } = await import("@/services/ai/agent-key");
    const apiKey = await tryGetAgentApiKey(agentConfigId).catch(() => null);
    if (!apiKey) return null;
    const rows = await db.$queryRawUnsafe<Array<{ direction: string; content: string | null }>>(
      `SELECT m."direction", m."content" FROM "messages" m
        WHERE m."conversationId" = $1 AND COALESCE(m."isPrivate", false) = false AND m."messageType" <> 'note'
        ORDER BY m."createdAt" DESC LIMIT 8`,
      conversationId,
    );
    const history = rows.reverse().filter((r) => r.content?.trim())
      .map((r) => `${r.direction === "out" ? "Atendente" : "Cliente"}: ${String(r.content).slice(0, 500)}`).join("\n");
    const { generateWithTools } = await import("@/services/ai/provider");
    const { v2FastAuxModel } = await import("@/lib/ai-v2/models");
    const res = await generateWithTools({
      model: v2FastAuxModel(config.model),
      apiKey,
      system: `${WRITER_SYSTEM}${config.tone ? ` Tom do atendente: ${config.tone}.` : ""}`,
      messages: [{ role: "user", content: `${purpose ? `Motivo da retomada: ${purpose.slice(0, 400)}\n\n` : ""}Conversa:\n${history || "(sem mensagens)"}` }] as never,
      temperature: 0.3,
      maxOutputTokens: 120,
      maxSteps: 1,
    });
    const { acceptableGeneratedFollowUp } = await import("./inactivity");
    return acceptableGeneratedFollowUp(res.text);
  } catch {
    return null;
  }
}

/** Entre vários modelos, o agente escolhe o que melhor serve ao envio; reserva: afinidade de palavras. */
export async function chooseTemplate(config: V2AgentConfig, agentConfigId: string, candidates: TemplateCandidate[], purpose: string): Promise<TemplateCandidate | null> {
  if (candidates.length === 0) return null;
  const ranked = rankTemplates(candidates, purpose);
  if (ranked.length === 1) return ranked[0];
  try {
    const { tryGetAgentApiKey } = await import("@/services/ai/agent-key");
    const apiKey = await tryGetAgentApiKey(agentConfigId).catch(() => null);
    if (!apiKey) return ranked[0];
    const { generateWithTools } = await import("@/services/ai/provider");
    const { v2FastAuxModel } = await import("@/lib/ai-v2/models");
    const list = ranked.slice(0, 12).map((t, i) => `${i + 1}. ${t.name}${t.purpose ? ` — ${t.purpose}` : ""}${t.preview ? `\n   Texto: ${t.preview.slice(0, 300)}` : ""}`).join("\n");
    const res = await generateWithTools({
      model: v2FastAuxModel(config.model),
      apiKey,
      system: "Escolha o modelo de mensagem que melhor retoma o contato com o cliente para o motivo dado. Responda só com o número do modelo.",
      messages: [{ role: "user", content: `Motivo: ${purpose.slice(0, 400) || "retomar o atendimento"}\n\nModelos:\n${list}` }] as never,
      temperature: 0,
      maxOutputTokens: 5,
      maxSteps: 1,
    });
    const n = Number(String(res.text ?? "").match(/\d+/)?.[0]);
    return Number.isInteger(n) && n >= 1 && n <= Math.min(12, ranked.length) ? ranked[n - 1] : ranked[0];
  } catch {
    return ranked[0];
  }
}

async function agentTemplates(organizationId: string): Promise<AgentTemplateRow[]> {
  return db.$queryRawUnsafe<AgentTemplateRow[]>(
    `SELECT "meta_template_name" AS name, "language", "label", "body_preview" AS "bodyPreview", "has_variables" AS "hasVariables"
       FROM "whatsapp_template_configs"
      WHERE "organizationId" = $1 AND "agent_enabled" = true AND "hidden_at" IS NULL
      ORDER BY "updatedAt" DESC LIMIT 50`,
    organizationId,
  );
}

async function lastAgentMessageId(conversationId: string, agentUserId: string, since: Date): Promise<string | null> {
  const [m] = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "messages"
      WHERE "conversationId" = $1 AND "direction" = 'out' AND "aiAgentUserId" = $2 AND "createdAt" >= $3
      ORDER BY "createdAt" DESC LIMIT 1`,
    conversationId,
    agentUserId,
    new Date(since.getTime() - 2000),
  );
  return m?.id ?? null;
}

/**
 * Ticket encerrado pelo próprio agente: volta a abrir com o agente, depois
 * do envio, para a resposta do cliente cair aqui com o histórico.
 */
async function reopenForAgent(row: AgendaRow): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { upsertV2ConversationState } = await import("./state");
  await prisma.conversation.updateMany({
    where: { id: row.conversationId, status: "RESOLVED" },
    data: { status: "OPEN", closedAt: null },
  });
  await upsertV2ConversationState({
    organizationId: row.organizationId,
    conversationId: row.conversationId,
    agentId: row.agentId,
    stage: "active",
    owner: "agente",
    postCloseWindowEndAt: null,
    closeReason: null,
  });
}

function autonomy(config: V2AgentConfig): "AUTONOMOUS" | "DRAFT" {
  return config.autonomyMode === "auto" ? "AUTONOMOUS" : "DRAFT";
}

type DispatchResult = "sent" | "cancelled" | "skipped" | "rescheduled" | "failed";

/** Uma linha vencida (já em SENDING). Exportado para os testes. */
export async function dispatchAgendaRow(row: AgendaRow, now: Date): Promise<DispatchResult> {
  const [{ traceStep }, { logV2Turn }] = await Promise.all([import("./trace"), import("./log")]);
  const data0 = await db.$queryRawUnsafe<Array<{ simpleConfig: unknown }>>(
    `SELECT "simpleConfig" FROM "ai_agent_configs" WHERE "id" = $1 AND "organizationId" = $2`,
    row.agentId,
    row.organizationId,
  );
  let config: V2AgentConfig | null = null;
  try {
    config = data0[0] ? normalizeV2Config(data0[0].simpleConfig) : null;
  } catch {
    config = null;
  }
  const data = await loadSnapshotData(row, config?.autoSend?.optOutDays ?? 30);
  const seq = row.kind === "followup" ? (config?.followUpSequences ?? []).find((s) => s.id === row.sequenceId) ?? null : null;
  const steps = seq ? sortedSteps(seq) : [];
  const isEnd = row.kind === "followup" && seq != null && row.stepIndex === steps.length;
  const configured = row.kind === "scheduled"
    ? config?.scheduling?.enabled === true
    : !!seq && seq.enabled !== false && (isEnd ? (seq.onEnd?.action ?? "none") !== "none" : (row.stepIndex ?? -1) < steps.length);
  const createdAt = new Date(row.createdAt);
  const decision = decideAgendaSend({
    kind: row.kind,
    now,
    createdAt,
    conversation: data.conv
      ? { status: data.conv.status, assignedToId: data.conv.assigned_to_id, channelKind: channelKindOf(data.conv), lastInboundAt: data.conv.last_inbound_at ? new Date(data.conv.last_inbound_at) : null }
      : null,
    agentUserId: row.agentUserId,
    agentActive: data.agent?.active === true && data.agent.userId === row.agentUserId,
    configured,
    state: data.state,
    inboundSinceCreated: data.inbound.filter((m) => new Date(m.createdAt).getTime() > createdAt.getTime()).map((m) => m.content ?? ""),
    humanOutboundAfterAgent: data.humanCount > 0,
    assignedToOtherAi: !!data.conv?.assigned_to_id && data.conv.assigned_to_id !== row.agentUserId && data.conv.assigned_to_type === "AI",
    deal: data.deal,
    dealStageIdAtCreate: row.dealStageIdAtCreate,
    stopOnStageChange: row.kind === "followup" ? seq?.stopOnStageChange !== false : config?.scheduling?.stopOnStageChange === true,
    phoneAllowed: config ? await agentPhoneAllowed(config, data.conv?.contact_phone ?? null) : false,
    optedOut: data.inbound.some((m) => isOptOut(m.content, config?.autoSend?.optOutTerms)),
    // O "no fim" não conta no teto de envios.
    sentLast24h: isEnd ? 0 : data.sentLast24h,
    automationSentLast24h: isEnd ? 0 : data.automationLast24h,
    maxPerDay: config?.autoSend?.maxPerDay ?? 2,
    window: config?.autoSend?.sendWindow,
    timeZone: config ? agendaTimezone(config) : "America/Sao_Paulo",
  });
  const label = row.kind === "scheduled" ? "Retomada agendada" : `Follow-up "${seq?.name || row.sequenceId}" passo ${(row.stepIndex ?? 0) + 1}`;

  if (decision.action === "cancel") {
    traceStep("agenda", `${label} cancelada: ${decision.outcome}`);
    await finish(row.id, "CANCELLED", { outcome: decision.outcome });
    log.info({ id: row.id, conv: row.conversationId, outcome: decision.outcome }, "[ai-v2 agenda] cancelado");
    return "cancelled";
  }
  if (decision.action === "reschedule") {
    await reschedule(row.id, decision.at);
    return "rescheduled";
  }
  if (!config || !data.conv) {
    await finish(row.id, "CANCELLED", { outcome: "agent_off" });
    return "cancelled";
  }

  const contactName = data.conv.contact_name ?? "";
  const vars = buildVariableMap(config.variables, null, null, { id: row.contactId, name: contactName, firstName: contactName.trim().split(/\s+/)[0] ?? "" });
  const channel = channelKindOf(data.conv) === "baileys" ? "baileys" : "meta";
  const startedAt = new Date();
  const purpose = row.kind === "scheduled"
    ? [row.reason, row.resumeContext].filter(Boolean).join(" — ")
    : seq?.name ?? "";
  const step = !isEnd && seq ? steps[row.stepIndex ?? 0] : null;

  const sendText = async (text: string) => {
    const { sendV2TextMessage, v2HumanBehavior } = await import("./actions");
    return sendV2TextMessage({
      conversationId: row.conversationId,
      contactId: row.contactId,
      agentUserId: row.agentUserId,
      text,
      channel,
      autonomyMode: autonomy(config!),
      humanBehavior: v2HumanBehavior(config!),
      // Responsável humano que ainda não falou não barra o passo.
      bypassAssignee: data.conv!.assigned_to_id !== row.agentUserId,
    });
  };
  const turnLog = (reply: string | undefined, executed: Array<{ action: { type: string; [k: string]: unknown }; ok: boolean }>, extra: { handoff?: boolean; closed?: boolean; owner?: "agente" | "pessoa" } = {}) =>
    logV2Turn({
      organizationId: row.organizationId,
      conversationId: row.conversationId,
      agentId: row.agentId,
      inboundText: "",
      crmContext: { contact: null, deals: [], selectedDeal: null, fields: { contact: [], deal: [] } },
      prompt: row.kind === "scheduled" ? "scheduled_send" : "followup",
      ...(reply ? { reply } : {}),
      executedActions: executed as never,
      discardedActions: [],
      handoff: extra.handoff === true,
      ...(extra.closed ? { closed: true } : {}),
      latencyMs: Date.now() - startedAt.getTime(),
      inputTokens: 0,
      outputTokens: 0,
      owner: extra.owner ?? "agente",
      stage: extra.closed ? "closed" : "active",
    }).catch(() => undefined);

  // "No fim" da régua.
  if (isEnd && seq?.onEnd) {
    return runEndAction(row, config, seq, data.conv.status, decision.via === "text", decision.reopen, vars, sendText, turnLog, traceStep);
  }

  if (decision.via === "text") {
    let text: string;
    if (row.kind === "scheduled" || step?.mode === "generated") {
      const written = await writeAgendaMessage(config, row.agentId, row.conversationId, purpose);
      const fallback = row.kind === "scheduled"
        ? config.scheduling?.fallbackMessage?.trim() || SCHEDULE_FALLBACK_MESSAGE
        : step?.message?.trim() || FOLLOWUP_STEP_FALLBACK_MESSAGE;
      text = written ?? renderMessage(fallback, vars, defaultFormatter());
      if (!written) traceStep("agenda", "Texto escrito pelo agente indisponível ou com dado → texto fixo");
    } else {
      text = renderMessage(step?.message?.trim() || FOLLOWUP_STEP_FALLBACK_MESSAGE, vars, defaultFormatter());
    }
    traceStep("agenda", `${label} → texto (dentro da janela de 24 h${channel === "baileys" ? " / WhatsApp QR" : ""})`);
    const res = await sendText(text);
    if (!res.sent) {
      await finish(row.id, "FAILED", { outcome: "send_failed", lastError: res.reason ?? "não enviado" });
      await turnLog(undefined, [{ action: { type: "send_message", agenda: row.kind }, ok: false }]);
      return "failed";
    }
    const messageId = await lastAgentMessageId(row.conversationId, row.agentUserId, startedAt);
    await finish(row.id, "SENT", { sentVia: "text", sentMessageId: messageId });
    if (decision.reopen) await reopenForAgent(row);
    await turnLog(text, [{ action: { type: "send_message", agenda: row.kind }, ok: true }]);
    return "sent";
  }

  // Fora das 24 h (Meta): modelo aprovado.
  const candidates = templateCandidates({ step, autoSend: config.autoSend, agentTemplates: await agentTemplates(row.organizationId).catch(() => []) });
  const chosen = await chooseTemplate(config, row.agentId, candidates, purpose);
  if (!chosen) {
    return handleNoTemplate(row, config, label, purpose, turnLog, traceStep);
  }
  traceStep("agenda", `${label} → modelo "${chosen.name}" (fora da janela de 24 h; ${candidates.length} candidato(s))`);
  const { sendV2WhatsappTemplate } = await import("./actions");
  const res = await sendV2WhatsappTemplate({
    conversationId: row.conversationId,
    contactId: row.contactId,
    agentUserId: row.agentUserId,
    templateName: chosen.name,
    languageCode: chosen.language,
    bodyVariables: chosen.variables.map((v) => renderMessage(v, vars, defaultFormatter())),
  });
  if (!res.ok) {
    await finish(row.id, "FAILED", { outcome: "send_failed", templateName: chosen.name, lastError: res.error });
    await turnLog(undefined, [{ action: { type: "send_whatsapp_template", templateName: chosen.name, agenda: row.kind }, ok: false }]);
    return "failed";
  }
  await finish(row.id, "SENT", { sentVia: "template", templateName: chosen.name, sentMessageId: res.messageId });
  if (decision.reopen) await reopenForAgent(row);
  await turnLog(undefined, [{ action: { type: "send_whatsapp_template", templateName: chosen.name, agenda: row.kind }, ok: true }]);
  return "sent";
}

type TurnLogFn = (reply: string | undefined, executed: Array<{ action: { type: string; [k: string]: unknown }; ok: boolean }>, extra?: { handoff?: boolean; closed?: boolean; owner?: "agente" | "pessoa" }) => Promise<unknown>;
type TraceFn = (step: string, detail: string) => void;

/** Fora das 24 h sem modelo possível: tarefa para a equipe (padrão), transferência ou só o registro. */
async function handleNoTemplate(row: AgendaRow, config: V2AgentConfig, label: string, purpose: string, turnLog: TurnLogFn, traceStep: TraceFn): Promise<DispatchResult> {
  const mode = config.autoSend?.noTemplate ?? "task";
  traceStep("agenda", `${label}: fora da janela de 24 h e sem modelo da Meta → ${mode === "task" ? "tarefa para a equipe" : mode === "handoff" ? "transferência" : "só registro"}`);
  try {
    if (mode === "task") {
      const { createActivity } = await import("@/services/activities");
      await createActivity({
        type: "TASK",
        contactId: row.contactId,
        ...(row.dealId ? { dealId: row.dealId } : {}),
        content: `${label} não enviada pelo agente: fora da janela de 24 h do WhatsApp e sem modelo aprovado.${purpose ? ` Motivo: ${purpose}` : ""}`,
      } as never);
    } else if (mode === "handoff") {
      const { simpleHandoff, leadsHandoffOption } = await import("./handoff");
      const { upsertV2ConversationState } = await import("./state");
      await simpleHandoff({
        conversationId: row.conversationId,
        contactId: row.contactId,
        dealId: row.dealId ?? undefined,
        destination: config.handoff.defaultDestination,
        leads: leadsHandoffOption(config),
        moveToStageId: config.handoff?.moveToStageId,
      });
      await upsertV2ConversationState({ organizationId: row.organizationId, conversationId: row.conversationId, agentId: row.agentId, owner: "pessoa" });
    }
  } catch (err) {
    log.warn({ id: row.id, err: err instanceof Error ? err.message : err }, "[ai-v2 agenda] sem modelo: ação falhou");
  }
  await finish(row.id, "SKIPPED", { outcome: "no_template" });
  await turnLog(undefined, [{ action: { type: mode === "task" ? "create_activity" : mode === "handoff" ? "handoff" : "no_reply", agenda: row.kind }, ok: true }], mode === "handoff" ? { handoff: true, owner: "pessoa" } : {});
  return "skipped";
}

/** O que acontece depois do último passo sem resposta. */
async function runEndAction(
  row: AgendaRow,
  config: V2AgentConfig,
  seq: V2FollowUpSequence,
  convStatus: string,
  canText: boolean,
  reopen: boolean,
  vars: Record<string, unknown>,
  sendText: (text: string) => Promise<{ sent: boolean; reason?: string }>,
  turnLog: TurnLogFn,
  traceStep: TraceFn,
): Promise<DispatchResult> {
  const end = seq.onEnd!;
  traceStep("agenda", `Follow-up "${seq.name || seq.id}" terminou sem resposta → ${end.action}`);
  let reply: string | undefined;
  const executed: Array<{ action: { type: string; [k: string]: unknown }; ok: boolean }> = [];
  try {
    const message = end.message?.trim() ? renderMessage(end.message, vars, defaultFormatter()) : "";
    if (end.action === "close") {
      if (convStatus !== "RESOLVED") {
        if (message && canText && (await sendText(message)).sent) reply = message;
        const { closeState } = await import("./engine");
        await closeState(row.organizationId, row.conversationId, row.agentId, row.dealId ?? undefined, config, undefined, "inactivity", row.contactId, {}, null);
      }
      executed.push({ action: { type: "close_conversation" }, ok: true });
    } else if (end.action === "handoff") {
      if (reopen) await reopenForAgent(row);
      if (message && canText && (await sendText(message)).sent) reply = message;
      const { simpleHandoff, leadsHandoffOption } = await import("./handoff");
      const { upsertV2ConversationState } = await import("./state");
      const destination = end.destination?.type ? end.destination : config.handoff.defaultDestination;
      await simpleHandoff({
        conversationId: row.conversationId,
        contactId: row.contactId,
        dealId: row.dealId ?? undefined,
        destination,
        leads: leadsHandoffOption(config),
        moveToStageId: config.handoff?.moveToStageId,
      });
      await upsertV2ConversationState({ organizationId: row.organizationId, conversationId: row.conversationId, agentId: row.agentId, owner: "pessoa" });
      executed.push({ action: { type: "handoff", destination }, ok: true });
    } else if (end.action === "move_stage" && end.stageId && row.dealId) {
      const { prisma } = await import("@/lib/prisma");
      const { updateDeal } = await import("@/services/deals");
      const before = await prisma.deal.findUnique({ where: { id: row.dealId }, select: { stageId: true } });
      await updateDeal(row.dealId, { stageId: end.stageId });
      if (before?.stageId !== end.stageId) {
        const { notifyDealStageChanged } = await import("@/services/automation-triggers");
        void notifyDealStageChanged(row.dealId, before?.stageId, end.stageId, { contactId: row.contactId, depth: 0 });
      }
      executed.push({ action: { type: "move_stage", stageId: end.stageId }, ok: true });
    } else if (end.action === "add_tag" && end.tag) {
      const { applyExistingTagToContact } = await import("@/services/tags");
      const ok = await applyExistingTagToContact({ contactId: row.contactId, tagName: end.tag, source: "ai-v2" });
      executed.push({ action: { type: "add_tag", tag: end.tag }, ok: ok === true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finish(row.id, "FAILED", { outcome: "send_failed", lastError: msg });
    log.warn({ id: row.id, err: msg }, "[ai-v2 agenda] fim da régua falhou");
    return "failed";
  }
  await finish(row.id, "SENT", { sentVia: "action" });
  await turnLog(reply, executed, {
    handoff: end.action === "handoff",
    closed: end.action === "close",
    owner: end.action === "handoff" ? "pessoa" : "agente",
  });
  return "sent";
}

/** Uma passada da agenda. */
export async function processAgendaV2(now: Date = new Date()): Promise<{ planned: number; sent: number; cancelled: number }> {
  if (!(await agendaTableReady())) return { planned: 0, sent: 0, cancelled: 0 };
  await failStaleSending(now).catch((err) => log.warn({ err: err instanceof Error ? err.message : err }, "[ai-v2 agenda] lease falhou"));
  const planned = await planFollowUpsV2(now).catch((err) => {
    log.warn({ err: err instanceof Error ? err.message : err }, "[ai-v2 agenda] planejamento falhou");
    return 0;
  });
  const due = await listDue(now);
  let sent = 0;
  let cancelled = 0;
  if (due.length === 0) return { planned, sent, cancelled };
  const { withSystemContext } = await import("@/lib/webhook-context");
  const { runWithV2Trace } = await import("./trace");
  for (const row of due) {
    if (!(await claimAgendaRow(row.id))) continue;
    try {
      const r = await withSystemContext(row.organizationId, () => runWithV2Trace(() => dispatchAgendaRow(row, now)));
      if (r === "sent") sent++;
      if (r === "cancelled") cancelled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id: row.id, err: msg }, "[ai-v2 agenda] envio falhou");
      await finish(row.id, "FAILED", { outcome: "send_failed", lastError: msg }).catch(() => undefined);
    }
  }
  if (planned + sent + cancelled > 0) log.info({ planejados: planned, enviados: sent, cancelados: cancelled }, "[ai-v2 agenda] resumo");
  return { planned, sent, cancelled };
}
