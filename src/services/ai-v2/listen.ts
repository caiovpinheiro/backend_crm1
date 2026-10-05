/**
 * "Escutar a equipe": com a escuta ligada, o agente lê em lote os
 * atendimentos das pessoas escolhidas e/ou da origem acadêmica do aluno
 * (depois que a conversa encerra ou fica 1 h parada) e monta propostas de
 * conhecimento (material), abordagem (regras) e tom de voz. Nada muda
 * sozinho: cada proposta é aplicada no rascunho ou recusada por quem
 * configura; o atendimento só muda ao publicar.
 *
 * Etapas de cada varredura: conversas das pessoas escutadas (eventos de
 * envio + nome na mensagem) → análise de cada conversa (modelo auxiliar,
 * transcrição mascarada com a pessoa marcada como "Referência") → agregação
 * por frequência (um jeito de atender só vira proposta quando se repete) →
 * redação das propostas (modelo) → conferência contra a configuração.
 * Nenhum domínio de cliente: prompts genéricos, conversas como dado.
 */

import { createHash, randomUUID } from "node:crypto";
import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import { estimateCost } from "@/lib/ai-agents/pricing";
import { embedTexts, generateWithTools } from "@/services/ai/provider";
import { retrieveAgentKnowledge } from "@/services/ai/retrieval";
import { getAgentApiKey } from "@/services/ai/agent-key";
import { validateV2Config } from "@/lib/ai-v2/config";
import { v2AuxModel } from "@/lib/ai-v2/models";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { getV2Agent, saveV2AgentDraft } from "./agents";
import { applyConfigChanges, touchesProtectedPath } from "./config-patch";
import { checkSuggestions, decidedFingerprints, suggestionFingerprint, type ReviewChange } from "./config-review";
import { maskEvidenceText } from "./feedback-extract";
import { unsupportedFigures, unsupportedQuotedTerms } from "./ground-reply";
import { fold } from "./learn-extract";
import {
  LISTEN_LIMITS,
  aggregateTone,
  approachChanges,
  approachItems,
  attributeHumanMessages,
  buildListenTranscript,
  effectiveListenStatus,
  estimateListenCostMath,
  frequentPatterns,
  groupPatterns,
  knowledgeCandidates,
  knowledgeItems,
  listenEndsAt,
  mentionsPerson,
  parseSampleAnalysis,
  startOfTodayBrazil,
  toneChanges,
  type ListenAnalysis,
  type ListenKnowledgeItem,
  type ListenMessage,
  type ListenMode,
  type ListenSample,
  type ListenStatus,
  type Pattern,
} from "./listen-extract";
import { getLogger } from "@/lib/logger";

const log = getLogger("ai-v2.listen");

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

/** Intervalo entre varreduras automáticas de uma escuta ligada. */
export const LISTEN_SWEEP_EVERY_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const STALE_MS = 5 * 60 * 1000;

// ─── Armazenamento ──────────────────────────────────────────────────────

let schemaReady = false;
export async function ensureListenSchema(): Promise<void> {
  if (schemaReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_listen_sessions" (
      "id" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "userIds" JSONB NOT NULL,
      "mode" TEXT NOT NULL,
      "startsAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "endsAt" TIMESTAMPTZ,
      "maxUsdPerDay" DOUBLE PRECISION NOT NULL DEFAULT 1,
      "maxConversationsPerDay" INTEGER NOT NULL DEFAULT 60,
      "lastSweepAt" TIMESTAMPTZ,
      "stats" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "createdById" TEXT NOT NULL,
      "statusById" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_listen_sessions_agent_idx" ON "ai_v2_listen_sessions" ("organizationId", "agentId", "createdAt")`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_listen_sessions_status_idx" ON "ai_v2_listen_sessions" ("status", "lastSweepAt")`);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_listen_samples" (
      "id" TEXT PRIMARY KEY,
      "sessionId" TEXT NOT NULL,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "conversationId" TEXT NOT NULL,
      "conversationNumber" INTEGER,
      "userIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "watermarkAt" TIMESTAMPTZ NOT NULL,
      "messages" INTEGER NOT NULL DEFAULT 0,
      "analysis" JSONB,
      "outcome" TEXT,
      "skipped" TEXT,
      "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "ai_v2_listen_samples_conv_uq" ON "ai_v2_listen_samples" ("sessionId", "conversationId")`);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_listen_proposals" (
      "id" TEXT PRIMARY KEY,
      "sessionId" TEXT NOT NULL,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "summary" TEXT NOT NULL DEFAULT '',
      "occurrences" INTEGER NOT NULL DEFAULT 0,
      "sampleCount" INTEGER NOT NULL DEFAULT 0,
      "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "payload" JSONB NOT NULL,
      "fingerprint" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'open',
      "error" TEXT,
      "statusAt" TIMESTAMPTZ,
      "statusById" TEXT,
      "appliedRef" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_listen_proposals_agent_idx" ON "ai_v2_listen_proposals" ("organizationId", "agentId", "status")`);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_listen_runs" (
      "id" TEXT PRIMARY KEY,
      "sessionId" TEXT NOT NULL,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "total" INTEGER NOT NULL DEFAULT 0,
      "done" INTEGER NOT NULL DEFAULT 0,
      "stats" JSONB,
      "inputTokens" INTEGER NOT NULL DEFAULT 0,
      "outputTokens" INTEGER NOT NULL DEFAULT 0,
      "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "error" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "finishedAt" TIMESTAMPTZ
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_listen_runs_session_idx" ON "ai_v2_listen_runs" ("sessionId", "createdAt")`);
  await db.$executeRawUnsafe(
    `ALTER TABLE "ai_v2_listen_sessions" ADD COLUMN IF NOT EXISTS "originStageIds" JSONB NOT NULL DEFAULT '[]'::jsonb`,
  );
  schemaReady = true;
}

// ─── Tipos ──────────────────────────────────────────────────────────────

export type ListenSessionStats = {
  conversations?: number;
  samples?: number;
  skipped?: number;
  covered?: number;
  capHit?: boolean;
  /** Assinatura das entradas de cada tipo: sem mudança, não reescreve as propostas. */
  signatures?: Partial<Record<ListenProposalKind, string>>;
};

export type ListenSession = {
  id: string;
  status: ListenStatus;
  userIds: string[];
  people: Array<{ id: string; name: string }>;
  /** Etapas acadêmicas de onde o aluno veio antes de entrar em atendimento. */
  originStageIds: string[];
  origins: Array<{ id: string; name: string; pipelineName: string }>;
  mode: ListenMode;
  startsAt: string;
  endsAt: string | null;
  maxUsdPerDay: number;
  maxConversationsPerDay: number;
  lastSweepAt: string | null;
  stats: ListenSessionStats;
  costUsd: number;
  costTodayUsd: number;
  createdById: string;
  createdAt: string;
};

export type ListenProposalKind = "knowledge" | "approach" | "tone";

export type ListenProposal = {
  id: string;
  sessionId: string;
  kind: ListenProposalKind;
  title: string;
  summary: string;
  occurrences: number;
  sampleCount: number;
  evidence: Array<{ conversationNumber: number | null; quote: string }>;
  payload: { title?: string; content?: string; confirm?: boolean; alteracoes?: ReviewChange[] };
  status: "open" | "applied" | "refused" | "stale";
  error: string | null;
  statusAt: string | null;
  appliedRef: string | null;
  createdAt: string;
};

export type ListenRun = {
  id: string;
  status: "running" | "done" | "error";
  total: number;
  done: number;
  stats: Record<string, unknown> | null;
  costUsd: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

async function peopleNames(organizationId: string, ids: string[]): Promise<Array<{ id: string; name: string }>> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRawUnsafe<Array<{ id: string; name: string }>>(
    `SELECT "id", "name" FROM "users" WHERE "organizationId"=$1 AND "id" = ANY($2::text[])`,
    organizationId, ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id)! }));
}

/** Consultores da org: só entra quando a escuta não escolheu pessoas. */
async function orgHumans(organizationId: string): Promise<Array<{ id: string; name: string }>> {
  return db.$queryRawUnsafe<Array<{ id: string; name: string }>>(
    `SELECT "id", "name" FROM "users" WHERE "organizationId"=$1 AND "type"='HUMAN' AND NOT "isErased"`,
    organizationId,
  );
}

async function costToday(sessionId: string): Promise<{ usd: number; samples: number }> {
  const since = startOfTodayBrazil();
  const [cost] = await db.$queryRawUnsafe<Array<{ usd: number | null }>>(
    `SELECT SUM("costUsd") AS "usd" FROM "ai_v2_listen_runs" WHERE "sessionId"=$1 AND "createdAt" >= $2`,
    sessionId, since,
  );
  const [samples] = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*) AS "n" FROM "ai_v2_listen_samples" WHERE "sessionId"=$1 AND "updatedAt" >= $2 AND "analysis" IS NOT NULL`,
    sessionId, since,
  );
  return { usd: Number(cost?.usd ?? 0), samples: Number(samples?.n ?? 0) };
}

async function originNames(ids: string[]): Promise<Array<{ id: string; name: string; pipelineName: string }>> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRawUnsafe<Array<{ id: string; name: string; pipelineName: string }>>(
    `SELECT s."id", s."name", p."name" AS "pipelineName"
       FROM "stages" s JOIN "pipelines" p ON p."id" = s."pipelineId"
      WHERE s."id" = ANY($1::text[])`,
    ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
}

async function toSession(r: Record<string, any>): Promise<ListenSession> {
  const userIds = (r.userIds ?? []) as string[];
  const originStageIds = (Array.isArray(r.originStageIds) ? r.originStageIds : []) as string[];
  const [people, origins, today] = await Promise.all([
    peopleNames(r.organizationId, userIds),
    originNames(originStageIds),
    costToday(r.id).catch(() => ({ usd: 0, samples: 0 })),
  ]);
  return {
    id: r.id,
    status: effectiveListenStatus({ status: r.status, endsAt: r.endsAt }),
    userIds,
    people,
    originStageIds,
    origins,
    mode: r.mode,
    startsAt: iso(r.startsAt)!,
    endsAt: iso(r.endsAt),
    maxUsdPerDay: Number(r.maxUsdPerDay),
    maxConversationsPerDay: Number(r.maxConversationsPerDay),
    lastSweepAt: iso(r.lastSweepAt),
    stats: (r.stats ?? {}) as ListenSessionStats,
    costUsd: Number(r.costUsd ?? 0),
    costTodayUsd: today.usd,
    createdById: r.createdById,
    createdAt: iso(r.createdAt)!,
  };
}

function toProposal(r: Record<string, any>): ListenProposal {
  return {
    id: r.id,
    sessionId: r.sessionId,
    kind: r.kind,
    title: r.title,
    summary: r.summary ?? "",
    occurrences: Number(r.occurrences ?? 0),
    sampleCount: Number(r.sampleCount ?? 0),
    evidence: r.evidence ?? [],
    payload: r.payload ?? {},
    status: r.status,
    error: r.error ?? null,
    statusAt: iso(r.statusAt),
    appliedRef: r.appliedRef ?? null,
    createdAt: iso(r.createdAt)!,
  };
}

function toListenRun(r: Record<string, any>): ListenRun {
  const stale = r.status === "running" && Date.now() - new Date(r.updatedAt).getTime() > STALE_MS;
  return {
    id: r.id,
    status: stale ? "error" : r.status,
    total: Number(r.total ?? 0),
    done: Number(r.done ?? 0),
    stats: r.stats ?? null,
    costUsd: Number(r.costUsd ?? 0),
    error: stale ? "A leitura parou no meio (o servidor reiniciou). Ela roda de novo na próxima varredura." : r.error ?? null,
    createdAt: iso(r.createdAt)!,
    finishedAt: iso(r.finishedAt),
  };
}

// ─── Estado e controle ──────────────────────────────────────────────────

/** Escuta atual do agente (a última ligada/pausada; senão a mais recente), execuções e propostas. */
export async function getListenState(organizationId: string, agentId: string): Promise<{
  session: ListenSession | null;
  runs: ListenRun[];
  proposals: ListenProposal[];
}> {
  await ensureListenSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_listen_sessions" WHERE "organizationId"=$1 AND "agentId"=$2
      ORDER BY ("status" IN ('on','paused')) DESC, "createdAt" DESC LIMIT 1`,
    organizationId, agentId,
  );
  const session = rows[0] ? await toSession(rows[0]) : null;
  const [runs, proposals] = await Promise.all([
    session
      ? db.$queryRawUnsafe<Array<Record<string, any>>>(`SELECT * FROM "ai_v2_listen_runs" WHERE "sessionId"=$1 ORDER BY "createdAt" DESC LIMIT 10`, session.id)
      : Promise.resolve([]),
    db.$queryRawUnsafe<Array<Record<string, any>>>(
      `SELECT * FROM "ai_v2_listen_proposals" WHERE "organizationId"=$1 AND "agentId"=$2 AND "status" <> 'stale'
        ORDER BY ("status"='open') DESC, "occurrences" DESC, "createdAt" DESC LIMIT 200`,
      organizationId, agentId,
    ),
  ]);
  return { session, runs: runs.map(toListenRun), proposals: proposals.map(toProposal) };
}

/** Pessoas válidas: humanas, ativas e da organização. Vazio = qualquer consultor. */
async function validPeople(organizationId: string, userIds: string[]): Promise<string[]> {
  const ids = [...new Set(userIds.filter((x) => typeof x === "string" && x))];
  if (ids.length === 0) return [];
  if (ids.length > LISTEN_LIMITS.maxPeople) throw new Error(`Escolha no máximo ${LISTEN_LIMITS.maxPeople} pessoas.`);
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "users" WHERE "organizationId"=$1 AND "id" = ANY($2::text[]) AND "type"='HUMAN' AND NOT "isErased"`,
    organizationId, ids,
  );
  if (rows.length !== ids.length) throw new Error("Alguma pessoa escolhida não é da equipe desta organização.");
  return ids;
}

/** Etapas de origem: fora do funil Atendimento. Vazio = não filtra por origem. */
async function validOrigins(organizationId: string, stageIds: string[]): Promise<string[]> {
  const ids = [...new Set(stageIds.filter((x) => typeof x === "string" && x))];
  if (ids.length === 0) return [];
  if (ids.length > 10) throw new Error("Escolha no máximo 10 etapas de origem.");
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT s."id" FROM "stages" s
       JOIN "pipelines" p ON p."id" = s."pipelineId"
      WHERE s."organizationId"=$1 AND s."id" = ANY($2::text[])
        AND p."name" NOT ILIKE '%atendimento%'`,
    organizationId, ids,
  );
  if (rows.length !== ids.length) {
    throw new Error("A origem é a etapa de onde o aluno veio, não uma etapa do funil Atendimento.");
  }
  return ids;
}

/** Conversas por dia de cada pessoa nos últimos 7 dias × custo por conversa. */
export async function estimateListen(
  organizationId: string,
  agentId: string,
  userIds: string[],
  originStageIds: string[] = [],
): Promise<{ conversationsPerDay: number; usdPerDay: number }> {
  const ids = await validPeople(organizationId, userIds);
  const origins = await validOrigins(organizationId, originStageIds);
  if (ids.length === 0 && origins.length === 0) return { conversationsPerDay: 0, usdPerDay: 0 };
  const agent = await getV2Agent(agentId, organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const since = new Date(Date.now() - 7 * 86_400_000);
  const conversations = await selectConversations(organizationId, ids, since, null, "estimate", 100000, origins);
  const conversationsPerDay = Math.round((conversations.length / 7) * 10) / 10;
  const model = v2AuxModel(config.model);
  return { conversationsPerDay, usdPerDay: estimateListenCostMath(conversationsPerDay, (i, o) => estimateCost(model, i, o)) };
}

export async function startListen(args: {
  organizationId: string;
  agentId: string;
  userId: string;
  userIds: string[];
  mode: ListenMode;
  days?: number;
  endsAt?: string | null;
  maxUsdPerDay?: number;
  maxConversationsPerDay?: number;
  originStageIds?: string[];
}): Promise<{ sessionId: string }> {
  await ensureListenSchema();
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const apiKey = await getAgentApiKey(args.agentId).catch(() => null);
  if (!apiKey) throw new Error("NO_OPENAI_KEY");
  const ids = await validPeople(args.organizationId, args.userIds);
  const origins = await validOrigins(args.organizationId, args.originStageIds ?? []);
  if (ids.length === 0 && origins.length === 0) {
    throw new Error("Escolha pessoas da equipe ou uma origem.");
  }
  const endsAt = listenEndsAt(args.mode, { days: args.days, endsAt: args.endsAt });
  const current = await db.$queryRawUnsafe<Array<{ id: string; endsAt: Date | null; status: ListenStatus }>>(
    `SELECT "id", "endsAt", "status" FROM "ai_v2_listen_sessions" WHERE "organizationId"=$1 AND "agentId"=$2 AND "status" IN ('on','paused')`,
    args.organizationId, args.agentId,
  );
  if (current.some((s) => effectiveListenStatus(s) !== "expired")) throw new Error("Já existe uma escuta ligada para este agente. Desligue antes de começar outra.");
  // Vencidas que ninguém fechou: fecha agora.
  for (const s of current) await db.$executeRawUnsafe(`UPDATE "ai_v2_listen_sessions" SET "status"='expired', "updatedAt"=now() WHERE "id"=$1`, s.id);
  const sessionId = randomUUID();
  const clamp = (v: unknown, min: number, max: number, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
  };
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_v2_listen_sessions" ("id","organizationId","agentId","status","userIds","originStageIds","mode","endsAt","maxUsdPerDay","maxConversationsPerDay","createdById","statusById")
     VALUES ($1,$2,$3,'on',$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$10)`,
    sessionId, args.organizationId, args.agentId, JSON.stringify(ids), JSON.stringify(origins), args.mode, endsAt,
    clamp(args.maxUsdPerDay, 0.1, 50, 1), Math.round(clamp(args.maxConversationsPerDay, 5, 500, 60)), args.userId,
  );
  return { sessionId };
}

export async function updateListen(args: {
  organizationId: string;
  agentId: string;
  sessionId: string;
  userId: string;
  action: "pause" | "resume" | "off" | "extend";
  mode?: ListenMode;
  days?: number;
  endsAt?: string | null;
}): Promise<void> {
  await ensureListenSchema();
  const [row] = await db.$queryRawUnsafe<Array<{ status: ListenStatus; endsAt: Date | null }>>(
    `SELECT "status", "endsAt" FROM "ai_v2_listen_sessions" WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3`,
    args.sessionId, args.organizationId, args.agentId,
  );
  if (!row) throw new Error("Escuta não encontrada.");
  const status = effectiveListenStatus(row);
  const set = (fields: string, ...values: unknown[]) =>
    db.$executeRawUnsafe(
      `UPDATE "ai_v2_listen_sessions" SET ${fields}, "statusById"=$2, "updatedAt"=now() WHERE "id"=$1`,
      args.sessionId, args.userId, ...values,
    );
  if (args.action === "off") return void (await set(`"status"='off'`));
  if (status === "off") throw new Error("Esta escuta foi desligada. Comece uma nova.");
  if (args.action === "pause") return void (await set(`"status"='paused'`));
  if (args.action === "resume") {
    if (status === "expired") throw new Error("O período terminou. Estenda para continuar.");
    return void (await set(`"status"='on'`));
  }
  const endsAt = listenEndsAt(args.mode ?? "days", { days: args.days, endsAt: args.endsAt });
  await set(`"status"='on', "endsAt"=$3, "mode"=$4`, endsAt, args.mode ?? "days");
}

// ─── Captação ───────────────────────────────────────────────────────────

type ConversationRow = { conversationId: string; lastAt: Date; number: number | null; contactName: string | null };

/**
 * Conversas das pessoas escutadas desde o início da escuta, prontas para
 * ler: encerradas ou paradas há 1 h, e ainda não lidas (ou com mensagens
 * novas desde a leitura). Autoria pelo evento de envio (quem estava
 * logado) ou, sem evento, pelo nome gravado na mensagem.
 */
export const SELECT_CONVERSATIONS_SQL = `
  WITH people AS (
    SELECT "id", lower("name") AS "lname" FROM "users"
     WHERE "organizationId"=$1 AND "type"='HUMAN' AND NOT "isErased"
       AND (cardinality($2::text[]) = 0 OR "id" = ANY($2::text[]))
  ), hits AS (
    SELECT e."conversationId", e."occurredAt" AS "at" FROM "activity_events" e
     WHERE e."organizationId"=$1 AND e."type"='MESSAGE_SENT' AND e."entityType"='MESSAGE'
       AND e."conversationId" IS NOT NULL
       AND e."occurredAt" >= $3 AND ($6::timestamptz IS NULL OR e."occurredAt" <= $6)
       AND (
         (cardinality($2::text[]) > 0 AND e."actorUserId" = ANY($2::text[]))
         OR (cardinality($2::text[]) = 0 AND e."actorUserId" IN (SELECT "id" FROM people))
       )
    UNION ALL
    SELECT m."conversationId", m."createdAt" FROM "messages" m JOIN people p ON lower(m."senderName") = p."lname"
     WHERE m."organizationId"=$1 AND m."direction"='out' AND m."authorType"='human' AND m."createdAt" >= $3
       AND ($6::timestamptz IS NULL OR m."createdAt" <= $6)
       AND (cardinality($2::text[]) = 0 OR p."id" = ANY($2::text[]))
  ), conv AS (
    SELECT "conversationId", max("at") AS "lastAt", count(*) AS "n" FROM hits GROUP BY 1
  )
  SELECT conv."conversationId", conv."lastAt", c."number", ct."name" AS "contactName"
    FROM conv
    JOIN "conversations" c ON c."id"=conv."conversationId" AND c."organizationId"=$1
    LEFT JOIN "contacts" ct ON ct."id"=c."contactId"
    LEFT JOIN "ai_v2_listen_samples" s ON s."sessionId"=$4 AND s."conversationId"=conv."conversationId"
   WHERE conv."n" >= 2
     AND (c."closedAt" IS NOT NULL OR c."updatedAt" < now() - interval '60 minutes')
     AND (s."id" IS NULL OR conv."lastAt" > s."watermarkAt" + interval '1 hour')
     AND (
       cardinality($7::text[]) = 0
       OR EXISTS (
         SELECT 1
           FROM "deals" d
           JOIN "stages" st ON st."id" = d."stageId"
           JOIN "pipelines" pl ON pl."id" = st."pipelineId"
          WHERE d."organizationId" = $1
            AND d."contactId" = c."contactId"
            AND d."status" = 'OPEN'
            AND d."id" = (
              SELECT d2."id" FROM "deals" d2
               WHERE d2."organizationId" = $1 AND d2."contactId" = c."contactId" AND d2."status" = 'OPEN'
               ORDER BY d2."updatedAt" DESC
               LIMIT 1
            )
            AND (
              (d."stageId" = ANY($7::text[]) AND pl."name" NOT ILIKE '%atendimento%')
              OR (
                pl."name" ILIKE '%atendimento%'
                AND (
                  SELECT e.meta->'from'->>'id'
                    FROM "deal_events" e
                    LEFT JOIN "stages" fs ON fs."id" = e.meta->'from'->>'id'
                    LEFT JOIN "pipelines" fp ON fp."id" = fs."pipelineId"
                    LEFT JOIN "stages" ts ON ts."id" = e.meta->'to'->>'id'
                    LEFT JOIN "pipelines" tp ON tp."id" = ts."pipelineId"
                   WHERE e."dealId" = d."id"
                     AND e."type" = 'STAGE_CHANGED'
                     AND COALESCE(fp."name", e.meta->'from'->>'pipelineName', '') NOT ILIKE '%atendimento%'
                     AND COALESCE(tp."name", e.meta->'to'->>'pipelineName', '') ILIKE '%atendimento%'
                   ORDER BY e."createdAt" DESC
                   LIMIT 1
                ) = ANY($7::text[])
              )
            )
       )
     )
   ORDER BY conv."lastAt" ASC
   LIMIT $5`;

async function selectConversations(organizationId: string, userIds: string[], since: Date, until: Date | null, sessionId: string, limit: number, originStageIds: string[]): Promise<ConversationRow[]> {
  return db.$queryRawUnsafe<ConversationRow[]>(SELECT_CONVERSATIONS_SQL, organizationId, userIds, since, sessionId, limit, until, originStageIds);
}

async function loadConversation(organizationId: string, conversationId: string, since: Date): Promise<ListenMessage[]> {
  return db.$queryRawUnsafe<ListenMessage[]>(
    `SELECT "id", "direction", "authorType"::text AS "authorType", "content", "createdAt", "senderName", ("aiAgentUserId" IS NOT NULL) AS "isAi"
       FROM "messages"
      WHERE "conversationId"=$1 AND "organizationId"=$2 AND NOT "isPrivate" AND "messageType" <> 'note' AND "createdAt" >= $3
      ORDER BY "createdAt" ASC
      LIMIT 400`,
    conversationId, organizationId, since,
  );
}

async function sendersByMessage(organizationId: string, conversationId: string, since: Date): Promise<Map<string, string>> {
  const rows = await db.$queryRawUnsafe<Array<{ entityId: string; actorUserId: string }>>(
    `SELECT "entityId", "actorUserId" FROM "activity_events"
      WHERE "organizationId"=$1 AND "conversationId"=$2 AND "type"='MESSAGE_SENT' AND "entityType"='MESSAGE' AND "occurredAt" >= $3 AND "actorUserId" IS NOT NULL`,
    organizationId, conversationId, since,
  );
  return new Map(rows.map((r) => [r.entityId, r.actorUserId]));
}

// ─── Prompts ────────────────────────────────────────────────────────────

export const ANALYZE_SYSTEM = [
  "Você lê um atendimento de WhatsApp. As mensagens marcadas \"Referência\" são de uma pessoa da equipe cujo jeito de atender serve de exemplo para um agente de atendimento. As demais (Cliente, Equipe (outra pessoa), Agente IA, Automação) são contexto.",
  "Extraia só o que está na conversa. Nunca inclua nome, telefone, documento, e-mail, endereço, protocolo ou outro dado do cliente ou da pessoa da equipe: escreva de forma genérica.",
  "Responda só JSON:",
  '{"outcome":"resolved|unresolved|unclear","knowledge":[{"kind":"fact|procedure|policy","question":"...","answer":"...","quote":"..."}],"approach":{"opening":"...","closing":"...","habits":["..."],"handoff":{"reason":"..."}},"tone":{"formality":1,"length":"short|medium|long","emojis":"none|light|moderate","bold":"auto|key|off","treatment":"...","greeting":"...","signoff":"...","vocabulary":["..."],"samples":["..."]}}',
  "- outcome: \"resolved\" quando o cliente teve o que precisava; \"unresolved\" quando ficou sem solução; senão \"unclear\".",
  "- knowledge: só informação da empresa que a Referência deu (regra, prazo, valor, procedimento, política) e que valeria para outros clientes; nada específico deste cliente (pedido, protocolo, situação dele). question: como o cliente perguntou, em termos gerais. answer: o que a Referência respondeu, em termos gerais; procedimento em passos numerados. quote: trecho copiado literalmente de uma mensagem da Referência.",
  "- approach: opening e closing: como a Referência abriu e fechou, em termos gerais. habits: jeitos de conduzir que valeriam em outros atendimentos, cada um uma frase curta no imperativo (ex.: \"Confirme o pedido do cliente antes de explicar\"); nada sobre este caso. handoff.reason: quando e por que chamou outra pessoa ou área (vazio se não chamou).",
  "- tone: formality de 1 (bem informal) a 5 (bem formal); length: tamanho típico das mensagens; emojis: quanto usa; bold: \"key\" se destaca palavras-chave, \"off\" se nunca destaca, \"auto\" se às vezes; treatment: como trata o cliente (você, senhor(a)…); greeting e signoff: cumprimento e despedida usados; vocabulary: expressões típicas; samples: até 3 frases da Referência copiadas literalmente, sem dados pessoais.",
].join("\n");

const APPROACH_SYSTEM = [
  "Você escreve regras de atendimento para um agente de WhatsApp a partir de padrões observados em atendimentos reais de pessoas da equipe. Cada padrão vem com em quantos atendimentos apareceu.",
  "Escreva uma regra por padrão que valha a pena seguir: frase no imperativo, genérica, até 200 caracteres, sem nome de pessoa, sem dado de cliente e sem valores, prazos ou links (esses vão para materiais).",
  "Não escreva regra para cortesia óbvia, nem para o que já está nas REGRAS ATUAIS ou contradiz elas, nem para o que está em RECUSADAS.",
  "Se o padrão é claramente de um dos ASSUNTOS listados, informe o themeId; senão null.",
  'Responda só JSON: {"regras":[{"titulo":"...","texto":"...","themeId":"<id>"|null,"padrao":<número do padrão>}]}',
].join("\n");

const TONE_SYSTEM = [
  "Você descreve o tom de voz de uma equipe de atendimento por WhatsApp para um agente seguir, a partir de traços medidos em atendimentos reais.",
  "tone: um parágrafo curto (até 600 caracteres), em 2ª pessoa (\"Escreva…\", \"Trate o cliente por…\"), com formalidade, tratamento, tamanho das mensagens, uso de emojis, abertura e fecho típicos. Sem nome de pessoa e sem dado de cliente.",
  "exemplos: até 3 frases de EXEMPLOS, copiadas sem mudar nada, as que melhor mostram o tom.",
  'Responda só JSON: {"tone":"...","exemplos":["..."]}',
].join("\n");

const KNOWLEDGE_SYSTEM = [
  "Você escreve materiais para a base de conhecimento de um agente de atendimento a partir do que pessoas da equipe responderam em atendimentos reais.",
  "Você recebe grupos numerados: perguntas de clientes, as respostas da equipe e em quantos atendimentos o grupo apareceu.",
  `Escreva um material por grupo com informação útil (no máximo ${LISTEN_LIMITS.maxProposalsPerKind}). Texto simples, com estas partes:`,
  "Quando usar: como o cliente costuma perguntar.",
  "Resposta: o que responder; procedimento em passos numerados.",
  "Quando chamar a equipe: situações em que foi preciso uma pessoa (se houver).",
  "Regras: use só o que está nos grupos. Grupo marcado \"(uma conversa só)\" termina os passos com \"(confirmar)\". Respostas que se contradizem no grupo: escreva \"(a equipe respondeu de jeitos diferentes — confirmar)\". Nunca inclua nome, telefone, documento, e-mail ou protocolo. Não invente links, valores, prazos, telas ou botões. Não escreva sobre os títulos em RECUSADOS.",
  'Responda só JSON: {"docs":[{"title":"...","content":"...","grupo":<número do grupo>}]}',
].join("\n");

function parseJson(text: string): unknown {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// ─── Varredura ──────────────────────────────────────────────────────────

/**
 * Trava a sessão para uma varredura (uma por vez, entre processos). `minGapMs`:
 * intervalo mínimo desde a última.
 */
async function claimSweep(sessionId: string, minGapMs: number): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE "ai_v2_listen_sessions" SET "lastSweepAt"=now(), "updatedAt"=now()
      WHERE "id"=$1 AND ("lastSweepAt" IS NULL OR "lastSweepAt" < now() - ($2::text || ' milliseconds')::interval)
        AND NOT EXISTS (SELECT 1 FROM "ai_v2_listen_runs" r WHERE r."sessionId"=$1 AND r."status"='running' AND r."updatedAt" > now() - interval '5 minutes')
      RETURNING "id"`,
    sessionId, String(minGapMs),
  );
  return rows.length > 0;
}

/** "Ler agora": varre fora do intervalo (espera 1 min desde a última). */
export async function sweepListenNow(organizationId: string, agentId: string, sessionId: string): Promise<{ runId: string }> {
  await ensureListenSchema();
  const [row] = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_listen_sessions" WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3`,
    sessionId, organizationId, agentId,
  );
  if (!row) throw new Error("Escuta não encontrada.");
  if (row.status === "off") throw new Error("Esta escuta foi desligada.");
  if (!(await claimSweep(sessionId, 60_000))) throw new Error("Já está lendo, ou leu há menos de 1 minuto.");
  const runId = randomUUID();
  void runSweep(row, runId).catch((err) => log.error({ err }, "[ai-v2 escuta] varredura falhou"));
  return { runId };
}

/**
 * Varre todas as escutas ligadas que estão no intervalo (tick do worker e
 * rota de cron). Vencidas fazem a última leitura e viram "encerrada".
 */
export async function sweepAllListenSessions(opts: { limit?: number; dryRun?: boolean } = {}): Promise<{ due: number; swept: number }> {
  await ensureListenSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_listen_sessions"
      WHERE "status"='on' AND ("lastSweepAt" IS NULL OR "lastSweepAt" < now() - interval '${Math.round(LISTEN_SWEEP_EVERY_MS / 60000)} minutes')
      ORDER BY "lastSweepAt" NULLS FIRST LIMIT $1`,
    opts.limit ?? 20,
  );
  if (opts.dryRun) return { due: rows.length, swept: 0 };
  let swept = 0;
  for (const row of rows) {
    if (!(await claimSweep(row.id, LISTEN_SWEEP_EVERY_MS - 60_000))) continue;
    try {
      await runSweep(row, randomUUID());
      swept += 1;
    } catch (err) {
      log.error({ rowId: row.id, err }, "[ai-v2 escuta] varredura falhou");
    }
  }
  return { due: rows.length, swept };
}

let tickTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Tick no processo (junto do varredor de turnos). Idempotente. */
export function startListenSweeper(): void {
  if (tickTimer || (process.env.AI_LISTEN_SWEEPER ?? "1").trim() === "0") return;
  const tick = () => {
    if (ticking) return;
    ticking = true;
    void sweepAllListenSessions()
      .catch((err) => log.error(
        { err: err instanceof Error ? err.message : err },
        "[ai-v2 escuta] tick falhou",
      ))
      .finally(() => {
        ticking = false;
      });
  };
  tickTimer = setInterval(tick, 60_000);
  tickTimer.unref?.();
}

async function runSweep(row: Record<string, any>, runId: string): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_v2_listen_runs" ("id","sessionId","organizationId","agentId","status") VALUES ($1,$2,$3,$4,'running')`,
    runId, row.id, row.organizationId, row.agentId,
  );
  const ctx = {
    organizationId: row.organizationId,
    userId: row.createdById,
    isSuperAdmin: false,
    actor: { type: "AI", label: "Escutar a equipe", ref: row.agentId },
  } as Parameters<typeof runWithContext>[0];
  const heartbeat = setInterval(() => {
    void db.$executeRawUnsafe(`UPDATE "ai_v2_listen_runs" SET "updatedAt"=now() WHERE "id"=$1 AND "status"='running'`, runId).catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    await runWithContext(ctx, () => executeSweep(row, runId));
  } catch (err) {
    await db.$executeRawUnsafe(
      `UPDATE "ai_v2_listen_runs" SET "status"='error', "error"=$2, "updatedAt"=now(), "finishedAt"=now() WHERE "id"=$1`,
      runId, err instanceof Error ? err.message : String(err),
    ).catch(() => undefined);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

async function executeSweep(row: Record<string, any>, runId: string): Promise<void> {
  const organizationId: string = row.organizationId;
  const agentId: string = row.agentId;
  const sessionId: string = row.id;
  const userIds = (row.userIds ?? []) as string[];
  const originStageIds = (Array.isArray(row.originStageIds) ? row.originStageIds : []) as string[];
  const agent = await getV2Agent(agentId, organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const apiKey = await getAgentApiKey(agentId).catch(() => null);
  if (!apiKey) throw new Error("Sem a chave do modelo do agente (Publicação).");
  const model = v2AuxModel(config.model);
  const people = userIds.length > 0 ? await peopleNames(organizationId, userIds) : await orgHumans(organizationId);
  const personNames = people.map((p) => p.name);
  const stats: ListenSessionStats = { ...((row.stats ?? {}) as ListenSessionStats) };
  let inTok = 0;
  let outTok = 0;
  let embedTok = 0;
  const cost = () => estimateCost(model, inTok, outTok) + (embedTok * 0.02) / 1_000_000;
  const call = async (system: string, user: string, maxOutputTokens: number) => {
    const res = await generateWithTools({ model, apiKey, system, messages: [{ role: "user", content: user }] as never, temperature: 0, maxOutputTokens, maxSteps: 1 });
    inTok += res.inputTokens;
    outTok += res.outputTokens;
    return parseJson(res.text);
  };
  const progress = (total: number, done: number) =>
    db.$executeRawUnsafe(
      `UPDATE "ai_v2_listen_runs" SET "total"=$2, "done"=$3, "inputTokens"=$4, "outputTokens"=$5, "costUsd"=$6, "updatedAt"=now() WHERE "id"=$1`,
      runId, total, done, inTok, outTok, cost(),
    );

  // 1. Teto do dia e conversas prontas para ler.
  const today = await costToday(sessionId);
  const room = Math.min(LISTEN_LIMITS.batch, Math.max(0, Number(row.maxConversationsPerDay) - today.samples));
  const capHit = today.usd >= Number(row.maxUsdPerDay) || room === 0;
  const startsAt = new Date(row.startsAt);
  const until = row.endsAt ? new Date(row.endsAt) : null;
  const conversations = capHit ? [] : await selectConversations(organizationId, userIds, startsAt, until, sessionId, room, originStageIds);
  stats.capHit = capHit;
  await progress(conversations.length, 0);

  // 2. Análise de cada conversa.
  const referenceIds = new Set(userIds);
  const userByName = new Map(people.map((p) => [fold(p.name), p.id]));
  const messagesSince = new Date(startsAt.getTime() - 24 * 60 * 60 * 1000);
  let done = 0;
  await pool(conversations, LISTEN_LIMITS.concurrency, async (c) => {
    let analysis: ListenAnalysis | null = null;
    let skipped: string | null = null;
    let count = 0;
    let who: string[] = [];
    try {
      const [messages, actors] = await Promise.all([
        loadConversation(organizationId, c.conversationId, messagesSince),
        sendersByMessage(organizationId, c.conversationId, messagesSince),
      ]);
      const attributed = attributeHumanMessages(messages, actors, userByName);
      const refs = userIds.length > 0
        ? referenceIds
        : new Set(attributed.map((m) => m.userId).filter((u): u is string => !!u));
      who = [...new Set(attributed.map((m) => m.userId).filter((u): u is string => !!u && refs.has(u)))];
      const tr = buildListenTranscript(attributed, refs, [c.contactName ?? "", ...personNames].filter(Boolean));
      count = attributed.length;
      if (tr.referenceCount < LISTEN_LIMITS.minReferenceMessages) skipped = "poucas mensagens da pessoa escutada";
      else {
        const raw = await call(ANALYZE_SYSTEM, tr.text, 1200);
        analysis = parseSampleAnalysis(raw, tr.referenceText, [c.contactName ?? "", ...personNames].filter(Boolean));
        if (!analysis) skipped = "o modelo não devolveu a análise";
      }
    } catch (err) {
      skipped = `erro: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_v2_listen_samples" ("id","sessionId","organizationId","agentId","conversationId","conversationNumber","userIds","watermarkAt","messages","analysis","outcome","skipped")
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12)
       ON CONFLICT ("sessionId","conversationId") DO UPDATE SET "userIds"=EXCLUDED."userIds", "watermarkAt"=EXCLUDED."watermarkAt", "messages"=EXCLUDED."messages",
         "analysis"=COALESCE(EXCLUDED."analysis", "ai_v2_listen_samples"."analysis"), "outcome"=COALESCE(EXCLUDED."outcome", "ai_v2_listen_samples"."outcome"),
         "skipped"=EXCLUDED."skipped", "updatedAt"=now()`,
      randomUUID(), sessionId, organizationId, agentId, c.conversationId, c.number ?? null, JSON.stringify(who), c.lastAt, count,
      analysis ? JSON.stringify(analysis) : null, analysis?.outcome ?? null, skipped,
    );
    done += 1;
    await progress(conversations.length, done);
  });

  // 3. Agregação sobre todas as conversas lidas nesta escuta.
  const sampleRows = await db.$queryRawUnsafe<Array<{ id: string; conversationNumber: number | null; analysis: ListenAnalysis }>>(
    `SELECT "id", "conversationNumber", "analysis" FROM "ai_v2_listen_samples" WHERE "sessionId"=$1 AND "analysis" IS NOT NULL ORDER BY "createdAt"`,
    sessionId,
  );
  const samples: ListenSample[] = sampleRows.map((r) => ({ id: r.id, conversationNumber: r.conversationNumber, analysis: r.analysis }));
  const [counts] = await db.$queryRawUnsafe<Array<{ total: bigint | number; skipped: bigint | number }>>(
    `SELECT COUNT(*) AS "total", COUNT(*) FILTER (WHERE "analysis" IS NULL) AS "skipped" FROM "ai_v2_listen_samples" WHERE "sessionId"=$1`,
    sessionId,
  );
  stats.conversations = Number(counts?.total ?? 0);
  stats.samples = samples.length;
  stats.skipped = Number(counts?.skipped ?? 0);
  const numberOf = new Map(samples.map((s) => [s.id, s.conversationNumber]));
  const embed = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const res = await embedTexts(texts, apiKey);
    embedTok += res.inputTokens;
    return res.embeddings;
  };
  const skip = await decidedFingerprints(organizationId, agentId).catch(() => new Set<string>());
  const refusedTitles = await db.$queryRawUnsafe<Array<{ title: string }>>(
    `SELECT "title" FROM "ai_v2_listen_proposals" WHERE "organizationId"=$1 AND "agentId"=$2 AND "kind"='knowledge' AND "status"='refused' ORDER BY "statusAt" DESC LIMIT 30`,
    organizationId, agentId,
  );
  const signatures = { ...(stats.signatures ?? {}) };
  const replace = async (kind: ListenProposalKind, proposals: NewProposal[]) => {
    await db.$executeRawUnsafe(
      `UPDATE "ai_v2_listen_proposals" SET "status"='stale', "statusAt"=now() WHERE "sessionId"=$1 AND "kind"=$2 AND "status"='open'`,
      sessionId, kind,
    );
    for (const p of proposals) {
      await db.$executeRawUnsafe(
        `INSERT INTO "ai_v2_listen_proposals" ("id","sessionId","organizationId","agentId","kind","title","summary","occurrences","sampleCount","evidence","payload","fingerprint")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
        randomUUID(), sessionId, organizationId, agentId, kind, p.title.slice(0, 300), p.summary.slice(0, 2000), p.occurrences, samples.length,
        JSON.stringify(p.evidence.slice(0, 5)), JSON.stringify(p.payload), p.fingerprint,
      );
    }
  };

  // 3a. Tom.
  const tone = aggregateTone(samples);
  const toneSig = tone ? sha(JSON.stringify(tone)) : "";
  if (tone && toneSig !== signatures.tone) {
    const input = [
      `Atendimentos lidos: ${tone.sampleCount}`,
      `Formalidade (1 a 5): ${tone.formality ?? "?"}`,
      `Tratamento: ${tone.treatment || "?"}`,
      `Tamanho das mensagens: ${tone.length ?? "?"}`,
      `Emojis: ${tone.emojis ?? "?"}`,
      `Cumprimentos: ${tone.greetings.join(" | ") || "-"}`,
      `Despedidas: ${tone.signoffs.join(" | ") || "-"}`,
      `Expressões: ${tone.vocabulary.join(", ") || "-"}`,
      `EXEMPLOS:\n${tone.samples.map((s) => `- ${s}`).join("\n") || "-"}`,
      `TOM ATUAL DO AGENTE:\n${config.tone}`,
    ].join("\n");
    const raw = (await call(TONE_SYSTEM, input, 800).catch(() => null)) as { tone?: unknown; exemplos?: unknown } | null;
    const text = typeof raw?.tone === "string" ? maskEvidenceText(raw.tone.trim(), personNames).slice(0, 800) : "";
    const allowed = new Set(tone.samples.map(fold));
    const examples = (Array.isArray(raw?.exemplos) ? raw!.exemplos : []).filter((e): e is string => typeof e === "string" && allowed.has(fold(e)));
    const changes = text
      ? toneChanges(config, { tone: text, responseLength: tone.length, emojis: tone.emojis, bold: tone.bold, examples }, personNames)
      : [];
    const checked = changes.length ? checkSuggestions(config, [rawSuggestion("Tom de voz da equipe", changes)], { skipFingerprints: skip }) : [];
    const s = checked.find((x) => x.aplicavel);
    await replace("tone", s ? [{
      title: "Tom de voz da equipe",
      summary: text,
      occurrences: tone.sampleCount,
      evidence: tone.samples.map((q) => ({ conversationNumber: null, quote: q })),
      payload: { alteracoes: s.alteracoes },
      fingerprint: s.fingerprint ?? suggestionFingerprint({ titulo: s.titulo, alteracoes: s.alteracoes }),
    }] : []);
    signatures.tone = toneSig;
  }

  // 3b. Abordagem.
  const aItems = approachItems(samples);
  const aSig = sha(JSON.stringify(aItems.map((i) => [i.text, i.sampleId])));
  if (aItems.length > 0 && aSig !== signatures.approach) {
    const patterns = frequentPatterns(groupPatterns(aItems, await embed(aItems.map((i) => i.text))), samples.length);
    const proposals: NewProposal[] = [];
    if (patterns.length > 0) {
      const input = [
        `PADRÕES (de ${samples.length} atendimentos lidos):`,
        ...patterns.map((p, i) => `[${i + 1}] (em ${p.occurrences} atendimentos) ${[...new Set(p.texts)].slice(0, 4).join(" | ")}`),
        `ASSUNTOS:\n${config.themes.map((t) => `- ${t.id}: ${t.name}`).join("\n") || "(nenhum)"}`,
        `REGRAS ATUAIS:\n${(config.globalRules ?? []).map((r) => `- ${r}`).join("\n") || "(nenhuma)"}`,
      ].join("\n");
      const raw = (await call(APPROACH_SYSTEM, input, 2000).catch(() => null)) as { regras?: unknown } | null;
      const regras = Array.isArray(raw?.regras) ? (raw!.regras as Array<Record<string, unknown>>) : [];
      for (const r of regras.slice(0, LISTEN_LIMITS.maxProposalsPerKind)) {
        const pattern = patterns[Number(r.padrao) - 1];
        const texto = typeof r.texto === "string" ? maskEvidenceText(r.texto.trim(), personNames).slice(0, 300) : "";
        const titulo = typeof r.titulo === "string" && r.titulo.trim() ? r.titulo.trim().slice(0, 120) : texto.slice(0, 80);
        if (!pattern || !texto) continue;
        const changes = approachChanges(config, { titulo, texto, themeId: typeof r.themeId === "string" ? r.themeId : null }, personNames);
        if (changes.length === 0) continue;
        const [s] = checkSuggestions(config, [rawSuggestion(titulo, changes)], { skipFingerprints: skip });
        if (!s?.aplicavel) continue;
        proposals.push({
          title: titulo,
          summary: texto,
          occurrences: pattern.occurrences,
          evidence: evidenceOf(pattern, numberOf),
          payload: { alteracoes: s.alteracoes },
          fingerprint: s.fingerprint ?? suggestionFingerprint({ titulo, alteracoes: s.alteracoes }),
        });
      }
    }
    await replace("approach", proposals);
    signatures.approach = aSig;
  }

  // 3c. Conhecimento.
  const kItems = knowledgeItems(samples);
  const kSig = sha(JSON.stringify(kItems.map((i) => [i.text, i.sampleId])));
  if (kItems.length > 0 && kSig !== signatures.knowledge) {
    const groups = groupPatterns(kItems, await embed(kItems.map((i) => i.text)));
    const byText = new Map<string, ListenKnowledgeItem>(kItems.map((i) => [i.text, i.item]));
    const kCandidates = knowledgeCandidates(groups, byText);
    const candidates: typeof kCandidates = [];
    stats.covered = 0;
    for (const cand of kCandidates) {
      const question = cand.items[0]?.question ?? "";
      const hit = question ? await retrieveAgentKnowledge(agentId, question, apiKey, 1).catch(() => null) : null;
      const best = hit?.chunks[0];
      if (best && 1 - best.distance >= LISTEN_LIMITS.coveredSimilarity) {
        stats.covered += 1;
        continue;
      }
      candidates.push(cand);
    }
    const proposals: NewProposal[] = [];
    if (candidates.length > 0) {
      const input = [
        ...candidates.map((c, i) => [
          `[${i + 1}] (em ${c.pattern.occurrences} atendimento${c.pattern.occurrences === 1 ? "" : "s"})${c.confirm ? " (uma conversa só)" : ""}`,
          ...c.items.slice(0, 5).map((it) => `Pergunta: ${it.question}\nResposta da equipe: ${it.answer}`),
        ].join("\n")),
        `RECUSADOS:\n${refusedTitles.map((r) => `- ${r.title}`).join("\n") || "(nenhum)"}`,
      ].join("\n\n");
      const raw = (await call(KNOWLEDGE_SYSTEM, input, 3000).catch(() => null)) as { docs?: unknown } | null;
      const docs = Array.isArray(raw?.docs) ? (raw!.docs as Array<Record<string, unknown>>) : [];
      const refused = new Set(refusedTitles.map((r) => fold(r.title)));
      for (const d of docs.slice(0, LISTEN_LIMITS.maxProposalsPerKind)) {
        const cand = candidates[Number(d.grupo) - 1];
        const title = typeof d.title === "string" ? d.title.trim().slice(0, 200) : "";
        let content = typeof d.content === "string" ? d.content.trim() : "";
        if (!cand || !title || content.length < 40 || refused.has(fold(title)) || mentionsPerson(title, personNames)) continue;
        for (const bad of [...unsupportedFigures(content, [input]), ...unsupportedQuotedTerms(content, [input])]) content = content.split(bad).join("[confirmar]");
        content = maskEvidenceText(content, personNames);
        const fingerprint = sha(`k:${fold(cand.items[0]?.question ?? title)}`);
        if (skip.has(fingerprint)) continue;
        proposals.push({
          title,
          summary: content.slice(0, 300),
          occurrences: cand.pattern.occurrences,
          evidence: cand.items
            .map((it, i) => ({ conversationNumber: numberOf.get(cand.itemSampleIds[i] ?? "") ?? null, quote: it.quote ?? "" }))
            .filter((e) => e.quote),
          payload: { title, content, confirm: cand.confirm },
          fingerprint,
        });
      }
    }
    await replace("knowledge", proposals);
    signatures.knowledge = kSig;
  }

  // 4. Fecha: custo, estatísticas, vencimento.
  stats.signatures = signatures;
  const finalCost = cost();
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_listen_runs" SET "status"='done', "stats"=$2::jsonb, "inputTokens"=$3, "outputTokens"=$4, "costUsd"=$5, "updatedAt"=now(), "finishedAt"=now() WHERE "id"=$1`,
    runId, JSON.stringify({ read: conversations.length, capHit }), inTok, outTok, finalCost,
  );
  const expired = effectiveListenStatus({ status: row.status, endsAt: row.endsAt }) === "expired";
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_listen_sessions" SET "stats"=$2::jsonb, "costUsd"="costUsd"+$3, "status"=CASE WHEN $4 AND "status"='on' THEN 'expired' ELSE "status" END, "updatedAt"=now() WHERE "id"=$1`,
    sessionId, JSON.stringify(stats), finalCost, expired,
  );
}

type NewProposal = {
  title: string;
  summary: string;
  occurrences: number;
  evidence: Array<{ conversationNumber: number | null; quote: string }>;
  payload: ListenProposal["payload"];
  fingerprint: string;
};

function rawSuggestion(titulo: string, alteracoes: ReviewChange[]) {
  return {
    titulo,
    gravidade: "media" as const,
    area: "Escutar a equipe",
    problema: "",
    evidencia: "",
    correcao: "",
    atendimentos: [],
    pontos: [],
    alteracoes: alteracoes.map(({ before: _b, ...ch }) => ch),
  };
}

function evidenceOf(p: Pattern, numberOf: Map<string, number | null>): NewProposal["evidence"] {
  return p.texts.slice(0, 5).map((quote, i) => ({ conversationNumber: numberOf.get(p.textSampleIds[i] ?? "") ?? null, quote }));
}

// ─── Aprovar e recusar ──────────────────────────────────────────────────

async function getProposal(organizationId: string, agentId: string, proposalId: string): Promise<ListenProposal | null> {
  await ensureListenSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_listen_proposals" WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3`,
    proposalId, organizationId, agentId,
  );
  return rows[0] ? toProposal(rows[0]) : null;
}

/**
 * Aplica a proposta. Abordagem e tom: no rascunho da configuração.
 * Conhecimento: o material já foi criado pela tela (mesmo caminho do
 * "Aprender com conversas"); aqui só registra o id.
 */
export async function applyListenProposal(args: {
  organizationId: string;
  agentId: string;
  proposalId: string;
  userId: string;
  knowledgeDocId?: string | null;
}): Promise<{ applied: boolean; error?: string }> {
  const p = await getProposal(args.organizationId, args.agentId, args.proposalId);
  if (!p) throw new Error("Proposta não encontrada.");
  if (p.status !== "open") throw new Error(p.status === "stale" ? "Esta proposta foi atualizada por uma leitura mais nova." : "Esta proposta já foi decidida.");
  const mark = (status: "applied" | "stale", ref: string | null, error: string | null) =>
    db.$executeRawUnsafe(
      `UPDATE "ai_v2_listen_proposals" SET "status"=$2, "appliedRef"=$3, "error"=$4, "statusAt"=now(), "statusById"=$5 WHERE "id"=$1`,
      p.id, status, ref, error, args.userId,
    );
  if (p.kind === "knowledge") {
    if (!args.knowledgeDocId) throw new Error("Informe o material criado.");
    await mark("applied", args.knowledgeDocId, null);
    return { applied: true };
  }
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  try {
    if ((p.payload.alteracoes ?? []).some((a) => touchesProtectedPath(a.path))) throw new Error("Mexe em campo de publicação: mude à mão em Publicação.");
    const next = applyConfigChanges(config, (p.payload.alteracoes ?? []).map(({ before: _b, ...ch }) => ch));
    const valid = validateV2Config(next);
    if (!valid.ok) throw new Error(`A configuração ficaria inválida: ${valid.errors.issues[0]?.message ?? ""}`);
    await saveV2AgentDraft(args.agentId, args.organizationId, { config: valid.data });
    await mark("applied", null, null);
    return { applied: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await mark("stale", null, error);
    return { applied: false, error };
  }
}

export async function refuseListenProposal(args: { organizationId: string; agentId: string; proposalId: string; userId: string; refused: boolean }): Promise<void> {
  const p = await getProposal(args.organizationId, args.agentId, args.proposalId);
  if (!p) throw new Error("Proposta não encontrada.");
  if (args.refused && p.status !== "open") throw new Error("Esta proposta já foi decidida.");
  if (!args.refused && p.status !== "refused") return;
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_listen_proposals" SET "status"=$2, "statusAt"=now(), "statusById"=$3 WHERE "id"=$1`,
    p.id, args.refused ? "refused" : "open", args.userId,
  );
}
