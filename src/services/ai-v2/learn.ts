/**
 * "Aprender com conversas": encontra no banco atendimentos reais sobre um
 * assunto que deram certo e escreve rascunhos de material para a base do
 * agente, com as conversas de apoio.
 *
 * Etapas: termos do assunto (modelo) → conversas candidatas (SQL, mensagem
 * do cliente cita um termo e alguém respondeu) → análise de cada uma
 * (modelo: no assunto? deu certo, com o trecho do cliente que mostra isso?
 * que passos funcionaram?) → síntese dos materiais (modelo) → checagem de
 * números e termos contra os resumos → gravação.
 * Nenhum domínio de cliente: o assunto é do usuário e as conversas são dado.
 */

import { randomUUID } from "node:crypto";
import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import { estimateCost } from "@/lib/ai-agents/pricing";
import { generateWithTools } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { v2AuxModel } from "@/lib/ai-v2/models";
import { getV2Agent } from "./agents";
import { unsupportedFigures, unsupportedQuotedTerms } from "./ground-reply";
import { maskEvidenceText } from "./feedback-extract";
import {
  LEARN_LIMITS,
  buildTranscript,
  isSuccess,
  parseAnalysis,
  parseDocs,
  searchTerms,
  type LearnAnalysis,
  type LearnDocDraft,
  type LearnMessage,
  type LearnParams,
} from "./learn-extract";

const HEARTBEAT_MS = 30 * 1000;
const STALE_MS = 3 * 60 * 1000;

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

// ─── Armazenamento ──────────────────────────────────────────────────────

let schemaReady = false;
async function ensureLearnSchema(): Promise<void> {
  if (schemaReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_learn_runs" (
      "id" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "params" JSONB NOT NULL,
      "stats" JSONB,
      "result" JSONB,
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
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_learn_runs_agent_idx" ON "ai_v2_learn_runs" ("organizationId", "agentId", "createdAt")`);
  schemaReady = true;
}

export type LearnStats = { terms: number; candidates: number; analyzed: number; onTopic: number; success: number };

export type LearnConversation = {
  conversationId: string;
  number: number;
  at: string;
  tabulationName: string | null;
  onTopic: boolean;
  outcome: LearnAnalysis["outcome"];
  success: boolean;
  /** Número do atendimento nos materiais ("basedOn"); só nos que deram certo. */
  ref: number | null;
  confirmation: string | null;
  clientAsked: string;
};

export type LearnDoc = LearnDocDraft & { id: string; addedDocId: string | null };

export type LearnResult = { terms: string[]; conversations: LearnConversation[]; docs: LearnDoc[] };

export type LearnRun = {
  id: string;
  status: "running" | "done" | "error" | "canceled";
  params: LearnParams;
  stats: LearnStats | null;
  result: LearnResult | null;
  total: number;
  done: number;
  costUsd: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

function toRun(r: Record<string, any>, withResult: boolean): LearnRun {
  const stale = r.status === "running" && Date.now() - new Date(r.updatedAt).getTime() > STALE_MS;
  return {
    id: r.id,
    status: stale ? "error" : r.status,
    params: r.params,
    stats: r.stats ?? null,
    result: withResult ? r.result ?? null : null,
    total: r.total,
    done: r.done,
    costUsd: Number(r.costUsd ?? 0),
    error: stale ? "A busca parou no meio (o servidor reiniciou). Rode de novo." : r.error ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
  };
}

export async function listLearnRuns(organizationId: string, agentId: string): Promise<LearnRun[]> {
  await ensureLearnSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_learn_runs" WHERE "organizationId"=$1 AND "agentId"=$2 ORDER BY "createdAt" DESC LIMIT 20`,
    organizationId, agentId,
  );
  return rows.map((r) => toRun(r, false));
}

export async function getLearnRun(organizationId: string, agentId: string, runId: string): Promise<LearnRun | null> {
  await ensureLearnSchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_v2_learn_runs" WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3`,
    runId, organizationId, agentId,
  );
  return rows[0] ? toRun(rows[0], true) : null;
}

export async function cancelLearnRun(organizationId: string, agentId: string, runId: string): Promise<boolean> {
  await ensureLearnSchema();
  const n = await db.$executeRawUnsafe(
    `UPDATE "ai_v2_learn_runs" SET "status"='canceled', "updatedAt"=now(), "finishedAt"=now() WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3 AND "status"='running'`,
    runId, organizationId, agentId,
  );
  return n > 0;
}

/** Marca o rascunho como adicionado à base (id do material criado). */
export async function markLearnDocAdded(args: { organizationId: string; agentId: string; runId: string; docId: string; knowledgeDocId: string }): Promise<boolean> {
  const run = await getLearnRun(args.organizationId, args.agentId, args.runId);
  if (!run?.result) return false;
  const docs = run.result.docs.map((d) => (d.id === args.docId ? { ...d, addedDocId: args.knowledgeDocId } : d));
  if (!docs.some((d) => d.id === args.docId)) return false;
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_learn_runs" SET "result"=$2::jsonb, "updatedAt"=now() WHERE "id"=$1`,
    args.runId, JSON.stringify({ ...run.result, docs }),
  );
  return true;
}

/** Tabulações ativas da organização, para o filtro. */
export async function listLearnTabulations(organizationId: string): Promise<Array<{ id: string; name: string; parentName: string | null }>> {
  return db.$queryRawUnsafe(
    `SELECT t."id", t."name", p."name" AS "parentName"
       FROM "tabulations" t LEFT JOIN "tabulations" p ON p."id"=t."parentId"
      WHERE t."organizationId"=$1 AND t."active"=true
      ORDER BY p."name" NULLS FIRST, t."position", t."name"`,
    organizationId,
  );
}

// ─── Prompts ────────────────────────────────────────────────────────────

const TERMS_SYSTEM = [
  "Você recebe o nome de um assunto de atendimento ao cliente.",
  "Liste como clientes e atendentes costumam escrever sobre ele no WhatsApp: sinônimos, abreviações, grafias informais e frases curtas (1 a 4 palavras).",
  'Responda só JSON: {"terms": ["...", "..."]} com até 8 termos.',
].join("\n");

const WHO_LABEL: Record<LearnParams["who"], string> = {
  human: "Equipe",
  agent: "Agente IA",
  both: "Equipe ou Agente IA",
};

function analyzeSystem(topic: string, who: LearnParams["who"]): string {
  return [
    "Você analisa um atendimento de WhatsApp para saber se ele serve de exemplo de como resolver um assunto.",
    `Assunto: ${topic}`,
    `Conte como orientação só as mensagens de: ${WHO_LABEL[who]}.`,
    "Responda só JSON:",
    '{"onTopic": true|false, "outcome": "resolved"|"unresolved"|"unclear", "clientConfirmation": "..."|null, "clientAsked": "...", "steps": ["..."], "issues": ["..."], "requirements": ["..."]}',
    "- onTopic: o cliente pediu ajuda com esse assunto.",
    "- outcome: \"resolved\" só quando o cliente confirma que deu certo depois das orientações; transferência, silêncio ou encerramento sem confirmação é \"unclear\"; o cliente dizendo que não conseguiu e ficando sem solução é \"unresolved\".",
    "- clientConfirmation: trecho copiado literalmente de uma mensagem do Cliente que mostra que deu certo; null se não houver.",
    "- clientAsked: como o cliente descreveu o pedido, em uma frase.",
    "- steps: os passos das orientações que o cliente seguiu até resolver, na ordem, escritos como instrução genérica, sem nome, número ou dado do cliente.",
    "- issues: problemas que surgiram no caminho e o que resolveu (\"problema → solução\").",
    "- requirements: o que foi pedido ao cliente (dado, documento, acesso).",
    "Não invente: só o que está na conversa.",
  ].join("\n");
}

function synthSystem(topic: string): string {
  return [
    "Você escreve materiais para a base de conhecimento de um agente de atendimento, a partir de atendimentos reais que deram certo.",
    `Assunto: ${topic}`,
    "Você recebe, numerados, os resumos dos atendimentos: o que o cliente pediu, os passos que funcionaram, os problemas e o que foi pedido ao cliente.",
    `Escreva até ${LEARN_LIMITS.maxDocs} materiais, um por caminho diferente (situações que se resolvem de jeitos diferentes); se todos seguem o mesmo caminho, escreva um só.`,
    "Cada material em texto simples, com estas partes:",
    "Quando usar: como o cliente costuma pedir.",
    "Antes de começar: o que pedir ou conferir com o cliente (se houver).",
    "Passo a passo: numerado, na ordem que funcionou.",
    "Problemas comuns: problema → o que resolveu (se houver).",
    "Quando chamar a equipe: situações em que foi preciso uma pessoa (se houver).",
    "Regras: use só o que está nos resumos. Passo que aparece em um único atendimento termina com \"(confirmar)\". Nunca inclua nome, telefone, documento, e-mail ou protocolo de cliente. Não invente links, valores, prazos nem nomes de telas ou botões.",
    'Responda só JSON: {"docs": [{"title": "...", "content": "...", "basedOn": [números dos atendimentos usados]}]}',
  ].join("\n");
}

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

async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ─── Execução ───────────────────────────────────────────────────────────

export async function startLearnRun(args: {
  organizationId: string;
  agentId: string;
  userId: string;
  params: LearnParams;
}): Promise<{ runId: string }> {
  await ensureLearnSchema();
  const apiKey = await getAgentApiKey(args.agentId).catch(() => null);
  if (!apiKey) throw new Error("NO_OPENAI_KEY");
  const running = (await listLearnRuns(args.organizationId, args.agentId)).find((r) => r.status === "running");
  if (running) throw new Error("Já existe uma busca em andamento para este agente.");

  const runId = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_v2_learn_runs" ("id","organizationId","agentId","status","params","createdById") VALUES ($1,$2,$3,'running',$4::jsonb,$5)`,
    runId, args.organizationId, args.agentId, JSON.stringify(args.params), args.userId,
  );
  const ctx = {
    organizationId: args.organizationId,
    userId: args.userId,
    isSuperAdmin: false,
    actor: { type: "AI", label: "Aprender com conversas", ref: args.agentId },
  } as Parameters<typeof runWithContext>[0];

  void Promise.resolve(
    runWithContext(ctx, async () => {
      const heartbeat = setInterval(() => {
        void db.$executeRawUnsafe(`UPDATE "ai_v2_learn_runs" SET "updatedAt"=now() WHERE "id"=$1 AND "status"='running'`, runId).catch(() => undefined);
      }, HEARTBEAT_MS);
      try {
        await executeLearn({ ...args, runId, apiKey });
      } finally {
        clearInterval(heartbeat);
      }
    }),
  ).catch(async (err) => {
    console.error("[ai-v2 learn] falhou:", err);
    await db.$executeRawUnsafe(
      `UPDATE "ai_v2_learn_runs" SET "status"='error', "error"=$2, "updatedAt"=now(), "finishedAt"=now() WHERE "id"=$1 AND "status"='running'`,
      runId, err instanceof Error ? err.message : String(err),
    ).catch(() => undefined);
  });
  return { runId };
}

async function isCanceled(runId: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ status: string }>>(`SELECT "status" FROM "ai_v2_learn_runs" WHERE "id"=$1`, runId);
  return rows[0]?.status !== "running";
}

type CandidateRow = {
  id: string;
  number: number;
  at: Date;
  tabulationName: string | null;
  contactName: string | null;
  hits: number;
};

const WHO_SQL: Record<LearnParams["who"], string> = {
  human: `m."authorType"='human'`,
  agent: `m."authorType"='bot' AND m."aiAgentUserId" IS NOT NULL`,
  both: `(m."authorType"='human' OR (m."authorType"='bot' AND m."aiAgentUserId" IS NOT NULL))`,
};

async function findCandidates(organizationId: string, params: LearnParams, terms: string[], since: Date): Promise<CandidateRow[]> {
  const patterns = terms.map((t) => `%${t}%`);
  const tabs = params.tabulationIds.length > 0 ? params.tabulationIds : null;
  const rows = await db.$queryRawUnsafe<Array<CandidateRow & { hits: bigint | number }>>(
    `SELECT c."id", c."number", COALESCE(c."closedAt", c."updatedAt") AS "at",
            t."name" AS "tabulationName", ct."name" AS "contactName",
            COUNT(*) FILTER (WHERE m."direction"='in' AND m."content" ILIKE ANY($3::text[])) AS "hits"
       FROM "conversations" c
       JOIN "messages" m ON m."conversationId"=c."id" AND NOT m."isPrivate" AND m."messageType" <> 'note' AND m."createdAt" >= $2
       LEFT JOIN "tabulations" t ON t."id"=c."tabulationId"
       LEFT JOIN "contacts" ct ON ct."id"=c."contactId"
      WHERE c."organizationId"=$1
        AND COALESCE(c."closedAt", c."updatedAt") >= $2
        AND ($4::boolean = false OR c."status"='RESOLVED')
        AND ($5::text[] IS NULL OR c."tabulationId" = ANY($5::text[]))
      GROUP BY c."id", t."name", ct."name"
     HAVING COUNT(*) FILTER (WHERE m."direction"='in' AND m."content" ILIKE ANY($3::text[])) > 0
        AND COUNT(*) FILTER (WHERE m."direction"='out' AND ${WHO_SQL[params.who]}) > 0
      ORDER BY "hits" DESC, "at" DESC
      LIMIT ${LEARN_LIMITS.maxCandidates}`,
    organizationId, since, patterns, params.onlyResolved, tabs,
  );
  return rows.map((r) => ({ ...r, hits: Number(r.hits) }));
}

async function loadMessages(organizationId: string, conversationId: string, since: Date): Promise<LearnMessage[]> {
  return db.$queryRawUnsafe<LearnMessage[]>(
    `SELECT "direction", "authorType"::text AS "authorType", "content", "createdAt", ("aiAgentUserId" IS NOT NULL) AS "isAi"
       FROM "messages"
      WHERE "conversationId"=$1 AND "organizationId"=$2 AND NOT "isPrivate" AND "messageType" <> 'note' AND "createdAt" >= $3
      ORDER BY "createdAt" ASC
      LIMIT 400`,
    conversationId, organizationId, since,
  );
}

async function executeLearn(args: {
  organizationId: string;
  agentId: string;
  params: LearnParams;
  runId: string;
  apiKey: string;
}): Promise<void> {
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const model = v2AuxModel(config.model);
  const { params } = args;
  const since = new Date(Date.now() - params.days * 24 * 60 * 60 * 1000);
  let inTok = 0;
  let outTok = 0;
  const call = async (system: string, user: string, maxOutputTokens: number) => {
    const res = await generateWithTools({
      model,
      apiKey: args.apiKey,
      system,
      messages: [{ role: "user", content: user }] as never,
      temperature: 0,
      maxOutputTokens,
      maxSteps: 1,
    });
    inTok += res.inputTokens;
    outTok += res.outputTokens;
    return parseJson(res.text);
  };
  const progress = (patch: Record<string, unknown>) =>
    db.$executeRawUnsafe(
      `UPDATE "ai_v2_learn_runs" SET "stats"=$2::jsonb, "total"=$3, "done"=$4, "inputTokens"=$5, "outputTokens"=$6, "costUsd"=$7, "updatedAt"=now() WHERE "id"=$1 AND "status"='running'`,
      args.runId, JSON.stringify(patch.stats ?? null), patch.total ?? 0, patch.done ?? 0, inTok, outTok, estimateCost(model, inTok, outTok),
    );

  // 1. Termos
  let extra: string[] = [];
  try {
    const t = await call(TERMS_SYSTEM, params.topic, 200);
    extra = Array.isArray((t as { terms?: unknown })?.terms) ? ((t as { terms: unknown[] }).terms.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    /* segue só com o assunto */
  }
  const terms = searchTerms(params.topic, extra.slice(0, LEARN_LIMITS.maxTerms));
  if (terms.length === 0) throw new Error("Descreva o assunto com pelo menos uma palavra de 4 letras.");

  // 2. Candidatas
  const candidates = await findCandidates(args.organizationId, params, terms, since);
  const picked = candidates.slice(0, LEARN_LIMITS.maxAnalyzed);
  const stats: LearnStats = { terms: terms.length, candidates: candidates.length, analyzed: 0, onTopic: 0, success: 0 };
  await progress({ stats, total: picked.length, done: 0 });

  // 3. Análise
  const tabulationFiltered = params.tabulationIds.length > 0;
  const analyzed = await pool(picked, LEARN_LIMITS.concurrency, async (c) => {
    if (await isCanceled(args.runId)) return null;
    try {
      const messages = await loadMessages(args.organizationId, c.id, since);
      const tr = buildTranscript(messages, terms, c.contactName ? [c.contactName] : []);
      if (!tr.text) return null;
      const raw = await call(analyzeSystem(params.topic, params.who), tr.text, 900);
      const analysis = parseAnalysis(raw, tr.clientText);
      stats.analyzed += 1;
      if (analysis?.onTopic) stats.onTopic += 1;
      await progress({ stats, total: picked.length, done: stats.analyzed });
      return analysis ? { c, analysis } : null;
    } catch (err) {
      console.warn("[ai-v2 learn] análise falhou:", c.id, err instanceof Error ? err.message : err);
      return null;
    }
  });
  if (await isCanceled(args.runId)) return;

  const ok = analyzed.filter((x): x is NonNullable<typeof x> => !!x);
  const successes = ok.filter((x) => isSuccess(x.analysis, tabulationFiltered));
  stats.success = successes.length;

  // 4. Síntese
  let docs: LearnDoc[] = [];
  if (successes.length > 0) {
    const input = successes
      .map((s, i) =>
        [
          `[${i + 1}] Pedido: ${s.analysis.clientAsked || "(não descrito)"}`,
          `Passos que funcionaram:\n${s.analysis.steps.map((p, j) => `${j + 1}. ${p}`).join("\n")}`,
          s.analysis.issues.length ? `Problemas: ${s.analysis.issues.join("; ")}` : "",
          s.analysis.requirements.length ? `Pedido ao cliente: ${s.analysis.requirements.join("; ")}` : "",
        ].filter(Boolean).join("\n"),
      )
      .join("\n\n");
    const raw = await call(synthSystem(params.topic), input, 3000);
    docs = parseDocs(raw, successes.length).map((d) => {
      let content = d.content;
      for (const bad of [...unsupportedFigures(content, [input]), ...unsupportedQuotedTerms(content, [input])]) {
        content = content.split(bad).join("[confirmar]");
      }
      return { ...d, content: maskEvidenceText(content), id: randomUUID(), addedDocId: null };
    });
  }

  const refOf = new Map(successes.map((s, i) => [s.c.id, i + 1]));
  const conversations: LearnConversation[] = ok.map(({ c, analysis }) => ({
    conversationId: c.id,
    number: c.number,
    at: new Date(c.at).toISOString(),
    tabulationName: c.tabulationName,
    onTopic: analysis.onTopic,
    outcome: analysis.outcome,
    success: refOf.has(c.id),
    ref: refOf.get(c.id) ?? null,
    confirmation: analysis.clientConfirmation,
    clientAsked: analysis.clientAsked,
  }));
  const result: LearnResult = { terms, conversations, docs };
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_learn_runs" SET "status"='done', "stats"=$2::jsonb, "result"=$3::jsonb, "total"=$4, "done"=$4, "inputTokens"=$5, "outputTokens"=$6, "costUsd"=$7, "updatedAt"=now(), "finishedAt"=now() WHERE "id"=$1 AND "status"='running'`,
    args.runId, JSON.stringify(stats), JSON.stringify(result), picked.length, inTok, outTok, estimateCost(model, inTok, outTok),
  );
}
