/**
 * Feedback do agente: lê o que o motor já grava (logs de turno, testes pelo
 * WhatsApp, comparações com a equipe) e devolve itens priorizados — material
 * que falta, material a melhorar, ajustes em assuntos, transferências, ações,
 * escopo — com evidência e o lugar de corrigir.
 *
 * Etapas: fatos por turno (sem modelo) → candidatos → rótulo do modelo só nos
 * ambíguos → busca refeita em todos os materiais para separar "falta" de "não
 * liberado", "não achou" e "achou e errou" → agrupamento por sentido →
 * recomendação (modelo) → gravação.
 * Nenhum domínio de cliente: prompts genéricos, config e conversas como dado.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import { estimateCost } from "@/lib/ai-agents/pricing";
import { embedTexts, generateWithTools } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";
import { retrieveAgentKnowledge } from "@/services/ai/retrieval";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { getV2Agent } from "./agents";
import { ensureV2AgentSchema } from "./ensure-schema";
import { knowledgeDocIdsFor } from "./themes";
import { unsupportedFigures, unsupportedQuotedTerms } from "./ground-reply";
import { pointOutcome } from "./replay";
import {
  FEEDBACK_CATEGORIES,
  clusterByVectors,
  factPills,
  factsFromReplayItems,
  factsFromTurnLogs,
  maskEvidenceText,
  selectCandidates,
  type Candidate,
  type FeedbackCategory,
  type FeedbackSourceType,
  type ReplayItemFactsRow,
  type TurnLogRow,
} from "./feedback-extract";

export type FeedbackParams = {
  days: 7 | 30 | 90;
  sources: FeedbackSourceType[];
};

export const FEEDBACK_LIMITS = { maxTurns: 3000, maxReplayPoints: 800, maxCandidates: 400, maxGroupsWithModel: 40, batch: 5 };
const HEARTBEAT_MS = 30 * 1000;
const STALE_MS = 3 * 60 * 1000;

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

// ─── Armazenamento ──────────────────────────────────────────────────────

let schemaReady = false;
async function ensureFeedbackSchema(): Promise<void> {
  if (schemaReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_feedback_reports" (
      "id" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "params" JSONB NOT NULL,
      "stats" JSONB,
      "total" INTEGER NOT NULL DEFAULT 0,
      "done" INTEGER NOT NULL DEFAULT 0,
      "inputTokens" INTEGER NOT NULL DEFAULT 0,
      "outputTokens" INTEGER NOT NULL DEFAULT 0,
      "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "error" TEXT,
      "createdById" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "finishedAt" TIMESTAMPTZ
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_feedback_reports_agent_idx" ON "ai_v2_feedback_reports" ("organizationId", "agentId", "createdAt")`);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_feedback_items" (
      "id" TEXT PRIMARY KEY,
      "reportId" TEXT NOT NULL,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "category" TEXT NOT NULL,
      "severity" INTEGER NOT NULL,
      "score" DOUBLE PRECISION NOT NULL,
      "minor" BOOLEAN NOT NULL DEFAULT false,
      "title" TEXT NOT NULL,
      "summary" TEXT NOT NULL DEFAULT '',
      "target" JSONB,
      "recommendation" JSONB,
      "conversations" INTEGER NOT NULL DEFAULT 0,
      "evidenceCount" INTEGER NOT NULL DEFAULT 0,
      "evidences" JSONB NOT NULL DEFAULT '[]',
      "status" TEXT NOT NULL DEFAULT 'open',
      "statusAt" TIMESTAMPTZ,
      "statusById" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_feedback_items_report_idx" ON "ai_v2_feedback_items" ("reportId")`);
  schemaReady = true;
}

export type FeedbackReport = {
  id: string;
  status: "running" | "done" | "error" | "canceled";
  params: FeedbackParams;
  stats: FeedbackStats | null;
  total: number;
  done: number;
  costUsd: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type FeedbackStats = {
  turns: number;
  bySource: Partial<Record<FeedbackSourceType, number>>;
  candidates: number;
  sampled: boolean;
  items: number;
  byCategory: Partial<Record<FeedbackCategory, number>>;
};

export type FeedbackEvidence = {
  sourceType: FeedbackSourceType;
  sourceId: string;
  conversationId: string;
  at: string;
  client: string;
  agent: string;
  human?: string;
  pills: string[];
};

export type FeedbackRecommendation = {
  action: string;
  text: string;
  questions: string[];
  triggers: string[];
};

export type FeedbackTarget = { section: string; tab?: string; themeId?: string; docId?: string; docTitle?: string; themeName?: string };

export type FeedbackItem = {
  id: string;
  category: FeedbackCategory;
  severity: number;
  score: number;
  minor: boolean;
  title: string;
  summary: string;
  target: FeedbackTarget | null;
  recommendation: FeedbackRecommendation | null;
  conversations: number;
  evidenceCount: number;
  evidences: FeedbackEvidence[];
  status: "open" | "resolved" | "ignored";
  statusAt: string | null;
};

function toReport(r: Record<string, any>): FeedbackReport {
  const stale = r.status === "running" && Date.now() - new Date(r.updatedAt).getTime() > STALE_MS;
  return {
    id: r.id,
    status: stale ? "error" : r.status,
    params: r.params,
    stats: r.stats ?? null,
    total: r.total,
    done: r.done,
    costUsd: Number(r.costUsd ?? 0),
    error: stale ? "O relatório parou no meio (o servidor reiniciou). Gere de novo." : r.error ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
  };
}

function toItem(r: Record<string, any>): FeedbackItem {
  return {
    id: r.id,
    category: r.category,
    severity: r.severity,
    score: Number(r.score),
    minor: r.minor,
    title: r.title,
    summary: r.summary,
    target: r.target ?? null,
    recommendation: r.recommendation ?? null,
    conversations: r.conversations,
    evidenceCount: r.evidenceCount,
    evidences: Array.isArray(r.evidences) ? r.evidences : [],
    status: r.status,
    statusAt: r.statusAt ? new Date(r.statusAt).toISOString() : null,
  };
}

export async function listFeedbackReports(organizationId: string, agentId: string): Promise<FeedbackReport[]> {
  await ensureFeedbackSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_feedback_reports" WHERE "organizationId"=$1 AND "agentId"=$2 ORDER BY "createdAt" DESC LIMIT 20`,
    organizationId, agentId,
  );
  return rows.map(toReport);
}

export async function getFeedbackReport(organizationId: string, agentId: string, reportId: string): Promise<{ report: FeedbackReport; items: FeedbackItem[] } | null> {
  await ensureFeedbackSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_feedback_reports" WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3`,
    reportId, organizationId, agentId,
  );
  if (rows.length === 0) return null;
  const items = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_feedback_items" WHERE "reportId"=$1 AND "organizationId"=$2 ORDER BY "minor" ASC, "score" DESC`,
    reportId, organizationId,
  );
  return { report: toReport(rows[0]), items: items.map(toItem) };
}

export async function setFeedbackItemStatus(args: {
  organizationId: string;
  agentId: string;
  itemId: string;
  status: FeedbackItem["status"];
  userId: string;
}): Promise<boolean> {
  await ensureFeedbackSchema();
  const n = await db.$executeRawUnsafe(
    `UPDATE "ai_v2_feedback_items" SET "status"=$4, "statusAt"=now(), "statusById"=$5 WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3`,
    args.itemId, args.organizationId, args.agentId, args.status, args.userId,
  );
  return n > 0;
}

export async function cancelFeedbackReport(organizationId: string, agentId: string, reportId: string): Promise<boolean> {
  await ensureFeedbackSchema();
  const n = await db.$executeRawUnsafe(
    `UPDATE "ai_v2_feedback_reports" SET "status"='canceled', "updatedAt"=now(), "finishedAt"=now()
      WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3 AND "status"='running'`,
    reportId, organizationId, agentId,
  );
  return n > 0;
}

// ─── Fontes ─────────────────────────────────────────────────────────────

async function loadTurnRows(organizationId: string, agentId: string, since: Date): Promise<TurnLogRow[]> {
  // DEV não aplica migrations: garante a coluna "feedback".
  await ensureV2AgentSchema().catch(() => undefined);
  return db.$queryRawUnsafe<TurnLogRow[]>(
    `SELECT "id","conversationId","createdAt","inboundText","reply","handoff","error","prompt","contextSnapshot","llmOutput","discardedActions","feedback"
       FROM "ai_simple_turn_logs"
      WHERE "organizationId"=$1 AND "agentId"=$2 AND "createdAt" >= $3
      ORDER BY "createdAt" DESC LIMIT ${FEEDBACK_LIMITS.maxTurns}`,
    organizationId, agentId, since,
  );
}

async function loadReplayRows(organizationId: string, agentId: string, since: Date): Promise<ReplayItemFactsRow[]> {
  const exists = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT to_regclass('public.ai_simple_replay_items') IS NOT NULL AS ok`);
  if (!exists[0]?.ok) return [];
  await db.$executeRawUnsafe(`ALTER TABLE "ai_simple_replay_items" ADD COLUMN IF NOT EXISTS "facts" JSONB`).catch(() => undefined);
  const rows = await db.$queryRawUnsafe<Array<Omit<ReplayItemFactsRow, "outcome">>>(
    `SELECT i."id", i."conversationId", i."at", i."clientText", i."humanText", i."agentText", i."agentHandoff", i."sources", i."verdict", i."skipReason", i."error", i."history", i."facts"
       FROM "ai_simple_replay_items" i
       JOIN "ai_simple_replay_runs" r ON r."id" = i."runId"
      WHERE r."organizationId"=$1 AND r."agentId"=$2 AND r."status" IN ('done','canceled') AND r."createdAt" >= $3
      ORDER BY r."createdAt" DESC LIMIT ${FEEDBACK_LIMITS.maxReplayPoints}`,
    organizationId, agentId, since,
  );
  return rows.map((r) => ({ ...r, outcome: pointOutcome({ agentHandoff: r.agentHandoff, verdict: r.verdict as never }) }));
}

/** Conversas dos números de teste (lista atual) e nomes de contato para mascarar. */
async function conversationInfo(organizationId: string, conversationIds: string[], config: V2AgentConfig) {
  const test = new Set<string>();
  const names = new Map<string, string>();
  if (conversationIds.length === 0) return { test, names };
  const rows = await db.$queryRawUnsafe<Array<{ id: string; name: string | null; phone: string | null }>>(
    `SELECT c."id", ct."name", ct."phone" FROM "conversations" c LEFT JOIN "contacts" ct ON ct."id" = c."contactId"
      WHERE c."organizationId"=$1 AND c."id" = ANY($2::text[])`,
    organizationId, conversationIds,
  ).catch(() => [] as Array<{ id: string; name: string | null; phone: string | null }>);
  const allow = (config.allowedPhoneNumbers ?? []).map((p) => p.replace(/\D/g, "")).filter((p) => p.length >= 8);
  for (const r of rows) {
    if (r.name) names.set(r.id, r.name);
    const digits = (r.phone ?? "").replace(/\D/g, "");
    if (digits && allow.some((a) => digits.endsWith(a.slice(-8)))) test.add(r.id);
  }
  return { test, names };
}

// ─── Modelo ─────────────────────────────────────────────────────────────

const LABEL_CATEGORIES = [
  "material_faltando",
  "material_ruim",
  "instrucao_assunto",
  "regra_global",
  "tom",
  "reconhecimento_assunto",
  "transferencia_desnecessaria",
  "transferencia_faltando",
  "mensagem_pronta",
  "escopo",
  "midia",
  "integracao",
  "motor",
  "ok",
] as const;

const labelSchema = z.object({
  itens: z
    .array(
      z.object({
        id: z.string(),
        categoria: z.enum(LABEL_CATEGORIES).catch("ok"),
        necessidade: z.string().catch(""),
        evidencia: z.string().catch(""),
        materialTitulo: z.string().nullish().catch(null),
        confianca: z.enum(["alta", "media", "baixa"]).catch("baixa"),
        nota: z.string().nullish().catch(null),
      }),
    )
    .catch([]),
});

const LABEL_SYSTEM = `Você analisa turnos de um agente de atendimento por IA de uma empresa. O agente responde só com os materiais de consulta (trechos da base), as instruções do assunto, as regras globais, as mensagens prontas e os dados do cliente; quando não pode, transfere para uma pessoa.

Para cada turno, diga o que o cliente precisava e, se o agente não atendeu bem, a causa mais provável:
- material_faltando: nenhum trecho cobre o pedido.
- material_ruim: um trecho cobre o tema, mas está incompleto, ambíguo ou desatualizado (diga o título em materialTitulo).
- instrucao_assunto: o material era suficiente, mas faltou orientação no assunto (perguntar algo, seguir passos, quando transferir).
- regra_global: uma regra geral atrapalhou ou faltou.
- tom: forma de falar inadequada.
- reconhecimento_assunto: foi para o assunto errado ou nenhum.
- transferencia_desnecessaria: transferiu, mas o material ou a instrução permitiam responder.
- transferencia_faltando: respondeu sozinho algo que dependia de uma pessoa ou de dados de sistema.
- mensagem_pronta: faltou uma mensagem pronta para enviar (arquivo, imagem, texto padrão).
- escopo: pedido fora do que o atendimento cobre.
- midia / integracao / motor: depende de áudio/imagem, de sistema externo, ou falha técnica.
- ok: atendeu bem, ou não há evidência suficiente.

Regras:
- Use só os fatos fornecidos. Não suponha o que não está escrito.
- evidencia: cópia literal (até 200 caracteres) de um trecho do próprio turno que mostra o problema.
- necessidade: frase neutra de 3 a 10 palavras descrevendo o que o cliente precisava, sem nomes, números ou dados do cliente.
- Sem evidência suficiente: categoria "ok" e confianca "baixa".
Responda só JSON: {"itens":[{"id","categoria","necessidade","evidencia","materialTitulo","confianca":"alta|media|baixa","nota"}]}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function candidatePayload(c: Candidate, themeName: (id: string) => string | undefined, config: V2AgentConfig): string {
  const theme = c.themeId ? config.themes.find((t) => t.id === c.themeId) : null;
  const lines = [
    `### ${c.id}`,
    ...(c.previous.length ? [`Antes: ${c.previous.slice(-2).map((m) => `${m.role === "user" ? "Cliente" : "Agente"}: ${clip(m.content, 200)}`).join(" | ")}`] : []),
    `Cliente: ${clip(c.client, 400)}`,
    `Agente: ${clip(c.agent || "(sem resposta)", 500)}${c.handoff ? " [transferiu]" : ""}`,
    ...(c.human ? [`Pessoa da equipe respondeu: ${clip(c.human, 400)}`] : []),
    ...(c.reason ? [`Motivo do agente: ${clip(c.reason, 200)}`] : []),
    `Fatos: ${factPills(c, themeName).join(" · ") || "nenhum"}`,
    ...(theme ? [`Assunto ativo: ${theme.name} — palavras: ${theme.when.join(", ") || "(nenhuma)"} — instruções: ${clip(theme.instructions, 200)}`] : []),
    ...(c.sources.length
      ? [`Trechos lidos:\n${c.sources.slice(0, 3).map((s) => `- ${s.title}: ${clip(s.content, 400)}`).join("\n")}`]
      : ["Trechos lidos: nenhum"]),
    ...(c.replay?.explicacao ? [`Avaliação da comparação: ${clip(c.replay.explicacao, 300)}${c.replay.invencao ? ` · inventou: ${clip(c.replay.invencao, 150)}` : ""}`] : []),
    ...(c.feedback ? [`A equipe marcou como erro: ${clip(c.feedback.comment, 300)}`] : []),
  ];
  return lines.join("\n");
}

function parseJson(text: string): unknown {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

const recommendationSchema = z.object({
  titulo: z.string().catch(""),
  resumo: z.string().catch(""),
  textoSugerido: z.string().catch(""),
  perguntas: z.array(z.string()).catch([]),
  gatilhosSugeridos: z.array(z.string()).catch([]),
});

const RECOMMEND_SYSTEM = `Você escreve recomendações para quem configura um agente de atendimento por IA. Recebe um problema já classificado e as evidências (mensagens reais de clientes, respostas do agente e, quando houver, da equipe).

Devolva só JSON: {"titulo","resumo","textoSugerido","perguntas":[],"gatilhosSugeridos":[]}.
- titulo: até 70 caracteres, direto ("Falta material sobre …", "Assunto X transfere sem precisar").
- resumo: 1 ou 2 frases com o padrão observado e o impacto.
- textoSugerido: o que colar na configuração. Para material: um esboço com seções e as perguntas que ele deve responder. Para instrução ou regra: o texto da instrução. Nunca invente fatos (valores, prazos, datas, passos, nomes de telas): use só o que está nas respostas da equipe ou nos trechos; onde faltar, escreva [preencher: o que falta].
- perguntas: as dúvidas dos clientes que isso precisa responder, tiradas das mensagens (sem nomes ou dados pessoais).
- gatilhosSugeridos: só para reconhecimento de assunto — palavras ou frases curtas que os clientes usaram.
Genérico e objetivo; português do Brasil.`;

// ─── Execução ───────────────────────────────────────────────────────────

type Labeled = Candidate & {
  category: FeedbackCategory | "ok";
  need: string;
  confidence: number;
  materialTitle?: string | null;
  docId?: string;
  docTitle?: string;
  groupKey: string;
};

const CONFIDENCE = { alta: 1, media: 0.7, baixa: 0.4 } as const;

export async function estimateFeedback(args: { organizationId: string; agentId: string; params: FeedbackParams }) {
  const prep = await prepare(args);
  const llmCandidates = prep.candidates.filter((c) => !c.deterministic).length;
  const labelCalls = Math.ceil(llmCandidates / FEEDBACK_LIMITS.batch);
  const groupCalls = Math.min(FEEDBACK_LIMITS.maxGroupsWithModel, Math.ceil(prep.candidates.length / 4));
  const inTok = labelCalls * 3500 + groupCalls * 4000;
  const outTok = labelCalls * 900 + groupCalls * 800;
  return {
    turns: prep.facts.length,
    bySource: prep.bySource,
    candidates: prep.candidates.length,
    sampled: prep.sampled,
    calls: labelCalls + groupCalls,
    estimatedCostUsd: estimateCost(prep.config.model, inTok, outTok),
    model: prep.config.model,
  };
}

async function prepare(args: { organizationId: string; agentId: string; params: FeedbackParams }) {
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const since = new Date(Date.now() - args.params.days * 24 * 60 * 60 * 1000);
  const wantTurns = args.params.sources.includes("turn") || args.params.sources.includes("test_turn");
  const turnRows = wantTurns ? await loadTurnRows(args.organizationId, args.agentId, since) : [];
  const replayRows = args.params.sources.includes("replay_point") ? await loadReplayRows(args.organizationId, args.agentId, since) : [];
  const convIds = [...new Set([...turnRows.map((r) => r.conversationId), ...replayRows.map((r) => r.conversationId)])];
  const info = await conversationInfo(args.organizationId, convIds, config);
  const facts = [
    ...factsFromTurnLogs(turnRows, (id, source) => source === "test" || info.test.has(id)),
    ...factsFromReplayItems(replayRows),
  ].filter((f) => args.params.sources.includes(f.sourceType));
  const bySource: Partial<Record<FeedbackSourceType, number>> = {};
  for (const f of facts) bySource[f.sourceType] = (bySource[f.sourceType] ?? 0) + 1;
  let candidates = selectCandidates(facts, config);
  const sampled = candidates.length > FEEDBACK_LIMITS.maxCandidates;
  if (sampled) {
    // Mais graves primeiro; entre iguais, os mais recentes.
    candidates = [...candidates]
      .sort((a, b) => b.severity - a.severity || b.at.localeCompare(a.at))
      .slice(0, FEEDBACK_LIMITS.maxCandidates);
  }
  return { config, facts, bySource, candidates, sampled, names: info.names };
}

export async function startFeedbackReport(args: {
  organizationId: string;
  agentId: string;
  userId: string;
  params: FeedbackParams;
}): Promise<{ reportId: string }> {
  await ensureFeedbackSchema();
  const apiKey = await getAgentApiKey(args.agentId).catch(() => null);
  if (!apiKey) throw new Error("NO_OPENAI_KEY");
  const running = (await listFeedbackReports(args.organizationId, args.agentId)).find((r) => r.status === "running");
  if (running) throw new Error("Já existe um relatório sendo gerado para este agente.");

  const reportId = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_v2_feedback_reports" ("id","organizationId","agentId","status","params","createdById") VALUES ($1,$2,$3,'running',$4::jsonb,$5)`,
    reportId, args.organizationId, args.agentId, JSON.stringify(args.params), args.userId,
  );
  const ctx = {
    organizationId: args.organizationId,
    userId: args.userId,
    isSuperAdmin: false,
    actor: { type: "AI", label: "Feedback do agente", ref: args.agentId },
  } as Parameters<typeof runWithContext>[0];

  void Promise.resolve(
    runWithContext(ctx, async () => {
      const heartbeat = setInterval(() => {
        void db.$executeRawUnsafe(`UPDATE "ai_v2_feedback_reports" SET "updatedAt"=now() WHERE "id"=$1 AND "status"='running'`, reportId).catch(() => undefined);
      }, HEARTBEAT_MS);
      try {
        await executeFeedback({ ...args, reportId, apiKey });
      } finally {
        clearInterval(heartbeat);
      }
    }),
  ).catch(async (err) => {
    console.error("[ai-v2 feedback] falhou:", err);
    await db.$executeRawUnsafe(
      `UPDATE "ai_v2_feedback_reports" SET "status"='error', "error"=$2, "updatedAt"=now(), "finishedAt"=now() WHERE "id"=$1 AND "status"='running'`,
      reportId, err instanceof Error ? err.message : String(err),
    ).catch(() => undefined);
  });
  return { reportId };
}

async function reportStatus(reportId: string): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ status: string }>>(`SELECT "status" FROM "ai_v2_feedback_reports" WHERE "id"=$1`, reportId);
  return rows[0]?.status ?? null;
}

async function executeFeedback(args: {
  organizationId: string;
  agentId: string;
  params: FeedbackParams;
  reportId: string;
  apiKey: string;
}): Promise<void> {
  const prep = await prepare(args);
  const { config, candidates } = prep;
  const model = config.model;
  const themeName = (id: string) => config.themes.find((t) => t.id === id)?.name;
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  const addUsage = (i: number, o: number) => {
    tokensIn += i;
    tokensOut += o;
    cost += estimateCost(model, i, o);
  };

  const toLabel = candidates.filter((c) => !c.deterministic);
  const batches: Candidate[][] = [];
  for (let i = 0; i < toLabel.length; i += FEEDBACK_LIMITS.batch) batches.push(toLabel.slice(i, i + FEEDBACK_LIMITS.batch));
  // Etapas: rótulo em lotes + agrupamento/recomendação (1 passo).
  await db.$executeRawUnsafe(`UPDATE "ai_v2_feedback_reports" SET "total"=$2, "updatedAt"=now() WHERE "id"=$1`, args.reportId, batches.length + 1);

  // 1) Rótulo (modelo) só nos ambíguos.
  const labeled: Labeled[] = candidates
    .filter((c) => c.deterministic)
    .map((c) => ({ ...c, category: c.deterministic!.category, need: c.deterministic!.need, confidence: 1, groupKey: c.deterministic!.key }));
  for (const batch of batches) {
    if ((await reportStatus(args.reportId)) !== "running") return;
    const payloads = new Map(batch.map((c) => [c.id, candidatePayload(c, themeName, config)]));
    try {
      const res = await generateWithTools({
        model,
        apiKey: args.apiKey,
        system: LABEL_SYSTEM,
        messages: [{ role: "user", content: [...payloads.values()].join("\n\n") }] as any,
        tools: {},
        temperature: 0,
        maxOutputTokens: 900,
        maxSteps: 1,
      });
      addUsage(res.inputTokens, res.outputTokens);
      const parsed = labelSchema.safeParse(parseJson(res.text));
      const byId = new Map((parsed.success ? parsed.data.itens : []).map((i) => [i.id, i]));
      for (const c of batch) {
        const l = byId.get(c.id);
        if (!l || l.categoria === "ok" || !l.necessidade.trim()) continue;
        // Evidência tem de estar no próprio turno; senão a confiança cai.
        const quoted = l.evidencia.trim() && normalize(payloads.get(c.id) ?? "").includes(normalize(l.evidencia).slice(0, 120));
        const confidence = quoted ? CONFIDENCE[l.confianca] : CONFIDENCE.baixa;
        labeled.push({
          ...c,
          category: l.categoria,
          need: maskEvidenceText(l.necessidade.trim()).slice(0, 160),
          confidence,
          materialTitle: l.materialTitulo ?? null,
          groupKey: "",
        });
      }
    } catch (err) {
      console.warn("[ai-v2 feedback] rótulo falhou:", err instanceof Error ? err.message : err);
    }
    await db.$executeRawUnsafe(
      `UPDATE "ai_v2_feedback_reports" SET "done"="done"+1, "inputTokens"=$2, "outputTokens"=$3, "costUsd"=$4, "updatedAt"=now() WHERE "id"=$1`,
      args.reportId, tokensIn, tokensOut, cost,
    );
  }

  // 2) Busca refeita em TODOS os materiais do agente: separa falta ×
  //    não liberado × não achou × achou e errou.
  const materialish = new Set(["material_faltando", "material_ruim", "transferencia_desnecessaria"]);
  for (const l of labeled) {
    if (!materialish.has(l.category) || !l.need) continue;
    const hit = await retrieveAgentKnowledge(args.agentId, l.need, args.apiKey, 3).catch(() => null);
    const best = hit?.chunks[0];
    const theme = l.themeId ? config.themes.find((t) => t.id === l.themeId) ?? null : null;
    const allowed = new Set(knowledgeDocIdsFor(config, theme));
    const read = new Set([...(l.prefetch?.docIds ?? []), ...l.sources.map((s) => s.docId).filter(Boolean)] as string[]);
    if (!best) {
      if (l.category !== "transferencia_desnecessaria") l.category = "material_faltando";
      continue;
    }
    l.docId = best.docId;
    l.docTitle = best.docTitle;
    if (l.category === "transferencia_desnecessaria") continue;
    if (!allowed.has(best.docId)) l.category = "material_nao_liberado";
    else if (!read.has(best.docId) && !l.sources.some((s) => s.title === best.docTitle)) l.category = "busca_nao_achou";
    else l.category = "material_ruim";
  }

  // 3) Agrupamento: por material, por ação, por assunto e pelo sentido.
  for (const l of labeled) {
    if (l.groupKey) continue;
    if (l.docId && ["material_nao_liberado", "busca_nao_achou", "material_ruim"].includes(l.category)) l.groupKey = `${l.category}:${l.docId}`;
  }
  const semantic = labeled.filter((l) => !l.groupKey && l.category !== "ok");
  if (semantic.length > 0) {
    const byCat = new Map<string, Labeled[]>();
    for (const l of semantic) {
      const scoped = ["instrucao_assunto", "transferencia_desnecessaria", "transferencia_faltando", "tom"].includes(l.category);
      const k = scoped ? `${l.category}|${l.themeId ?? ""}` : l.category;
      byCat.set(k, [...(byCat.get(k) ?? []), l]);
    }
    for (const [k, list] of byCat) {
      let vectors: number[][];
      try {
        const emb = await embedTexts(list.map((l) => l.need), args.apiKey);
        vectors = emb.embeddings;
        addUsage(emb.inputTokens, 0);
      } catch {
        vectors = list.map((_, i) => [i]);
      }
      clusterByVectors(vectors, 0.8).forEach((idxs, gi) => idxs.forEach((i) => (list[i].groupKey = `${k}#${gi}`)));
    }
  }

  const groups = new Map<string, Labeled[]>();
  for (const l of labeled) {
    if (l.category === "ok" || !l.groupKey) continue;
    groups.set(l.groupKey, [...(groups.get(l.groupKey) ?? []), l]);
  }

  // 4) Prioridade e recomendação.
  const scored = [...groups.values()].map((list) => {
    const conversations = new Set(list.map((l) => l.conversationId)).size;
    const severity = Math.max(...list.map((l) => l.severity));
    const weight = [...new Map(list.map((l) => [l.conversationId, l.weight * l.confidence])).values()].reduce((a, b) => a + b, 0);
    const hasFeedback = list.some((l) => l.feedback);
    const minor = list.length < 2 && severity < 4 && !hasFeedback;
    return { list, conversations, severity, score: weight * severity, minor };
  });
  scored.sort((a, b) => Number(a.minor) - Number(b.minor) || b.score - a.score);

  const items: Array<Omit<FeedbackItem, "id" | "status" | "statusAt">> = [];
  let withModel = 0;
  for (const g of scored) {
    if ((await reportStatus(args.reportId)) !== "running") return;
    const first = g.list[0];
    const category = first.category as FeedbackCategory;
    const theme = first.themeId ? config.themes.find((t) => t.id === first.themeId) : undefined;
    const names = (id: string) => [prep.names.get(id) ?? ""].filter(Boolean);
    const evidences: FeedbackEvidence[] = g.list
      .slice()
      .sort((a, b) => b.severity - a.severity)
      .slice(0, 8)
      .map((l) => ({
        sourceType: l.sourceType,
        sourceId: l.sourceId,
        conversationId: l.conversationId,
        at: l.at,
        client: maskEvidenceText(clip(l.client, 300), names(l.conversationId)),
        agent: maskEvidenceText(clip(l.agent || (l.handoff ? "(transferiu)" : "(sem resposta)"), 300), names(l.conversationId)),
        ...(l.human ? { human: maskEvidenceText(clip(l.human, 300), names(l.conversationId)) } : {}),
        pills: factPills(l, themeName),
      }));
    const target = targetFor(category, first, theme?.name);
    let title = defaultTitle(category, first, theme?.name);
    let summary = "";
    let recommendation: FeedbackRecommendation | null = deterministicRecommendation(category, first);

    if (!g.minor && withModel < FEEDBACK_LIMITS.maxGroupsWithModel && !first.deterministic) {
      withModel++;
      try {
        const context = [
          `Categoria: ${category}`,
          ...(theme ? [`Assunto: ${theme.name} — palavras: ${theme.when.join(", ") || "(nenhuma)"} — instruções atuais: ${clip(theme.instructions, 600)}`] : []),
          ...(first.docTitle ? [`Material mais próximo: ${first.docTitle}`] : []),
          `Necessidades dos clientes:\n${[...new Set(g.list.map((l) => l.need))].slice(0, 12).map((n) => `- ${n}`).join("\n")}`,
          `Evidências:\n${evidences.slice(0, 6).map((e, i) => `[${i + 1}] Cliente: ${e.client}\nAgente: ${e.agent}${e.human ? `\nEquipe: ${e.human}` : ""}`).join("\n\n")}`,
          ...(g.list.some((l) => l.sources.length)
            ? [`Trechos que o agente leu:\n${g.list.flatMap((l) => l.sources).slice(0, 3).map((s) => `- ${s.title}: ${clip(s.content, 500)}`).join("\n")}`]
            : []),
        ].join("\n\n");
        const res = await generateWithTools({
          model,
          apiKey: args.apiKey,
          system: RECOMMEND_SYSTEM,
          messages: [{ role: "user", content: context }] as any,
          tools: {},
          temperature: 0,
          maxOutputTokens: 900,
          maxSteps: 1,
        });
        addUsage(res.inputTokens, res.outputTokens);
        const parsed = recommendationSchema.safeParse(parseJson(res.text));
        if (parsed.success) {
          const r = parsed.data;
          // O texto sugerido não pode trazer número ou termo que não está nas evidências.
          const support = [context];
          let text = r.textoSugerido;
          for (const bad of [...unsupportedFigures(text, support), ...unsupportedQuotedTerms(text, support)]) {
            text = text.split(bad).join("[preencher]");
          }
          title = r.titulo.trim() ? clip(r.titulo.trim(), 90) : title;
          summary = clip(r.resumo.trim(), 400);
          recommendation = {
            action: recommendation?.action ?? actionFor(category),
            text: maskEvidenceText(text.trim()),
            questions: r.perguntas.map((q) => maskEvidenceText(q)).slice(0, 10),
            triggers: category === "reconhecimento_assunto" ? r.gatilhosSugeridos.slice(0, 10) : [],
          };
        }
      } catch (err) {
        console.warn("[ai-v2 feedback] recomendação falhou:", err instanceof Error ? err.message : err);
      }
    }
    if (!summary) summary = summaryFor(category, g.conversations);

    items.push({
      category,
      severity: g.severity,
      score: Math.round(g.score * 100) / 100,
      minor: g.minor,
      title,
      summary,
      target,
      recommendation,
      conversations: g.conversations,
      evidenceCount: g.list.length,
      evidences,
    });
  }

  for (const it of items) {
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_v2_feedback_items" ("id","reportId","organizationId","agentId","category","severity","score","minor","title","summary","target","recommendation","conversations","evidenceCount","evidences")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb)`,
      randomUUID(), args.reportId, args.organizationId, args.agentId, it.category, it.severity, it.score, it.minor, it.title, it.summary,
      it.target ? JSON.stringify(it.target) : null, it.recommendation ? JSON.stringify(it.recommendation) : null,
      it.conversations, it.evidenceCount, JSON.stringify(it.evidences),
    );
  }

  const byCategory: Partial<Record<FeedbackCategory, number>> = {};
  for (const it of items) if (!it.minor) byCategory[it.category] = (byCategory[it.category] ?? 0) + 1;
  const stats: FeedbackStats = {
    turns: prep.facts.length,
    bySource: prep.bySource,
    candidates: candidates.length,
    sampled: prep.sampled,
    items: items.length,
    byCategory,
  };
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_feedback_reports" SET "status"='done', "stats"=$2::jsonb, "done"="total", "inputTokens"=$3, "outputTokens"=$4, "costUsd"=$5, "updatedAt"=now(), "finishedAt"=now()
      WHERE "id"=$1 AND "status"='running'`,
    args.reportId, JSON.stringify(stats), tokensIn, tokensOut, cost,
  );
}

// ─── Textos e destinos ──────────────────────────────────────────────────

function actionFor(category: FeedbackCategory): string {
  const map: Partial<Record<FeedbackCategory, string>> = {
    material_faltando: "create_doc",
    material_ruim: "edit_doc",
    busca_nao_achou: "edit_doc",
    material_nao_liberado: "release_material",
    instrucao_assunto: "edit_theme_instructions",
    reconhecimento_assunto: "add_theme_triggers",
    regra_global: "edit_global_rule",
    tom: "edit_tone",
    transferencia_desnecessaria: "edit_theme_instructions",
    transferencia_faltando: "edit_theme_instructions",
    acao_nao_liberada: "release_action",
    mensagem_pronta: "add_message_model",
    escopo: "adjust_scope",
  };
  return map[category] ?? "dev_request";
}

function targetFor(category: FeedbackCategory, l: Labeled, themeName?: string): FeedbackTarget {
  switch (category) {
    case "material_faltando":
    case "material_ruim":
    case "busca_nao_achou":
    case "material_nao_liberado":
      return { section: "sabe", tab: "materiais", ...(l.docId ? { docId: l.docId, docTitle: l.docTitle } : {}) };
    case "instrucao_assunto":
    case "reconhecimento_assunto":
    case "transferencia_desnecessaria":
    case "transferencia_faltando":
      return l.themeId ? { section: "cuida", tab: "assuntos", themeId: l.themeId, themeName } : { section: "cuida", tab: "assuntos" };
    case "acao_nao_liberada":
      return { section: "cuida", tab: "acoes" };
    case "mensagem_pronta":
      return { section: "sabe", tab: "prontas" };
    case "escopo":
      return { section: "cuida", tab: "escopo" };
    case "regra_global":
    case "tom":
      return { section: "quem" };
    default:
      return { section: "testes" };
  }
}

function defaultTitle(category: FeedbackCategory, l: Labeled, themeName?: string): string {
  const need = l.need ? `: ${l.need}` : "";
  switch (category) {
    case "material_faltando": return `Falta material${need}`;
    case "material_nao_liberado": return `Material não liberado${l.docTitle ? `: ${l.docTitle}` : ""}`;
    case "busca_nao_achou": return `A busca não encontra${l.docTitle ? ` "${l.docTitle}"` : ""}`;
    case "material_ruim": return `Material incompleto${l.docTitle ? `: ${l.docTitle}` : need}`;
    case "instrucao_assunto": return `Instrução a ajustar${themeName ? ` em ${themeName}` : ""}${need}`;
    case "reconhecimento_assunto": return `Assunto não reconhecido${need}`;
    case "transferencia_desnecessaria": return `Transfere sem precisar${themeName ? ` em ${themeName}` : ""}`;
    case "transferencia_faltando": return `Deveria transferir${themeName ? ` em ${themeName}` : ""}`;
    case "acao_nao_liberada": return `Ação pedida sem estar liberada`;
    case "mensagem_pronta": return `Mensagem pronta pedida e não liberada`;
    case "escopo": return `Pedidos fora do escopo${need}`;
    case "midia": return `Depende de áudio ou imagem${need}`;
    case "integracao": return `Depende de dados de outro sistema${need}`;
    case "tom": return `Tom a ajustar${need}`;
    case "regra_global": return `Regra geral a revisar${need}`;
    default: return `Falha técnica${need}`;
  }
}

function summaryFor(category: FeedbackCategory, conversations: number): string {
  const n = `${conversations} ${conversations === 1 ? "conversa" : "conversas"}`;
  switch (category) {
    case "material_nao_liberado": return `Existe material sobre isso, mas ele não está liberado para o agente ou para o assunto. ${n}.`;
    case "busca_nao_achou": return `O material existe e está liberado, mas a busca não o encontrou com as palavras dos clientes. ${n}.`;
    case "acao_nao_liberada": return `O agente tentou fazer uma ação que não está liberada em "O que ele pode fazer". ${n}.`;
    case "mensagem_pronta": return `O agente quis enviar uma mensagem pronta que não está liberada e transferiu. ${n}.`;
    case "motor": return `Turnos que falharam por erro técnico. ${n}.`;
    default: return n;
  }
}

function deterministicRecommendation(category: FeedbackCategory, l: Labeled): FeedbackRecommendation | null {
  if (category === "material_nao_liberado") {
    return { action: "release_material", text: `Libere "${l.docTitle ?? "o material"}" para o agente ou para o assunto em que os clientes perguntam isso.`, questions: [], triggers: [] };
  }
  if (category === "busca_nao_achou") {
    return { action: "edit_doc", text: `Use no título ou na primeira linha de "${l.docTitle ?? "o material"}" as palavras que os clientes usam${l.need ? ` (ex.: ${l.need})` : ""}. Se o material é longo, divida por tema.`, questions: [], triggers: [] };
  }
  if (category === "acao_nao_liberada") {
    const type = l.deterministic?.key.replace(/^acao:/, "") ?? "";
    return { action: "release_action", text: `Libere a ação "${type}" em "O que ele pode fazer" ou oriente nas instruções para não usá-la.`, questions: [], triggers: [] };
  }
  if (category === "mensagem_pronta") {
    return { action: "add_message_model", text: "Libere a mensagem pronta que o agente tentou enviar, ou a do assunto, em Mensagens prontas.", questions: [], triggers: [] };
  }
  return null;
}

export { FEEDBACK_CATEGORIES };

// ─── Rascunho de documento (sob demanda) ────────────────────────────────

const DRAFT_SYSTEM = `Você escreve o rascunho de um material de consulta para um agente de atendimento, a partir de perguntas reais de clientes e, quando houver, das respostas da equipe.
- Organize em seções curtas com títulos; responda cada pergunta numa seção.
- Nunca invente fatos (valores, prazos, datas, passos, nomes de telas, links). Use só o que está nas respostas da equipe. Onde faltar, escreva [preencher: o que falta].
- Linguagem simples, direta; português do Brasil. Devolva só o texto do material, sem comentários.`;

export async function draftFeedbackDocument(args: { organizationId: string; agentId: string; itemId: string }): Promise<{ text: string }> {
  await ensureFeedbackSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_feedback_items" WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3`,
    args.itemId, args.organizationId, args.agentId,
  );
  if (rows.length === 0) throw new Error("Item não encontrado.");
  const item = toItem(rows[0]);
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const apiKey = await getAgentApiKey(args.agentId).catch(() => null);
  if (!apiKey) throw new Error("NO_OPENAI_KEY");
  const input = [
    `Tema: ${item.title}`,
    ...(item.recommendation?.questions.length ? [`Perguntas dos clientes:\n${item.recommendation.questions.map((q) => `- ${q}`).join("\n")}`] : []),
    `Conversas:\n${item.evidences.map((e, i) => `[${i + 1}] Cliente: ${e.client}${e.human ? `\nEquipe: ${e.human}` : ""}`).join("\n\n")}`,
  ].join("\n\n");
  const res = await generateWithTools({
    model: config.model,
    apiKey,
    system: DRAFT_SYSTEM,
    messages: [{ role: "user", content: input }] as any,
    tools: {},
    temperature: 0,
    maxOutputTokens: 1200,
    maxSteps: 1,
  });
  let text = res.text.trim();
  for (const bad of [...unsupportedFigures(text, [input]), ...unsupportedQuotedTerms(text, [input])]) text = text.split(bad).join("[preencher]");
  return { text: maskEvidenceText(text) };
}
