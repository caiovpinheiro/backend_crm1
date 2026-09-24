/**
 * "Comparar com humano": reproduz conversas reais atendidas por pessoas,
 * pede ao agente a resposta no mesmo ponto (simulação, nada é enviado) e um
 * avaliador compara as duas. Resultado por assunto: onde o agente já faz
 * igual e por que ainda não faz (material, comportamento, integração, mídia).
 * Nenhum domínio de cliente.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import { estimateCost } from "@/lib/ai-agents/pricing";
import { generateWithTools } from "@/services/ai/provider";
import { getAgentApiKey } from "@/services/ai/agent-key";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { getV2Agent } from "./agents";
import { simulateV2Turn } from "./test-turn";
import { sourcesFromToolCalls, type V2TurnSource } from "./sources";
import { extractReplayPoints, type ReplayMessageRow, type ReplayPoint } from "./replay-extract";
import { maskSensitive } from "./sensitive";
import { IMPORT_LIMITS, parseTranscript, transcriptToRows } from "./replay-import";
import { isMediaPlaceholderText } from "@/lib/ai-agents/media-placeholder";
import { understandMedia, understoodKindOf } from "./media-understanding";

export const REPLAY_LIMITS = { maxConversations: 100, maxPoints: 300, pointsPerConversation: 6, concurrency: 2 };
// A execução renova "updatedAt" a cada HEARTBEAT_MS. Sem renovação por
// STALE_MS, o processo morreu (reinício/deploy) e a execução é dada como parada.
const HEARTBEAT_MS = 30 * 1000;
const STALE_MS = 3 * 60 * 1000;
// Tempo máximo de um ponto (simulação + avaliação). Passou disso, o ponto
// fica com erro e a fila segue.
const POINT_TIMEOUT_MS = 150 * 1000;

// ─── Avaliador ──────────────────────────────────────────────────────────

export const replayVerdictSchema = z.object({
  desfecho: z.enum(["igual", "parcial", "diferente"]).catch("diferente"),
  correto: z.enum(["sim", "nao", "nao_verificavel"]).catch("nao_verificavel"),
  inventou: z.boolean().catch(false),
  invencao: z.string().optional().default(""),
  humanoConsultouSistema: z.boolean().catch(false),
  causa: z.enum(["ok", "material", "comportamento", "integracao", "midia"]).catch("comportamento"),
  tom: z.enum(["adequado", "inadequado"]).catch("adequado"),
  assunto: z.string().optional().default(""),
  explicacao: z.string().optional().default(""),
  comparavel: z.boolean().catch(true).default(true),
  motivoNaoComparavel: z.enum(["sem_conteudo", "fora_de_contexto", "teste", "outro"]).catch("outro").optional(),
});
export type ReplayVerdict = z.infer<typeof replayVerdictSchema>;

const EVALUATOR_SYSTEM = `Você avalia um agente de atendimento. Recebe um ponto de um atendimento real: o histórico, a mensagem do cliente, a resposta que uma pessoa da equipe deu e a resposta que o agente daria no mesmo ponto (com os trechos da base que ele leu).

Primeiro decida se o ponto é comparável:
- comparavel: false quando a resposta da pessoa não responde à mensagem do cliente. motivoNaoComparavel: "sem_conteudo" (só confirmação, saudação ou despedida), "fora_de_contexto" (a pessoa fala de outra coisa, retoma algo combinado fora da conversa ou responde a uma mensagem que não está aqui), "teste" (conversa de teste: texto sem sentido, "teste", a própria equipe testando), "outro".
- Se não for comparável, preencha só comparavel, motivoNaoComparavel, assunto e explicacao; o resto fica no padrão.

Critérios (ponto comparável):
- desfecho: "igual" se o agente leva o cliente ao mesmo resultado ou próximo passo que a pessoa; "parcial" se cobre só parte; "diferente" se leva a outro caminho ou não resolve.
- humanoConsultouSistema: true se a resposta da pessoa traz informação específica deste cliente que só viria de um sistema interno (situação de solicitação, datas/valores/notas dele, acesso/credencial, documento gerado para ele). Nesse caso o esperado do agente é transferir.
- inventou: true só se o agente afirma um fato verificável (número, prazo, data, valor, regra, link, nome de sistema/canal, etapa) que não está nos trechos nem no histórico. NÃO é invenção: cumprimentar ou chamar o cliente pelo nome (vem do cadastro), frases de cortesia, frases genéricas sem dado ("é só seguir estes passos"), perguntas, e qualquer informação presente nos trechos. Em "invencao", cite só o fato inventado.
- correto: "sim" se o que o agente diz bate com a pessoa e os trechos; "nao" se contradiz; "nao_verificavel" se não dá para saber.
- causa (a principal razão da diferença): "ok" se não há diferença relevante; "material" se faltou ou está errada a informação nos trechos; "comportamento" se tinha a informação mas respondeu mal (não perguntou o necessário, repetiu, fugiu do pedido, tom, não transferiu quando pediram); "integracao" se precisava consultar dados do cliente num sistema; "midia" se dependia de ver/ouvir mídia.
- tom: "inadequado" se ríspido, prolixo demais ou robótico para o contexto.
- assunto: rótulo curto do assunto do cliente (2 a 4 palavras).
- explicacao: 1 ou 2 frases, objetivas.

A pessoa é a referência do que a empresa faz, mas pode errar: se o agente estiver certo pelos trechos e a pessoa errada, diga isso na explicação.
Responda só com JSON: {"comparavel","motivoNaoComparavel","desfecho","correto","inventou","invencao","humanoConsultouSistema","causa","tom","assunto","explicacao"}.`;

export const NOT_COMPARABLE_LABEL: Record<NonNullable<ReplayVerdict["motivoNaoComparavel"]>, string> = {
  sem_conteudo: "Resposta da pessoa sem conteúdo (só confirmação ou saudação)",
  fora_de_contexto: "Resposta da pessoa não corresponde à mensagem do cliente",
  teste: "Conversa de teste",
  outro: "Avaliador considerou o ponto não comparável",
};

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function buildEvaluatorInput(args: {
  point: ReplayPoint;
  agentReply: string;
  agentHandoff: boolean;
  sources: V2TurnSource[];
}): string {
  const hist = args.point.history.slice(-6).map((h) => `${h.role === "user" ? "Cliente" : "Atendimento"}: ${clip(h.content, 400)}`).join("\n");
  const src = args.sources.slice(0, 5).map((s, i) => `[${i + 1}] ${s.title}: ${clip(s.content, 700)}`).join("\n");
  return [
    `Histórico recente:\n${hist || "(início da conversa)"}`,
    `Mensagem do cliente:\n${args.point.clientText}`,
    `Resposta da pessoa:\n${args.point.humanText}`,
    `Resposta do agente:\n${args.agentReply || "(sem texto)"}${args.agentHandoff ? "\n[o agente transferiu para uma pessoa]" : ""}`,
    `Trechos da base que o agente leu:\n${src || "(nenhum)"}`,
  ].join("\n\n");
}

export function parseVerdict(text: string): ReplayVerdict | null {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const r = replayVerdictSchema.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

async function evaluate(args: {
  model: string;
  apiKey: string;
  point: ReplayPoint;
  agentReply: string;
  agentHandoff: boolean;
  sources: V2TurnSource[];
}): Promise<{ verdict: ReplayVerdict | null; inputTokens: number; outputTokens: number }> {
  const res = await generateWithTools({
    model: args.model,
    apiKey: args.apiKey,
    system: EVALUATOR_SYSTEM,
    messages: [{ role: "user", content: buildEvaluatorInput(args) }] as any,
    tools: {},
    temperature: 0,
    maxOutputTokens: 500,
    maxSteps: 1,
  });
  return { verdict: parseVerdict(res.text), inputTokens: res.inputTokens, outputTokens: res.outputTokens };
}

// ─── Placar ─────────────────────────────────────────────────────────────

export type ReplayItemRow = {
  id: string;
  conversationId: string;
  pointIndex: number;
  at: string | null;
  clientText: string;
  humanText: string;
  agentText: string | null;
  agentHandoff: boolean;
  themeName: string | null;
  sources: V2TurnSource[];
  verdict: ReplayVerdict | null;
  skipReason: string | null;
  error: string | null;
  history?: ReplayPoint["history"];
};

type Metrics = {
  avaliados: number;
  igual: number;
  parcial: number;
  diferente: number;
  inventou: number;
  transferenciaCorreta: number;
  resolveuComoHumano: number;
  resultados: Partial<Record<ReplayOutcome, number>>;
};

export type ReplaySummary = {
  pontos: number;
  naoAvaliaveis: number;
  motivosNaoAvaliavel: Record<string, number>;
  erros: number;
  geral: Metrics;
  causas: Record<string, number>;
  porAssunto: Array<{ assunto: string } & Metrics>;
};

function emptyMetrics(): Metrics {
  return { avaliados: 0, igual: 0, parcial: 0, diferente: 0, inventou: 0, transferenciaCorreta: 0, resolveuComoHumano: 0, resultados: {} };
}

/** Transferiu quando a pessoa precisou do sistema, e só então. */
export function handoffWasRight(item: Pick<ReplayItemRow, "agentHandoff" | "verdict">): boolean {
  return item.agentHandoff === (item.verdict?.humanoConsultouSistema ?? false);
}

/** Acerto: mesmo desfecho (ou parcial) sem inventar, ou transferir quando a pessoa consultou o sistema. */
export function resolvedLikeHuman(item: Pick<ReplayItemRow, "agentHandoff" | "verdict">): boolean {
  const o = pointOutcome(item);
  return o !== null && REPLAY_HITS.has(o);
}

/**
 * Um único resultado por ponto (as categorias somam 100% dos avaliados).
 * A ordem das regras é a prioridade: invenção e erro pesam mais que o resto.
 */
export const REPLAY_OUTCOMES = [
  "igual",
  "parcial",
  "transferiu_certo",
  "inventou",
  "incorreto",
  "deveria_transferir",
  "transferiu_sem_precisar",
  "diferente",
] as const;
export type ReplayOutcome = (typeof REPLAY_OUTCOMES)[number];
export const REPLAY_HITS: ReadonlySet<ReplayOutcome> = new Set(["igual", "parcial", "transferiu_certo"]);

export function pointOutcome(item: Pick<ReplayItemRow, "agentHandoff" | "verdict">): ReplayOutcome | null {
  const v = item.verdict;
  if (!v) return null;
  if (v.inventou) return "inventou";
  if (v.humanoConsultouSistema) return item.agentHandoff ? "transferiu_certo" : "deveria_transferir";
  if (v.correto === "nao") return "incorreto";
  if (item.agentHandoff) return "transferiu_sem_precisar";
  return v.desfecho;
}

export function summarizeReplay(items: ReplayItemRow[]): ReplaySummary {
  const geral = emptyMetrics();
  const byTheme = new Map<string, Metrics>();
  const causas: Record<string, number> = {};
  const motivos: Record<string, number> = {};
  let naoAvaliaveis = 0;
  let erros = 0;
  for (const it of items) {
    if (it.skipReason) {
      naoAvaliaveis++;
      motivos[it.skipReason] = (motivos[it.skipReason] ?? 0) + 1;
      continue;
    }
    if (!it.verdict) {
      erros++;
      continue;
    }
    const assunto = it.themeName || it.verdict.assunto || "Sem assunto";
    const m = byTheme.get(assunto) ?? emptyMetrics();
    const outcome = pointOutcome(it)!;
    for (const target of [geral, m]) {
      target.resultados[outcome] = (target.resultados[outcome] ?? 0) + 1;
      target.avaliados++;
      target[it.verdict.desfecho]++;
      if (it.verdict.inventou) target.inventou++;
      if (handoffWasRight(it)) target.transferenciaCorreta++;
      if (REPLAY_HITS.has(outcome)) target.resolveuComoHumano++;
    }
    byTheme.set(assunto, m);
    causas[it.verdict.causa] = (causas[it.verdict.causa] ?? 0) + 1;
  }
  return {
    pontos: items.length,
    naoAvaliaveis,
    motivosNaoAvaliavel: motivos,
    erros,
    geral,
    causas,
    porAssunto: [...byTheme.entries()].map(([assunto, m]) => ({ assunto, ...m })).sort((a, b) => b.avaliados - a.avaliados),
  };
}

// ─── Armazenamento ──────────────────────────────────────────────────────

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

let schemaReady = false;
async function ensureReplaySchema(): Promise<void> {
  if (schemaReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_simple_replay_runs" (
      "id" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "params" JSONB NOT NULL,
      "total" INTEGER NOT NULL DEFAULT 0,
      "done" INTEGER NOT NULL DEFAULT 0,
      "summary" JSONB,
      "error" TEXT,
      "inputTokens" INTEGER NOT NULL DEFAULT 0,
      "outputTokens" INTEGER NOT NULL DEFAULT 0,
      "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "createdById" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "finishedAt" TIMESTAMPTZ
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_simple_replay_runs_agent_idx" ON "ai_simple_replay_runs" ("organizationId", "agentId", "createdAt")`);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_simple_replay_items" (
      "id" TEXT PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "organizationId" TEXT NOT NULL,
      "conversationId" TEXT NOT NULL,
      "pointIndex" INTEGER NOT NULL,
      "at" TIMESTAMPTZ,
      "clientText" TEXT NOT NULL,
      "humanText" TEXT NOT NULL,
      "agentText" TEXT,
      "agentHandoff" BOOLEAN NOT NULL DEFAULT false,
      "themeName" TEXT,
      "sources" JSONB,
      "verdict" JSONB,
      "skipReason" TEXT,
      "error" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.$executeRawUnsafe(`ALTER TABLE "ai_simple_replay_items" ADD COLUMN IF NOT EXISTS "history" JSONB`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_simple_replay_items_run_idx" ON "ai_simple_replay_items" ("runId")`);
  schemaReady = true;
}

export type ReplayRun = {
  id: string;
  agentId: string;
  status: "running" | "done" | "error" | "canceled";
  params: ReplayParams;
  total: number;
  done: number;
  summary: ReplaySummary | null;
  error: string | null;
  costUsd: number;
  createdAt: string;
  finishedAt: string | null;
};

export type ReplayParams = {
  days: number;
  conversations: number;
  config: "draft" | "published";
  /** "crm": conversas do período; "crm_ids": conversas escolhidas; "import": anexadas. */
  source?: "crm" | "crm_ids" | "import";
  /** Conversas escolhidas pelo link/id (source "crm_ids"). */
  conversationIds?: string[];
  /** Nomes das conversas anexadas (só para mostrar). */
  files?: string[];
};

/** Conversa anexada: texto da exportação/colado e quem é da equipe. */
export type ReplayTranscript = { name: string; text: string; teamAuthors: string[] };

function pointsFromTranscripts(transcripts: ReplayTranscript[]): Array<{ conversationId: string; contactId: string | null; point: ReplayPoint }> {
  const work: Array<{ conversationId: string; contactId: string | null; point: ReplayPoint }> = [];
  transcripts.slice(0, IMPORT_LIMITS.maxTranscripts).forEach((t, i) => {
    const rows = transcriptToRows(parseTranscript(t.text.slice(0, IMPORT_LIMITS.maxChars)), t.teamAuthors);
    const points = extractReplayPoints(rows, { maxPoints: IMPORT_LIMITS.pointsPerTranscript });
    const conversationId = `anexo ${i + 1}: ${t.name}`.slice(0, 120);
    for (const p of points) work.push({ conversationId, contactId: null, point: p });
  });
  return work.slice(0, REPLAY_LIMITS.maxPoints);
}

/** Estimativa exata para conversas anexadas (conta os pontos de verdade). */
export async function estimateImportedReplay(args: {
  organizationId: string;
  agentId: string;
  config: "draft" | "published";
  transcripts: ReplayTranscript[];
}) {
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (args.config === "published" ? agent.publishedConfig : agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const work = pointsFromTranscripts(args.transcripts);
  const evaluable = work.filter((w) => !w.point.skipReason).length;
  const cost = evaluable * (
    estimateCost(config.model, EST_TOKENS.agentIn, EST_TOKENS.agentOut) +
    estimateCost(config.model, EST_TOKENS.evalIn, EST_TOKENS.evalOut)
  );
  return {
    availableConversations: args.transcripts.length,
    conversations: args.transcripts.length,
    estimatedPoints: work.length,
    evaluablePoints: evaluable,
    estimatedCalls: evaluable * 2,
    estimatedCostUsd: Number(cost.toFixed(4)),
    model: config.model,
  };
}

function toRun(r: Record<string, any>): ReplayRun {
  const stale = r.status === "running" && Date.now() - new Date(r.updatedAt).getTime() > STALE_MS;
  return {
    id: r.id,
    agentId: r.agentId,
    status: stale ? "error" : r.status,
    params: r.params,
    total: r.total,
    done: r.done,
    summary: r.summary ?? null,
    error: stale ? "A execução parou no meio (o servidor reiniciou). Os pontos já comparados estão abaixo; rode de novo para o resto." : r.error ?? null,
    costUsd: Number(r.costUsd ?? 0),
    createdAt: new Date(r.createdAt).toISOString(),
    finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
  };
}

export async function listReplayRuns(organizationId: string, agentId: string): Promise<ReplayRun[]> {
  await ensureReplaySchema();
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_simple_replay_runs" WHERE "organizationId" = $1 AND "agentId" = $2 ORDER BY "createdAt" DESC LIMIT 20`,
    organizationId, agentId,
  );
  return rows.map(toRun);
}

export async function getReplayRun(organizationId: string, agentId: string, runId: string): Promise<{ run: ReplayRun; items: ReplayItemRow[]; summary: ReplaySummary } | null> {
  await ensureReplaySchema();
  const runs = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_simple_replay_runs" WHERE "id" = $1 AND "organizationId" = $2 AND "agentId" = $3`,
    runId, organizationId, agentId,
  );
  if (runs.length === 0) return null;
  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT * FROM "ai_simple_replay_items" WHERE "runId" = $1 AND "organizationId" = $2 ORDER BY "conversationId", "pointIndex"`,
    runId, organizationId,
  );
  const items: ReplayItemRow[] = rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    pointIndex: r.pointIndex,
    at: r.at ? new Date(r.at).toISOString() : null,
    clientText: r.clientText,
    humanText: r.humanText,
    agentText: r.agentText,
    agentHandoff: r.agentHandoff,
    themeName: r.themeName,
    sources: Array.isArray(r.sources) ? r.sources : [],
    verdict: r.verdict ?? null,
    skipReason: r.skipReason,
    error: r.error,
    history: Array.isArray(r.history) ? r.history : [],
  }));
  const run = toRun(runs[0]);
  return { run, items: items.map((i) => ({ ...i, outcome: i.skipReason ? null : pointOutcome(i) })), summary: summarizeReplay(items) };
}

/** Interrompe uma comparação em andamento; os pontos já feitos ficam. */
export async function cancelReplay(organizationId: string, agentId: string, runId: string): Promise<boolean> {
  await ensureReplaySchema();
  const n = await db.$executeRawUnsafe(
    `UPDATE "ai_simple_replay_runs" SET "status"='canceled', "updatedAt"=now(), "finishedAt"=now()
      WHERE "id"=$1 AND "organizationId"=$2 AND "agentId"=$3 AND "status"='running'`,
    runId, organizationId, agentId,
  );
  return n > 0;
}

async function runStatus(runId: string): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<Array<{ status: string }>>(`SELECT "status" FROM "ai_simple_replay_runs" WHERE "id"=$1`, runId);
  return rows[0]?.status ?? null;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ─── Seleção das conversas ──────────────────────────────────────────────

async function pickConversations(organizationId: string, days: number, n: number): Promise<{ available: number; picked: Array<{ id: string; contactId: string | null }> }> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.$queryRawUnsafe<Array<{ id: string; contactId: string | null }>>(
    `SELECT DISTINCT c."id", c."contactId"
       FROM "messages" m JOIN "conversations" c ON c."id" = m."conversationId"
      WHERE m."organizationId" = $1 AND c."organizationId" = $1
        AND m."authorType" = 'human' AND m."direction" = 'out' AND m."isPrivate" = false
        AND m."createdAt" >= $2
      LIMIT 2000`,
    organizationId, since,
  );
  // Amostra aleatória: não enviesar para as conversas mais antigas/novas.
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return { available: rows.length, picked: shuffled.slice(0, n) };
}

async function loadMessages(organizationId: string, conversationId: string, since: Date): Promise<ReplayMessageRow[]> {
  return db.$queryRawUnsafe<ReplayMessageRow[]>(
    `SELECT "id", "mediaUrl", "direction", "authorType"::text AS "authorType", "messageType"::text AS "messageType", "content", "createdAt"
       FROM "messages"
      WHERE "organizationId" = $1 AND "conversationId" = $2 AND "isPrivate" = false AND "createdAt" >= $3
      ORDER BY "createdAt" ASC
      LIMIT 400`,
    organizationId, conversationId, since,
  );
}

/** Quem pediu a comparação: o download de áudio confere o acesso dele. */
export type ReplayRequester = { userId: string; role: string | null; isSuperAdmin: boolean };

const AUDIO_PER_RUN = 60;

/**
 * Áudio e imagem sem texto viram conteúdo (mesmo módulo do atendimento, com
 * o mesmo cache): áudio transcrito, imagem lida pelo modelo do agente. Se
 * falhar, a mídia segue como mídia e o ponto fica fora da conta, como antes.
 */
async function transcribeAudios(
  rows: ReplayMessageRow[],
  organizationId: string,
  requester: ReplayRequester | undefined,
  budget: { left: number },
  model: { model: string; apiKey: string },
): Promise<void> {
  if (!requester) return;
  for (const row of rows) {
    if (budget.left <= 0) return;
    const kind = understoodKindOf(row.messageType);
    if (!kind || !row.mediaUrl || !row.id) continue;
    const text = (row.content ?? "").trim();
    if (kind === "audio" && text && !isMediaPlaceholderText(text)) continue;
    budget.left--;
    const r = await understandMedia({
      organizationId,
      userId: requester.userId,
      message: { id: row.id, messageType: row.messageType, mediaUrl: row.mediaUrl, content: row.content },
      kind,
      model: model.model,
      apiKey: model.apiKey,
    });
    if (r.text) row.content = kind === "image" && text && !isMediaPlaceholderText(text) ? `${text}\n${r.text}` : r.text;
    else console.warn("[ai-v2 replay] mídia não entendida:", r.error);
  }
}

/**
 * Referências de conversa: link da caixa de entrada (…/inbox?c=1234 usa o
 * número do atendimento; …?c=<id> o id), …/conversations/<id>, "#1234",
 * número ou id soltos.
 */
export function parseConversationRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const token of text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)) {
    const fromQuery = /[?&](?:c|conversation|conversationId)=([A-Za-z0-9_-]+)/.exec(token)?.[1];
    const fromPath = /\/conversations?\/([A-Za-z0-9_-]{8,})/.exec(token)?.[1];
    const number = /^#?(\d{1,9})$/.exec(token)?.[1];
    const bare = /^[A-Za-z0-9_-]{8,}$/.test(token) ? token : undefined;
    const ref = fromQuery ?? fromPath ?? number ?? bare;
    if (ref) refs.add(ref);
  }
  return [...refs].slice(0, REPLAY_LIMITS.maxConversations);
}

async function conversationsByIds(
  organizationId: string,
  refs: string[],
): Promise<Array<{ id: string; contactId: string | null; number: number }>> {
  if (refs.length === 0) return [];
  const numbers = refs.filter((r) => /^\d{1,9}$/.test(r)).map(Number);
  return db.$queryRawUnsafe<Array<{ id: string; contactId: string | null; number: number }>>(
    `SELECT "id", "contactId", "number" FROM "conversations"
      WHERE "organizationId" = $1 AND ("id" = ANY($2::text[]) OR "number" = ANY($3::int[]))`,
    organizationId, refs, numbers,
  );
}

/** Estimativa exata para conversas escolhidas (sem transcrever: áudio conta como fora). */
export async function estimateChosenReplay(args: {
  organizationId: string;
  agentId: string;
  config: "draft" | "published";
  conversationIds: string[];
}) {
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (args.config === "published" ? agent.publishedConfig : agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const found = await conversationsByIds(args.organizationId, args.conversationIds);
  let points = 0;
  let audioOnly = 0;
  for (const conv of found) {
    const rows = await loadMessages(args.organizationId, conv.id, new Date(0));
    const pts = extractReplayPoints(rows, { maxPoints: IMPORT_LIMITS.pointsPerTranscript });
    points += pts.length;
    audioOnly += pts.filter((p) => p.skipReason?.includes("mídia")).length;
  }
  const cost = points * (
    estimateCost(config.model, EST_TOKENS.agentIn, EST_TOKENS.agentOut) +
    estimateCost(config.model, EST_TOKENS.evalIn, EST_TOKENS.evalOut)
  );
  return {
    availableConversations: found.length,
    conversations: found.length,
    notFound: args.conversationIds.filter((ref) => !found.some((f) => f.id === ref || String(f.number) === ref)),
    estimatedPoints: points,
    audioPoints: audioOnly,
    transcription: !!process.env.GROQ_API_KEY?.trim(),
    estimatedCalls: points * 2,
    estimatedCostUsd: Number(cost.toFixed(4)),
    model: config.model,
  };
}

// Custo por ponto: simulação (prompt do agente + trechos) e avaliador.
const EST_TOKENS = { agentIn: 6000, agentOut: 400, evalIn: 2500, evalOut: 250 };

export async function estimateReplay(args: { organizationId: string; agentId: string; params: ReplayParams }) {
  await ensureReplaySchema();
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (args.params.config === "published" ? agent.publishedConfig : agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  const { available } = await pickConversations(args.organizationId, args.params.days, 0);
  const conversations = Math.min(args.params.conversations, available);
  const points = Math.min(conversations * 4, REPLAY_LIMITS.maxPoints);
  const cost = points * (
    estimateCost(config.model, EST_TOKENS.agentIn, EST_TOKENS.agentOut) +
    estimateCost(config.model, EST_TOKENS.evalIn, EST_TOKENS.evalOut)
  );
  return { availableConversations: available, conversations, estimatedPoints: points, estimatedCalls: points * 2, estimatedCostUsd: Number(cost.toFixed(4)), model: config.model };
}

// ─── Execução ───────────────────────────────────────────────────────────

export async function startReplay(args: {
  organizationId: string;
  agentId: string;
  userId: string;
  params: ReplayParams;
  transcripts?: ReplayTranscript[];
  requester?: ReplayRequester;
}): Promise<{ runId: string }> {
  await ensureReplaySchema();
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const config = (args.params.config === "published" ? agent.publishedConfig : agent.draftConfig ?? agent.publishedConfig) as V2AgentConfig;
  if (!config) throw new Error("O agente não tem configuração para testar.");
  const apiKey = await getAgentApiKey(args.agentId).catch(() => null);
  if (!apiKey) throw new Error("NO_OPENAI_KEY");

  const running = (await listReplayRuns(args.organizationId, args.agentId)).find((r) => r.status === "running");
  if (running) throw new Error("Já existe uma comparação em andamento para este agente.");

  const runId = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO "ai_simple_replay_runs" ("id","organizationId","agentId","status","params","createdById") VALUES ($1,$2,$3,'running',$4::jsonb,$5)`,
    runId, args.organizationId, args.agentId, JSON.stringify(args.params), args.userId,
  );

  const ctx = {
    organizationId: args.organizationId,
    userId: args.userId,
    isSuperAdmin: false,
    actor: { type: "AI", label: "Comparar com humano", ref: args.agentId },
  } as Parameters<typeof runWithContext>[0];

  // Roda em segundo plano: a requisição devolve o id e a tela acompanha.
  void Promise.resolve(
    runWithContext(ctx, () =>
      executeReplay({
        runId, organizationId: args.organizationId, agentId: args.agentId, config, apiKey,
        params: args.params, transcripts: args.transcripts, requester: args.requester,
      }),
    ),
  ).catch(async (err) => {
    console.error("[ai-v2 replay] falhou:", err);
    await db.$executeRawUnsafe(
      `UPDATE "ai_simple_replay_runs" SET "status"='error', "error"=$2, "updatedAt"=now(), "finishedAt"=now() WHERE "id"=$1 AND "status"='running'`,
      runId, err instanceof Error ? err.message : String(err),
    ).catch(() => undefined);
  });
  return { runId };
}

async function executeReplay(args: {
  runId: string;
  organizationId: string;
  agentId: string;
  config: V2AgentConfig;
  apiKey: string;
  params: ReplayParams;
  transcripts?: ReplayTranscript[];
  requester?: ReplayRequester;
}): Promise<void> {
  const heartbeat = setInterval(() => {
    void db.$executeRawUnsafe(`UPDATE "ai_simple_replay_runs" SET "updatedAt"=now() WHERE "id"=$1 AND "status"='running'`, args.runId).catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    await executeReplayPoints(args);
  } finally {
    clearInterval(heartbeat);
  }
}

async function pointsFromCrm(args: Parameters<typeof executeReplay>[0]) {
  const since = new Date(Date.now() - args.params.days * 24 * 60 * 60 * 1000);
  const n = Math.min(args.params.conversations, REPLAY_LIMITS.maxConversations);
  const { picked } = await pickConversations(args.organizationId, args.params.days, n);

  // Contexto anterior ao período ajuda o agente a entender a conversa.
  const historySince = new Date(since.getTime() - 2 * 24 * 60 * 60 * 1000);
  const work: Array<{ conversationId: string; contactId: string | null; point: ReplayPoint }> = [];
  const budget = { left: AUDIO_PER_RUN };
  for (const conv of picked) {
    if (work.length >= REPLAY_LIMITS.maxPoints) break;
    const rows = await loadMessages(args.organizationId, conv.id, historySince);
    await transcribeAudios(rows.filter((r) => r.createdAt >= since), args.organizationId, args.requester, budget, { model: args.config.model, apiKey: args.apiKey });
    const points = extractReplayPoints(rows, { maxPoints: REPLAY_LIMITS.pointsPerConversation })
      .filter((p) => new Date(p.at) >= since);
    for (const p of points) work.push({ conversationId: conv.id, contactId: conv.contactId, point: p });
  }
  return work.slice(0, REPLAY_LIMITS.maxPoints);
}

/** Conversas escolhidas: a conversa inteira, com os áudios transcritos. */
async function pointsFromChosen(args: Parameters<typeof executeReplay>[0]) {
  const found = await conversationsByIds(args.organizationId, args.params.conversationIds ?? []);
  const work: Array<{ conversationId: string; contactId: string | null; point: ReplayPoint }> = [];
  const budget = { left: AUDIO_PER_RUN };
  for (const conv of found) {
    if (work.length >= REPLAY_LIMITS.maxPoints) break;
    const rows = await loadMessages(args.organizationId, conv.id, new Date(0));
    await transcribeAudios(rows, args.organizationId, args.requester, budget, { model: args.config.model, apiKey: args.apiKey });
    for (const p of extractReplayPoints(rows, { maxPoints: IMPORT_LIMITS.pointsPerTranscript })) {
      work.push({ conversationId: conv.id, contactId: conv.contactId, point: p });
    }
  }
  return work.slice(0, REPLAY_LIMITS.maxPoints);
}

async function executeReplayPoints(args: Parameters<typeof executeReplay>[0]): Promise<void> {
  const queue =
    args.params.source === "import" ? pointsFromTranscripts(args.transcripts ?? [])
    : args.params.source === "crm_ids" ? await pointsFromChosen(args)
    : await pointsFromCrm(args);
  await db.$executeRawUnsafe(`UPDATE "ai_simple_replay_runs" SET "total"=$2, "updatedAt"=now() WHERE "id"=$1`, args.runId, queue.length);

  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let fatal: Error | null = null;

  const processOne = async (w: (typeof queue)[number]) => {
    const { point } = w;
    let agentText: string | null = null;
    let agentHandoff = false;
    let themeName: string | null = null;
    let sources: V2TurnSource[] = [];
    let verdict: ReplayVerdict | null = null;
    let error: string | null = null;
    let skipReason = point.skipReason;
    if (!skipReason) {
      try {
        const sim = await withTimeout(
          simulateV2Turn(
            args.agentId, args.config, point.clientText, point.history,
            args.organizationId, w.contactId ?? undefined, undefined, "active",
          ),
          POINT_TIMEOUT_MS,
          "O agente demorou demais para responder neste ponto.",
        );
        agentText = maskSensitive(sim.reply ?? "").text;
        agentHandoff = sim.handoff;
        themeName = sim.themeName;
        sources = sourcesFromToolCalls(sim.toolCalls);
        tokensIn += sim.inputTokens;
        tokensOut += sim.outputTokens;
        cost += estimateCost(args.config.model, sim.inputTokens, sim.outputTokens);
        const ev = await withTimeout(
          evaluate({ model: args.config.model, apiKey: args.apiKey, point, agentReply: agentText, agentHandoff, sources }),
          POINT_TIMEOUT_MS,
          "O avaliador demorou demais neste ponto.",
        );
        verdict = ev.verdict;
        tokensIn += ev.inputTokens;
        tokensOut += ev.outputTokens;
        cost += estimateCost(args.config.model, ev.inputTokens, ev.outputTokens);
        if (!verdict) error = "O avaliador não devolveu um resultado válido.";
        else if (!verdict.comparavel) skipReason = NOT_COMPARABLE_LABEL[verdict.motivoNaoComparavel ?? "outro"];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "NO_OPENAI_KEY") fatal = new Error("NO_OPENAI_KEY");
        error = msg;
      }
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_simple_replay_items" ("id","runId","organizationId","conversationId","pointIndex","at","clientText","humanText","agentText","agentHandoff","themeName","sources","verdict","skipReason","error","history")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16::jsonb)`,
      randomUUID(), args.runId, args.organizationId, w.conversationId, point.index, new Date(point.at),
      point.clientText, point.humanText, agentText, agentHandoff, themeName,
      JSON.stringify(sources), verdict ? JSON.stringify(verdict) : null, skipReason, error, JSON.stringify(point.history),
    );
    await db.$executeRawUnsafe(
      `UPDATE "ai_simple_replay_runs" SET "done"="done"+1, "inputTokens"=$2, "outputTokens"=$3, "costUsd"=$4, "updatedAt"=now() WHERE "id"=$1`,
      args.runId, tokensIn, tokensOut, cost,
    );
  };

  let next = 0;
  let canceled = false;
  const workers = Array.from({ length: REPLAY_LIMITS.concurrency }, async () => {
    while (next < queue.length && !fatal && !canceled) {
      // Reserva o ponto antes de qualquer await: o outro processamento
      // paralelo não pode pegar o mesmo nem passar do fim da fila.
      const w = queue[next++];
      if ((await runStatus(args.runId)) !== "running") {
        canceled = true;
        break;
      }
      await processOne(w);
    }
  });
  await Promise.all(workers);
  if (fatal) throw fatal;

  const full = await getReplayRun(args.organizationId, args.agentId, args.runId);
  const summary = full ? full.summary : null;
  await db.$executeRawUnsafe(
    `UPDATE "ai_simple_replay_runs" SET "status"='done', "summary"=$2::jsonb, "updatedAt"=now(), "finishedAt"=now() WHERE "id"=$1 AND "status"='running'`,
    args.runId, summary ? JSON.stringify(summary) : null,
  );
}
