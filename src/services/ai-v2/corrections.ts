/**
 * Correções em teste do agente v2 (`#corrigir` pelo WhatsApp).
 *
 * Quem testa aponta o erro de uma resposta; a correção fica ligada ao turno
 * corrigido e passa a valer SÓ nas conversas de teste do agente (números da
 * lista de teste): entra no prompt com prioridade e como fonte da
 * conferência. Nada é escrito na configuração publicada. Um modelo auxiliar
 * redige a mudança sugerida (regra ou trecho de material) para aplicar no
 * rascunho com um clique; publicar continua sendo decisão de quem configura.
 *
 * Vigência: pendente vale até ser descartada ou desfeita; aplicada no
 * rascunho segue valendo nos testes até sair uma versão publicada depois
 * (aí a versão publicada já deve trazer a mudança).
 * Nenhum domínio de cliente.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { validateV2Config } from "@/lib/ai-v2/config";
import { v2AuxModel } from "@/lib/ai-v2/models";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { normalizePhoneDigits, phoneMatchesAllowlist } from "@/services/ai/phone-allowlist";
import { getLogger } from "@/lib/logger";
import { sourcesFromToolCalls } from "./sources";

const log = getLogger("ai-v2.corrections");

export const CORRECTION_LIMITS = { textChars: 600, quoteChars: 300, maxActive: 20, suggestionChars: 1500 };

export type V2CorrectionStatus = "pending" | "applied" | "discarded" | "undone";

/** Mudança redigida pelo modelo auxiliar para o rascunho. */
export type V2CorrectionSuggestion = {
  tipo: "regra" | "material";
  /** Título do material (vazio em regra). */
  titulo: string;
  texto: string;
  motivo: string;
};

export type V2TestCorrection = {
  id: string;
  organizationId: string;
  agentId: string;
  conversationId: string;
  contactId: string | null;
  /** Turno corrigido (`ai_simple_turn_logs.id`). */
  logId: string | null;
  /** Sequencial por agente: é o "nº" que o testador vê. */
  number: number;
  question: string;
  reply: string;
  text: string;
  /** Última versão publicada quando a correção foi feita. */
  agentVersion: number | null;
  status: V2CorrectionStatus;
  suggestion: V2CorrectionSuggestion | null;
  suggestionError: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedById: string | null;
};

/** O que o turno de teste recebe de cada correção em vigor. */
export type V2TurnCorrection = { number: number; question: string; reply: string; text: string };

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

// ─── Armazenamento ──────────────────────────────────────────────────────

let schemaReady = false;
async function ensureCorrectionsSchema(): Promise<void> {
  if (schemaReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_v2_test_corrections" (
      "id" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "conversationId" TEXT NOT NULL,
      "contactId" TEXT,
      "logId" TEXT,
      "number" INTEGER NOT NULL,
      "question" TEXT NOT NULL DEFAULT '',
      "reply" TEXT NOT NULL DEFAULT '',
      "text" TEXT NOT NULL,
      "agentVersion" INTEGER,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "suggestion" JSONB,
      "suggestionError" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "decidedAt" TIMESTAMPTZ,
      "decidedById" TEXT
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ai_v2_test_corrections_agent_idx" ON "ai_v2_test_corrections" ("organizationId", "agentId", "status", "createdAt")`);
  schemaReady = true;
}

const STATUSES: readonly V2CorrectionStatus[] = ["pending", "applied", "discarded", "undone"];
/** Lista de situações como literal SQL: só valores da lista fechada entram no texto da consulta. */
function statusList(statuses: V2CorrectionStatus[]): string {
  const safe = statuses.filter((s) => STATUSES.includes(s));
  if (safe.length === 0) throw new Error("Situação de correção inválida.");
  return safe.map((s) => `'${s}'`).join(",");
}

type Row = Omit<V2TestCorrection, "createdAt" | "decidedAt"> & { createdAt: Date | string; decidedAt: Date | string | null };

const COLUMNS = `"id","organizationId","agentId","conversationId","contactId","logId","number","question","reply","text","agentVersion","status","suggestion","suggestionError","createdAt","decidedAt","decidedById"`;

function fromRow(r: Row): V2TestCorrection {
  return {
    ...r,
    number: Number(r.number),
    agentVersion: r.agentVersion === null || r.agentVersion === undefined ? null : Number(r.agentVersion),
    suggestion: (r.suggestion as V2CorrectionSuggestion | null) ?? null,
    createdAt: new Date(r.createdAt).toISOString(),
    decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null,
  };
}

export async function createTestCorrection(args: {
  organizationId: string;
  agentId: string;
  conversationId: string;
  contactId: string | null;
  logId: string | null;
  question: string;
  reply: string;
  text: string;
  agentVersion: number | null;
}): Promise<V2TestCorrection> {
  await ensureCorrectionsSchema();
  const rows = await db.$queryRawUnsafe<Row[]>(
    `INSERT INTO "ai_v2_test_corrections" ("id","organizationId","agentId","conversationId","contactId","logId","number","question","reply","text","agentVersion")
     VALUES ($1,$2,$3,$4,$5,$6,
       COALESCE((SELECT MAX("number") FROM "ai_v2_test_corrections" WHERE "organizationId" = $2 AND "agentId" = $3), 0) + 1,
       $7,$8,$9,$10)
     RETURNING ${COLUMNS}`,
    randomUUID(), args.organizationId, args.agentId, args.conversationId, args.contactId, args.logId,
    args.question.slice(0, 4000), args.reply.slice(0, 4000), args.text.slice(0, CORRECTION_LIMITS.textChars), args.agentVersion,
  );
  return fromRow(rows[0]);
}

export async function listTestCorrections(
  organizationId: string,
  agentId: string,
  statuses?: V2CorrectionStatus[],
): Promise<V2TestCorrection[]> {
  await ensureCorrectionsSchema();
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT ${COLUMNS} FROM "ai_v2_test_corrections"
      WHERE "organizationId" = $1 AND "agentId" = $2${statuses?.length ? ` AND "status" IN (${statusList(statuses)})` : ""}
      ORDER BY "createdAt" DESC LIMIT 100`,
    organizationId, agentId,
  );
  return rows.map(fromRow);
}

export async function getTestCorrection(organizationId: string, agentId: string, id: string): Promise<V2TestCorrection | null> {
  await ensureCorrectionsSchema();
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT ${COLUMNS} FROM "ai_v2_test_corrections" WHERE "id" = $1 AND "organizationId" = $2 AND "agentId" = $3`,
    id, organizationId, agentId,
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Troca a situação só se ainda está em uma das esperadas (duas pessoas decidindo ao mesmo tempo). */
export async function setTestCorrectionStatus(args: {
  organizationId: string;
  agentId: string;
  id: string;
  from: V2CorrectionStatus[];
  to: V2CorrectionStatus;
  userId: string | null;
}): Promise<boolean> {
  await ensureCorrectionsSchema();
  const changed = await db.$executeRawUnsafe(
    `UPDATE "ai_v2_test_corrections" SET "status" = $4, "decidedAt" = now(), "decidedById" = $5
      WHERE "id" = $1 AND "organizationId" = $2 AND "agentId" = $3 AND "status" IN (${statusList(args.from)})`,
    args.id, args.organizationId, args.agentId, args.to, args.userId,
  );
  return changed > 0;
}

async function lastPublishedAt(agentId: string): Promise<Date | null> {
  const rows = await db.$queryRawUnsafe<Array<{ at: Date | null }>>(
    `SELECT MAX("createdAt") AS at FROM "ai_agent_config_versions" WHERE "agentId" = $1`,
    agentId,
  );
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

export async function lastPublishedVersion(agentId: string): Promise<number | null> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number | null }>>(
    `SELECT MAX("versionNumber") AS n FROM "ai_agent_config_versions" WHERE "agentId" = $1`,
    agentId,
  );
  return rows[0]?.n === null || rows[0]?.n === undefined ? null : Number(rows[0].n);
}

/**
 * A correção ainda vale nos testes: pendente, ou aplicada no rascunho sem
 * versão publicada depois (a publicada ainda não traz a mudança).
 */
export function correctionInEffect(
  c: Pick<V2TestCorrection, "status" | "decidedAt">,
  publishedAt: Date | null,
): boolean {
  if (c.status === "pending") return true;
  if (c.status !== "applied") return false;
  if (!publishedAt || !c.decidedAt) return true;
  return new Date(c.decidedAt).getTime() > publishedAt.getTime();
}

export async function activeTestCorrections(organizationId: string, agentId: string): Promise<V2TestCorrection[]> {
  const rows = await listTestCorrections(organizationId, agentId, ["pending", "applied"]);
  if (rows.length === 0) return [];
  const publishedAt = rows.some((r) => r.status === "applied") ? await lastPublishedAt(agentId) : null;
  return rows.filter((r) => correctionInEffect(r, publishedAt)).slice(0, CORRECTION_LIMITS.maxActive);
}

export type V2TestCorrectionView = V2TestCorrection & {
  /** Ainda entra nos turnos de teste do agente. */
  inEffect: boolean;
  /** Quem mandou o `#corrigir`. */
  contactName: string | null;
};

/** Correções do agente para a tela de testes: as em vigor e as já decididas, mais recentes primeiro. */
export async function listTestCorrectionsView(organizationId: string, agentId: string): Promise<V2TestCorrectionView[]> {
  const rows = await listTestCorrections(organizationId, agentId);
  if (rows.length === 0) return [];
  const publishedAt = rows.some((r) => r.status === "applied") ? await lastPublishedAt(agentId) : null;
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((id): id is string => !!id))];
  const contacts = contactIds.length > 0
    ? await (prisma as unknown as {
        contact: { findMany: (a: unknown) => Promise<Array<{ id: string; name: string | null }>> };
      }).contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true } }).catch(() => [])
    : [];
  const names = new Map(contacts.map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    ...r,
    inEffect: correctionInEffect(r, publishedAt),
    contactName: r.contactId ? names.get(r.contactId) ?? null : null,
  }));
}

/**
 * A regra "somente em teste": o turno só recebe correções quando o agente
 * está em fase de teste (tem lista de números) E o telefone da conversa
 * está nela. Agente sem lista atende clientes reais e nunca recebe — o
 * banco nem é consultado.
 */
export async function correctionsForTestTurn(args: {
  organizationId: string;
  agentId: string;
  config: Pick<V2AgentConfig, "allowedPhoneNumbers">;
  phone: string | null;
}): Promise<V2TurnCorrection[]> {
  const allowed = (args.config.allowedPhoneNumbers ?? []).filter((p) => typeof p === "string" && p.trim());
  if (allowed.length === 0 || !args.phone) return [];
  const allow = new Set(allowed.map((p) => normalizePhoneDigits(p)).filter(Boolean));
  if (!phoneMatchesAllowlist(args.phone, allow)) return [];
  const active = await activeTestCorrections(args.organizationId, args.agentId);
  return active.map((c) => ({ number: c.number, question: c.question, reply: c.reply, text: c.text }));
}

// ─── Prompt e fontes ────────────────────────────────────────────────────

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Seção do prompt com as correções em vigor. Vazia sem correção. */
export function testCorrectionsPromptSection(items: V2TurnCorrection[] | undefined | null): string {
  if (!items || items.length === 0) return "";
  const lines = items.map((c) => {
    const parts = [
      c.question.trim() ? `Pergunta: "${clip(c.question, CORRECTION_LIMITS.quoteChars)}"` : "",
      c.reply.trim() ? `Resposta que estava errada: "${clip(c.reply, CORRECTION_LIMITS.quoteChars)}"` : "",
      `Correção: ${clip(c.text, CORRECTION_LIMITS.textChars)}`,
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  });
  return [
    "# Correções de quem testa (prioridade)",
    "A empresa apontou erros em respostas anteriores deste agente. O que cada correção afirma vale acima dos materiais e das instruções. Quando o pedido tiver relação com uma correção, responda conforme ela, com suas palavras. Não repita a resposta que estava errada, não cite a correção e não diga que foi corrigido.",
    ...lines,
  ].join("\n");
}

/** O que a correção afirma é fonte da conferência (a resposta errada não é). */
export function testCorrectionSources(items: V2TurnCorrection[] | undefined | null): string[] {
  return (items ?? []).map((c) => c.text.trim()).filter(Boolean);
}

// ─── Marca no turno corrigido ───────────────────────────────────────────

type LogFeedback = {
  comment: string;
  createdAt: string;
  byUserId: string | null;
  diagnosis: unknown;
  diagnosisError?: string;
  via?: "whatsapp";
  /** Comentário do "Marcar erro" da tela, quando o turno já tinha um. */
  baseComment?: string;
  corrections?: Array<{ id: string; number: number; text: string; at: string }>;
};

const logDb = () =>
  prisma as unknown as {
    aISimpleTurnLog: {
      findFirst: (args: unknown) => Promise<{ id: string; feedback: unknown } | null>;
      update: (args: unknown) => Promise<unknown>;
    };
  };

function feedbackComment(base: string | undefined, corrections: NonNullable<LogFeedback["corrections"]>): string {
  return [base?.trim() ?? "", ...corrections.map((c) => `#corrigir nº ${c.number}: ${c.text}`)].filter(Boolean).join("\n");
}

/**
 * Grava a correção no `feedback` do turno: é o que a tela de testes mostra
 * no turno e o que o relatório de Feedback lê como "a equipe marcou como
 * erro". Um "Marcar erro" anterior (comentário e diagnóstico) é mantido.
 */
export async function attachCorrectionToLog(logId: string, c: Pick<V2TestCorrection, "id" | "number" | "text">): Promise<void> {
  const row = await logDb().aISimpleTurnLog.findFirst({ where: { id: logId }, select: { id: true, feedback: true } });
  if (!row) return;
  const prev = (row.feedback ?? null) as LogFeedback | null;
  const base = prev ? (prev.corrections ? prev.baseComment : prev.comment) : undefined;
  const corrections = [...(prev?.corrections ?? []).filter((x) => x.id !== c.id), { id: c.id, number: c.number, text: c.text, at: new Date().toISOString() }];
  const feedback: LogFeedback = {
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    byUserId: prev?.byUserId ?? null,
    diagnosis: prev?.diagnosis ?? null,
    ...(prev?.diagnosisError ? { diagnosisError: prev.diagnosisError } : {}),
    ...(base?.trim() ? { baseComment: base } : { via: "whatsapp" as const }),
    corrections,
    comment: feedbackComment(base, corrections),
  };
  await logDb().aISimpleTurnLog.update({ where: { id: row.id }, data: { feedback }, select: { id: true } });
}

/** Tira a correção do turno (desfeita ou descartada). Sem mais nada marcado, o turno volta a ficar sem feedback. */
export async function detachCorrectionFromLog(logId: string, correctionId: string): Promise<void> {
  const row = await logDb().aISimpleTurnLog.findFirst({ where: { id: logId }, select: { id: true, feedback: true } });
  const prev = (row?.feedback ?? null) as LogFeedback | null;
  if (!row || !prev?.corrections?.some((x) => x.id === correctionId)) return;
  const corrections = prev.corrections.filter((x) => x.id !== correctionId);
  const base = prev.baseComment;
  const feedback: LogFeedback | null =
    corrections.length === 0 && !base?.trim()
      ? null
      : {
          createdAt: prev.createdAt,
          byUserId: prev.byUserId,
          diagnosis: prev.diagnosis ?? null,
          ...(prev.diagnosisError ? { diagnosisError: prev.diagnosisError } : {}),
          ...(base?.trim() ? { baseComment: base } : { via: "whatsapp" as const }),
          ...(corrections.length > 0 ? { corrections } : {}),
          comment: feedbackComment(base, corrections),
        };
  await logDb().aISimpleTurnLog.update({ where: { id: row.id }, data: { feedback }, select: { id: true } });
}

// ─── Sugestão para o rascunho (modelo auxiliar) ─────────────────────────

const suggestionSchema = z.object({
  tipo: z.enum(["regra", "material"]),
  titulo: z.string().optional().default(""),
  texto: z.string().min(1),
  motivo: z.string().optional().default(""),
});

export const CORRECTION_SUGGESTION_SYSTEM = [
  "Você ajuda quem configura um agente de atendimento por IA. Quem testa o agente apontou um erro numa resposta; redija a mudança que evita o erro. Responda em português do Brasil.",
  "Escolha UM tipo:",
  '- "material": a correção traz um fato que o agente precisa saber (valor, prazo, condição, como algo funciona). Escreva um trecho de material em pergunta e resposta: "Pergunta: …" na primeira linha e "Resposta: …" na seguinte. A pergunta é a dúvida do cliente em termos gerais; a resposta traz o fato certo.',
  '- "regra": a correção é sobre comportamento (o que fazer ou não fazer, ordem, tom, quando perguntar). Escreva uma instrução curta e direta, no imperativo, que valha para casos parecidos e não só para esta conversa.',
  "Use somente o que a correção afirma e o que está nos dados recebidos. Não invente valores, prazos, nomes nem condições. Se a correção não diz o certo, escreva a regra com o que ela permite concluir.",
  "Não copie dados pessoais do cliente da conversa (nome, telefone, documento).",
  "Responda APENAS um objeto JSON:",
  JSON.stringify({
    tipo: "regra | material",
    titulo: "título curto do material (vazio quando for regra)",
    texto: "o texto da regra, ou o trecho em pergunta e resposta",
    motivo: "por que esse tipo, em uma frase",
  }),
].join("\n");

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export function parseCorrectionSuggestion(text: string): V2CorrectionSuggestion | null {
  const parsed = suggestionSchema.safeParse(parseJsonObject(text));
  if (!parsed.success) return null;
  const texto = parsed.data.texto.trim().slice(0, CORRECTION_LIMITS.suggestionChars);
  if (!texto) return null;
  return {
    tipo: parsed.data.tipo,
    titulo: parsed.data.tipo === "material" ? parsed.data.titulo.trim().slice(0, 120) || "Correção de teste" : "",
    texto,
    motivo: parsed.data.motivo.trim().slice(0, 300),
  };
}

/** Redige (ou refaz) a sugestão da correção e grava nela. Falha fica registrada para a tela oferecer de novo. */
export async function draftCorrectionSuggestion(args: {
  organizationId: string;
  agentId: string;
  id: string;
}): Promise<V2TestCorrection | null> {
  const correction = await getTestCorrection(args.organizationId, args.agentId, args.id);
  if (!correction) return null;

  let suggestion: V2CorrectionSuggestion | null = null;
  let error: string | null = null;
  try {
    const { getV2Agent } = await import("./agents");
    const agent = await getV2Agent(args.agentId, args.organizationId);
    if (!agent) throw new Error("Agente não encontrado.");
    const config = agent.draftConfig ?? agent.publishedConfig;

    let read: Array<{ title: string; content: string }> = [];
    let themeName: string | null = null;
    if (correction.logId) {
      const row = await (prisma as unknown as {
        aISimpleTurnLog: { findFirst: (a: unknown) => Promise<{ contextSnapshot: unknown } | null> };
      }).aISimpleTurnLog.findFirst({ where: { id: correction.logId }, select: { contextSnapshot: true } });
      const snap = (row?.contextSnapshot ?? {}) as { toolCalls?: unknown; themeId?: unknown };
      read = sourcesFromToolCalls(snap.toolCalls)
        .slice(0, 4)
        .map((s) => ({ title: s.title, content: clip(s.content, 700) }));
      themeName = typeof snap.themeId === "string" ? config.themes.find((t) => t.id === snap.themeId)?.name ?? null : null;
    }

    const { generateWithTools } = await import("@/services/ai/provider");
    const { getAgentApiKey } = await import("@/services/ai/agent-key");
    const apiKey = await getAgentApiKey(args.agentId);
    const result = await generateWithTools({
      // Tarefa auxiliar: modelo na OpenAI com a chave do agente.
      model: v2AuxModel(agent.publishedConfig.model),
      apiKey,
      system: CORRECTION_SUGGESTION_SYSTEM,
      messages: [{
        role: "user",
        content: JSON.stringify({
          perguntaDoCliente: clip(correction.question, 800),
          respostaDoAgente: clip(correction.reply, 1200),
          correcaoDeQuemTestou: correction.text,
          assuntoDoTurno: themeName,
          trechosQueOAgenteLeu: read,
          regrasGeraisAtuais: config.globalRules.map((r) => clip(r, 300)).slice(0, 30),
        }),
      }] as never,
      temperature: 0.2,
      maxOutputTokens: 900,
      maxSteps: 1,
    });
    suggestion = parseCorrectionSuggestion(result.text ?? "");
    if (!suggestion) error = "A sugestão não veio no formato esperado.";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.warn({ err, correctionId: args.id }, "[ai-v2] sugestão da correção falhou");
  }

  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_test_corrections" SET "suggestion" = $2::jsonb, "suggestionError" = $3 WHERE "id" = $1 AND "organizationId" = $4`,
    args.id, suggestion ? JSON.stringify(suggestion) : null, error ? error.slice(0, 500) : null, args.organizationId,
  );
  return { ...correction, suggestion, suggestionError: error };
}

// ─── Decisão na tela ────────────────────────────────────────────────────

/**
 * Aplica a sugestão no RASCUNHO: regra entra nas regras gerais; material
 * vira um material novo liberado para todos os assuntos do rascunho. A
 * configuração publicada não muda. `override` é o texto editado na tela.
 */
export async function applyTestCorrection(args: {
  organizationId: string;
  agentId: string;
  id: string;
  userId: string | null;
  override?: { tipo?: unknown; titulo?: unknown; texto?: unknown };
}): Promise<{ correction: V2TestCorrection; knowledgeDocId: string | null }> {
  const correction = await getTestCorrection(args.organizationId, args.agentId, args.id);
  if (!correction) throw new Error("Correção não encontrada.");
  if (correction.status !== "pending") throw new Error("Esta correção já foi decidida.");

  const tipo = args.override?.tipo === "regra" || args.override?.tipo === "material" ? args.override.tipo : correction.suggestion?.tipo;
  const texto = (typeof args.override?.texto === "string" ? args.override.texto : correction.suggestion?.texto ?? "").trim();
  const titulo = (typeof args.override?.titulo === "string" ? args.override.titulo : correction.suggestion?.titulo ?? "").trim();
  if (!tipo || !texto) throw new Error("Sem sugestão para aplicar: gere a sugestão ou escreva o texto.");

  const { getV2Agent, saveV2AgentDraft } = await import("./agents");
  const { applyConfigChanges } = await import("./config-patch");
  const agent = await getV2Agent(args.agentId, args.organizationId);
  if (!agent) throw new Error("Agente não encontrado.");
  const base = agent.draftConfig ?? agent.publishedConfig;

  let knowledgeDocId: string | null = null;
  let next: V2AgentConfig;
  if (tipo === "regra") {
    next = applyConfigChanges(base, [{ path: "globalRules", op: "add", value: texto.slice(0, CORRECTION_LIMITS.suggestionChars) }]);
  } else {
    const { createKnowledgeDoc } = await import("@/services/ai/knowledge-docs");
    const doc = await createKnowledgeDoc(args.agentId, { title: titulo || `Correção de teste nº ${correction.number}`, content: texto });
    knowledgeDocId = (doc as { id: string }).id;
    next = applyConfigChanges(base, [{ path: "allowedKnowledgeDocIds", op: "add", value: knowledgeDocId }]);
  }
  const valid = validateV2Config(next);
  if (!valid.ok) throw new Error(`O rascunho ficaria inválido: ${valid.errors.issues[0]?.message ?? ""}`);
  await saveV2AgentDraft(args.agentId, args.organizationId, { config: valid.data });

  const changed = await setTestCorrectionStatus({ organizationId: args.organizationId, agentId: args.agentId, id: args.id, from: ["pending"], to: "applied", userId: args.userId });
  if (!changed) throw new Error("Esta correção já foi decidida.");
  await db.$executeRawUnsafe(
    `UPDATE "ai_v2_test_corrections" SET "suggestion" = $2::jsonb, "suggestionError" = NULL WHERE "id" = $1 AND "organizationId" = $3`,
    args.id, JSON.stringify({ tipo, titulo: tipo === "material" ? titulo : "", texto, motivo: correction.suggestion?.motivo ?? "" }), args.organizationId,
  );
  const updated = await getTestCorrection(args.organizationId, args.agentId, args.id);
  return { correction: updated ?? correction, knowledgeDocId };
}

/** Descarta (tela) ou desfaz (WhatsApp) uma correção pendente: deixa de valer nos testes e sai do turno. */
export async function dropTestCorrection(args: {
  organizationId: string;
  agentId: string;
  id: string;
  userId: string | null;
  to: "discarded" | "undone";
}): Promise<boolean> {
  const correction = await getTestCorrection(args.organizationId, args.agentId, args.id);
  if (!correction) return false;
  // Aplicada no rascunho também pode ser descartada pela tela: para de valer nos testes (o rascunho fica como está).
  const from: V2CorrectionStatus[] = args.to === "discarded" ? ["pending", "applied"] : ["pending"];
  const changed = await setTestCorrectionStatus({ organizationId: args.organizationId, agentId: args.agentId, id: args.id, from, to: args.to, userId: args.userId });
  if (changed && correction.logId && correction.status === "pending") {
    await detachCorrectionFromLog(correction.logId, correction.id).catch(() => undefined);
  }
  return changed;
}
